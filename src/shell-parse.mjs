// shell-parse implements the static shell-command analysis behind the
// PreToolUse guard: a non-executing tokenizer, cd/pushd/directory-stack
// tracking, and classification of Git invocations (commits, staged paths,
// ref mutations, hook bypasses, read-only pipelines). Pure string/command
// analysis only: nothing here touches a repository, policy, or output.
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, posix, resolve } from 'node:path';

// Each nested payload (sh -c, rebase --exec, a command-valued variable) is
// parsed again. Real commands nest a few levels; past this many the line is
// refused rather than read, before deep nesting exhausts the stack.
const MAX_PARSE_DEPTH = 16;
let parseDepth = 0;

// parseGit inspects a shell command line for staged-path, commit, policy-transition,
// and branch/reference operations that need an agent-side guard decision.
export function parseGit(cmd, initialCwd = process.cwd(), { posix = true } = {}) {
    if (parseDepth >= MAX_PARSE_DEPTH) {
        return {
            commit: false,
            noVerify: false,
            bypassHooks: false,
            uncertainShell: true,
            opaqueCommitHiding: true,
            opaqueSink: true,
            classification: 'uncertain',
            environmentRisk: [],
            prefixRisk: true,
            prefixHooksRisk: true,
            unreadable: true,
            addPaths: [],
            commands: [unreadableCommand(initialCwd)],
        };
    }
    parseDepth += 1;
    try {
        return parseGitLine(cmd, initialCwd, posix);
    } finally {
        parseDepth -= 1;
    }
}

// A command the parser cannot read, refused wherever it appears.
function unreadableCommand(cwd) {
    return {
        verb: 'unknown',
        subcommand: '',
        args: [],
        cwd,
        environmentRisk: [],
        prefixRisk: true,
        policyTransitionRisk: true,
        targetUncertain: true,
        classification: 'unknown',
    };
}

// eval, source or . where a command starts runs text the parser never sees.
// A newline starts a command too, so the blanks after a separator never need
// to cross one; letting them do so made a run of blank lines quadratic.
const SOURCED_COMMAND = /(?:^|[\n;&|(])[^\S\n]*(?:eval|source|\.)\s/;

// name () { and function name {, the two ways a shell defines a function. A
// word before {, as in echo {} > f.json, is an ordinary command.
const SHELL_FUNCTION = /(?:^|[;&\n])[^\S\n]*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\))\s*\{/;

// A payload the parser cannot read in full: substitution, a subshell, brace
// group or function, control flow, an input redirect, a background job, a
// pipe into anything but a read-only command, or a sourced file. Output
// redirects are read like any other word, and a nested sh -c is judged by its
// own parse.
function payloadUnreadable(text) {
    return SOURCED_COMMAND.test(text) || hasUncertainShellSyntax(text, { payload: true });
}

// $'...' reads backslash escapes, so \' does not end it, while every scanner
// in this module ends a single quote at the next '. Rewriting each $'...' as
// a "..." with the same boundaries keeps a command after $'\'' in sight, and
// core.hooks$'\x50'ath reads as the core.hooksPath the shell passes on. One
// that keeps an escape this cannot spell becomes $"...", and the $ keeps the
// word dynamic, as it does for an unterminated $'.
// The printable character an ANSI-C escape at text[at] (after the backslash)
// spells, as in $'\x67it', or null. Whitespace and control characters keep
// their escape, so a decoded line never gains a separator.
function ansiCCode(text, at) {
    const forms = { x: [16, 2], u: [16, 4], U: [16, 8] };
    const [base, max, skip] = forms[text[at]] ? [...forms[text[at]], 1] : /[0-7]/.test(text[at]) ? [8, 3, 0] : [];
    if (!base) return null;
    const digits = text.slice(at + skip, at + skip + max).match(base === 16 ? /^[0-9a-fA-F]+/ : /^[0-7]+/)?.[0];
    if (!digits) return null;
    const code = parseInt(digits, base);
    return code > 0x20 && code < 0x7f ? { char: String.fromCharCode(code), length: skip + digits.length } : null;
}

export function normalizeAnsiCQuotes(command) {
    const text = String(command ?? '');
    if (!text.includes("$'")) return text;
    let out = '';
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            out += char;
            if (quote === '"' && char === '\\' && i + 1 < text.length) out += text[++i];
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '\\' && i + 1 < text.length) {
            out += char + text[++i];
            continue;
        }
        if (char === '$' && text[i + 1] === "'") {
            let body = '';
            let kept = false;
            let end = i + 2;
            for (; end < text.length && text[end] !== "'"; end += 1) {
                if (text[end] === '\\' && end + 1 < text.length) {
                    const escaped = text[++end];
                    const decoded = escaped === "'" || escaped === '\\' ? null : ansiCCode(text, end);
                    if (decoded) {
                        body += decoded.char;
                        end += decoded.length - 1;
                    } else if (escaped === "'" || escaped === '\\') {
                        body += escaped;
                    } else {
                        body += `\\${escaped}`;
                        kept = true;
                    }
                } else body += text[end];
            }
            if (end < text.length) {
                out += `${kept ? '$' : ''}"${body.replace(/[\\"$`]/g, '\\$&')}"`;
                i = end;
                continue;
            }
        }
        if (char === "'" || char === '"') quote = char;
        out += char;
    }
    return out;
}

// A # that starts a word begins a comment, which the shell ends at the newline,
// and whatever quotes it holds open nothing. The splitters in this module track
// quotes on their own, so "# don't hurry" ahead of a command made them read the
// next line as inside a quote and never see the command on it. The comment is
// cut here, with the shell's quote and escape rules, before anything reads the
// line. $#, ${#x}, a#b and "x"#y hold a # that is not a comment. Run after the
// $'...' strings are rewritten, which end at \' where a plain quote does not.
export function stripShellComments(text) {
    if (!text.includes('#')) return text;
    let out = '';
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            out += char;
            if (char === '\\' && quote === '"' && i + 1 < text.length) out += text[++i];
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '\\' && i + 1 < text.length) {
            out += char + text[++i];
            continue;
        }
        if (char === "'" || char === '"') quote = char;
        else if (char === '#' && (i === 0 || /[\s;&|()<>]/.test(text[i - 1]))) {
            while (i < text.length && text[i] !== '\n') i += 1;
            i -= 1;
            continue;
        }
        out += char;
    }
    return out;
}

// f() { ...; }; f runs the body with the arguments after the call, the way a
// credential helper written as a function runs. The body is read in its place.
// A brace in the body other than ${...}, or any argument after the call, leaves
// the text as it was. Scanned by hand: two optional blank runs in
// one regex backtrack quadratically on a long run of spaces.
const FUNCTION_HEAD = /^\s*(?:function[^\S\n]+([A-Za-z_][A-Za-z0-9_]*)(?:[^\S\n]*\(\))?|([A-Za-z_][A-Za-z0-9_]*)[^\S\n]*\([^\S\n]*\))[^\S\n]*\{/;

function calledFunctionBody(text) {
    const head = FUNCTION_HEAD.exec(text);
    if (!head) return text;
    let end = head[0].length;
    for (; end < text.length && text[end] !== '}'; end += 1) {
        if (text[end] === '{') return text;
        if (text[end] === '$' && text[end + 1] === '{') {
            const close = text.indexOf('}', end);
            if (close < 0 || text.slice(end + 2, close).includes('{')) return text;
            end = close;
        }
    }
    if (end >= text.length) return text;
    const call = /^\s*(?:;\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(end + 1));
    if (!call || call[1] !== (head[1] ?? head[2])) return text;
    // Arguments would reach the body as "$@", words this check never reads.
    const after = text.slice(end + 1 + call[0].length).trim();
    return after === '' || after === ';' ? text.slice(head[0].length, end) : text;
}

// The first setting in `git config --list -z` output whose command visibly
// runs Git to commit, move refs or skip the hooks, or null. Config already in
// files (an include, a hand edit) hands Git that command on a later call, even
// one that only reads, such as a pager under git log.
export function configuredGitRisk(listing, cwd) {
    for (const entry of String(listing).split('\0')) {
        const at = entry.indexOf('\n');
        if (at < 0) continue;
        const key = entry.slice(0, at);
        // A config hook runs before the managed hook of its event, and an
        // allowed ext transport runs its URL; neither shows the command.
        if (/^hook\..+\.command$/i.test(key)
            || (/^protocol\.(?:ext\.)?allow$/i.test(key) && !/^\s*never\s*$/i.test(entry.slice(at + 1)))) return key;
        for (const payload of configCommands(`${key}=${entry.slice(at + 1)}`)) {
            if (/\bhookspath\b/i.test(payload) || inOrder(payload, [/\bgit\b/, /--no-veri(?:fy?)?(?![\w-])/i])) return key;
            if (parseGit(payload, cwd).commands.some((candidate) => (
                !gitReadOnlyRefCommand(candidate.verb, candidate.args || [])
                && (EXPANDED_GIT_VERBS.has(candidate.verb) || candidate.bypassHooks || candidate.hooksPathOverride)
            ))) return key;
        }
    }
    return null;
}

function parseGitLine(command, initialCwd, posix = true) {
    const normalized = normalizeAnsiCQuotes(command);
    const cmd = calledFunctionBody(posix ? stripShellComments(normalized) : normalized);
    let commit = false;
    let noVerify = false;
    let bypassHooks = false;
    let uncertainShell = false;
    let sawAdd = false;
    const addPaths = [];
    const commands = [];
    if (!cmd) {
        return {
            commit,
            noVerify,
            bypassHooks,
            uncertainShell,
            classification: 'none',
            environmentRisk: [],
            prefixRisk: false,
            prefixHooksRisk: false,
            addPaths,
            commands,
        };
    }
    uncertainShell = hasUncertainShellSyntax(cmd);
    const substitutions = substitutionSpans(cmd, posix);
    // An output redirect cannot hide a commit, and a nested shell read in full
    // hides nothing. The line stays uncertain for the checks around a commit, but
    // only the rest of what makes it uncertain can make it opaque. A redirect
    // that lands on the hooks or the index is caught at the return below.
    const redirectOnly = uncertainShell && !hasUnquotedPipe(cmd) && !hasUncertainShellSyntax(cmd, { payload: true });
    let opaqueShell = uncertainShell && !redirectOnly;
    // What can run a command this parser never reads: a pipe into a program that
    // is not a text filter or tee, a script fed to one, a background job, eval. A
    // substitution it did read is not one, so a line that only holds git add
    // $(git ls-files -m), or pipes npm test into tail or tee, is not opaque; nor
    // is a group or a loop, whose commands are read one by one.
    let opaqueSink = opaqueShell && hasUncertainShellSyntax(blankGroups(maskSubstitutions(cmd, substitutions)), {
        payload: true,
        safePipes: PIPE_SINKS_THAT_ONLY_STORE,
        controlFlow: false,
        programFilters: true,
    });
    // Uncertain, and opaque to the checks that ask for any command at all, but
    // not a place for code to hide: a loop, a group or an env flag whose
    // commands are read like the rest.
    const markRead = () => {
        uncertainShell = true;
        opaqueShell = true;
    };
    const markUncertain = () => {
        markRead();
        opaqueSink = true;
    };
    let unreadable = payloadUnreadable(cmd);
    let setNames;
    let assignedHooks;
    // Whether a unit reads its own input as code (a bare sh, python -), for the
    // >( ) that holds one; and the text echo and printf units write to files.
    let stdinCode = false;
    const writtenFiles = new Map();
    let echoedBefore = null;
    // A command before Git can take the hooks away when its words name them,
    // when it runs inside .git (cd .git && rm -rf hooks), or when it expands a
    // word and the line assigns a value that names them (H=.git/hooks; rm -rf $H).
    const prefixTouchesHooks = (tokens, text, cwd) => commandMayTouchHooks(tokens, text)
        || (!FILE_READERS.has(shellExecutable(tokens[0])) && (insideGitDirectory(cwd)
            || (/[$`]/.test(text) && (assignedHooks ??= commandMayTouchHooks(
                shellWords(cmd).filter(isAssignment).map((word) => word.slice(word.indexOf('=') + 1)),
                '',
            )))));
    let shellCwd = initialCwd;
    const directoryStack = [];
    let subshellDepth = 0;
    let previousOperator = null;
    let shellTargetUncertain = false;
    let shellPathDialectUncertain = false;
    const definesShellFunction = SHELL_FUNCTION.test(cmd);
    const persistentEnvironmentRisk = new Set();
    let prefixRisk = false;
    let prefixIndexMutationRisk = false;
    let prefixHooksRisk = false;
    let policyTransitionRisk = false;
    // What Git runs for the line (an --exec, a command-valued config key or
    // environment variable) is read as a sh -c payload is. Git picks where it
    // runs, so a guarded Git command in it has no known target. Only what it
    // can do to Git counts against the rest of the line; a pager or a test
    // run does not, and neither does a read-only listing such as git branch.
    const mergeGitRun = (ran, cwd) => {
        for (const candidate of ran.commands) {
            if (!gitReadOnlyRefCommand(candidate.verb, candidate.args || [])) {
                commands.push({ ...candidate, targetUncertain: true });
            }
        }
        if (ran.unreadable) commands.push(unreadableCommand(cwd));
        prefixRisk ||= ran.prefixHooksRisk;
        prefixHooksRisk ||= ran.prefixHooksRisk;
    };
    // echo $(git push --no-verify) runs that push before echo starts. Only what
    // skips or repoints the hooks, loosens the policy or runs a script counts
    // against the rest of the line: a substitution that reads (git branch
    // --show-current) or runs Git with its hooks is no reason to refuse. One
    // that cannot be read to its end is unreadable.
    for (const { inner, kind } of substitutions) {
        if (inner === null) {
            if (posix) {
                markUncertain();
                commands.push(unreadableCommand(initialCwd));
            }
            continue;
        }
        const ran = parseGit(dropDataHeredocs(inner), initialCwd);
        mergeGitRun({ ...ran, unreadable: false, commands: ran.commands.filter(runsBeyondTheLine) }, initialCwd);
        // tee >(sh) writes text into a shell: the substitution that was read is
        // the program that runs it.
        if (kind === 'process' && ran.stdinCode) markUncertain();
    }
    for (const unit of shellUnits(cmd)) {
        const precedingOperator = previousOperator;
        previousOperator = unit.operator;
        const subshellState = shellSubshellState(unit.text);
        const unitInSubshell = subshellDepth > 0 || subshellState.opensSubshell;
        const directoryExecutionUncertain = unitInSubshell
            || uncertainShell
            || precedingOperator === '&&'
            || precedingOperator === '||';
        subshellDepth = Math.max(0, subshellDepth + subshellState.delta);
        const outer = unwrapShellControl(shellWords(unit.text.trim()));
        const control = unwrapShellControl(stripCommandGrouping(outer.tokens));
        const words = control.tokens;
        if (outer.uncertain || control.uncertain) markRead();
        if (updatePersistentEnvironment(words, persistentEnvironmentRisk)) {
            // An exported GIT_SSH_COMMAND runs under the Git commands after it.
            const exported = environmentCommands(words.filter(isAssignment));
            const text = exported.join('\n');
            if (exported.length) mergeGitRun(parseGit(text, shellCwd), shellCwd);
            continue;
        }
        // Stripping prefixes one word at a time is quadratic, and a real command
        // has a handful. Past the limit the line cannot be read in time.
        if (prefixChainTooLong(words)) {
            markUncertain();
            commands.push(unreadableCommand(shellCwd));
            continue;
        }
        let unwrapped = unwrapCommand(words, shellCwd);
        // time, timeout, nice and the like run the command after them with the
        // same argv, so that command is unwrapped again, env and all.
        for (let after = passthroughTarget(unwrapped.tokens); after; after = passthroughTarget(unwrapped.tokens)) {
            const otherUser = PASSTHROUGH_PREFIXES.get(shellExecutable(unwrapped.tokens[0])).otherUser === true;
            const inner = unwrapCommand(after, unwrapped.cwd);
            unwrapped = {
                ...inner,
                assignments: [...unwrapped.assignments, ...inner.assignments],
                uncertain: unwrapped.uncertain || inner.uncertain,
                pathDialectUncertain: unwrapped.pathDialectUncertain || inner.pathDialectUncertain,
                targetUncertain: unwrapped.targetUncertain || inner.targetUncertain || otherUser,
                explicitTargetOption: unwrapped.explicitTargetOption || inner.explicitTargetOption,
            };
        }
        const toks = dashedGitInvocation(unwrapped.tokens) ?? unwrapped.tokens;
        if (unwrapped.uncertain) markRead();
        if (mayChangeAimhoomanState(toks, unit.text, unwrapped.cwd)) {
            commands.push({ verb: 'aimhooman-state', cwd: unwrapped.cwd });
        }
        const admin = aimhoomanInvocation(toks);
        if (admin) commands.push({ verb: 'aimhooman', ...admin, cwd: unwrapped.cwd });
        let commandPathDialectUncertain = shellPathDialectUncertain
            || unwrapped.pathDialectUncertain;
        let commandTargetUncertain = shellTargetUncertain || unwrapped.targetUncertain;
        let commandExplicitTargetOption = unwrapped.explicitTargetOption;
        const nested = nestedShellPayload(toks);
        if (nested !== null) {
            const nestedStartupTargetUncertain = nestedShellStartupTargetUncertain(toks);
            const outerEnvironmentRisk = unique([
                ...persistentEnvironmentRisk,
                ...assignmentRiskNames(unwrapped.assignments),
            ]);
            const outerTargetEnvironmentRisk = hasCrossTargetEnvironmentRisk(
                outerEnvironmentRisk,
                'git',
            );
            const parsed = parseGit(nested, unwrapped.cwd);
            commit ||= parsed.commit;
            noVerify ||= parsed.noVerify;
            bypassHooks ||= parsed.bypassHooks || outerEnvironmentRisk.length > 0;
            uncertainShell = true;
            opaqueShell ||= parsed.opaqueCommitHiding || Boolean(parsed.unreadable);
            opaqueSink ||= parsed.opaqueSink || Boolean(parsed.unreadable);
            for (const path of parsed.addPaths) addPaths.push(path);
            for (const candidate of parsed.commands) commands.push({
                ...candidate,
                bypassHooks: candidate.bypassHooks || outerEnvironmentRisk.length > 0,
                environmentRisk: unique([
                    ...(candidate.environmentRisk || []),
                    ...outerEnvironmentRisk,
                ]),
                targetEnvironmentRisk: candidate.targetEnvironmentRisk
                    || outerTargetEnvironmentRisk,
                explicitTargetOption: commandExplicitTargetOption
                    || candidate.explicitTargetOption,
                targetUncertain: commandTargetUncertain
                    || nestedStartupTargetUncertain
                    || outerTargetEnvironmentRisk
                    || candidate.targetUncertain,
                pathDialectUncertain: commandPathDialectUncertain
                    || candidate.pathDialectUncertain,
            });
            sawAdd ||= parsed.addPaths.length > 0;
            unreadable ||= parsed.unreadable;
            // What the nested shell runs is a prefix to every command after it.
            prefixRisk ||= parsed.prefixRisk;
            prefixHooksRisk ||= parsed.prefixHooksRisk;
            if (!parsed.commit) {
                const positional = nestedShellArgumentCommitInvocation(toks, nested, unwrapped.cwd);
                if (positional) {
                    commit = true;
                    commands.push({
                        verb: 'commit',
                        cwd: positional.cwd,
                        noVerify: false,
                        bypassHooks: outerEnvironmentRisk.length > 0,
                        futureIndex: true,
                        classification: 'uncertain',
                        environmentRisk: outerEnvironmentRisk,
                        targetEnvironmentRisk: outerTargetEnvironmentRisk,
                        prefixRisk,
                        policyTransitionRisk,
                        explicitTargetOption: commandExplicitTargetOption,
                        targetUncertain: commandTargetUncertain
                            || nestedStartupTargetUncertain
                            || outerTargetEnvironmentRisk
                            || positional.targetUncertain,
                        pathDialectUncertain: commandPathDialectUncertain
                            || positional.pathDialectUncertain,
                    });
                }
            }
            continue;
        }
        const directoryTokens = directoryCommandTokens(toks);
        if (String(directoryTokens[0]).replace(/^[({]+/, '') === 'cd') {
            const args = directoryTokens.slice(1);
            const hasEndOfOptions = args[0] === '--';
            const positionals = hasEndOfOptions ? args.slice(1) : args;
            const path = positionals[0];
            const directoryEnvironmentRisk = assignmentRiskNames(unwrapped.assignments)
                .some((name) => name === 'CDPATH' || name === 'HOME');
            if (unitInSubshell || unwrapped.targetUncertain) {
                shellTargetUncertain = true;
                shellPathDialectUncertain ||= shellPathIsAmbiguous(path);
            } else if (positionals.length !== 1
                || (!hasEndOfOptions && path?.startsWith('-'))
                || path === '-'
                || shellPathHasExpansion(path)) {
                shellTargetUncertain = true;
            } else {
                shellCwd = resolveShellPath(shellCwd, path);
                shellTargetUncertain ||= directoryExecutionUncertain
                    || directoryEnvironmentRisk
                    || cdpathMayRedirect(path)
                    || (unit.operator !== '&&' && unit.operator !== null);
                shellPathDialectUncertain ||= shellPathIsAmbiguous(path);
            }
            continue;
        }
        if ((unitInSubshell || unwrapped.targetUncertain)
            && ['pushd', 'popd'].includes(shellExecutable(directoryTokens[0]))) {
            shellTargetUncertain = true;
            continue;
        }
        const stackChange = updateDirectoryStack(
            toks,
            shellCwd,
            directoryStack,
            unit.operator,
        );
        if (stackChange) {
            shellCwd = stackChange.cwd;
            const directoryEnvironmentRisk = assignmentRiskNames(unwrapped.assignments)
                .some((name) => name === 'CDPATH' || name === 'HOME');
            shellTargetUncertain ||= directoryExecutionUncertain
                || stackChange.uncertain
                || directoryEnvironmentRisk;
            shellPathDialectUncertain ||= stackChange.pathDialectUncertain;
            continue;
        }
        // printf -v NAME stores its output in NAME, a value this check never
        // sees. Git runs it when NAME holds a command or Git config. The
        // command still goes on below, where a redirect of it is read.
        const printfName = printfVariable(toks);
        if (printfName !== null) {
            // zsh runs a $(...) inside a subscript, so only a plain name is read.
            for (const risk of assignmentRiskNames([`${printfName}=<unseen>`])) persistentEnvironmentRisk.add(risk);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(printfName)
                || COMMAND_ENVIRONMENT.has(printfName)
                || gitConfigEnvName(printfName)) {
                commands.push(unreadableCommand(shellCwd));
            }
        }
        if (SHELL_CONTROL_DECLARATIONS.has(toks[0])) continue;
        // A shell or interpreter that takes its code from a file made by a process
        // substitution, bash <(...), or reads it from its own input, runs text this
        // parser cannot see.
        if (isCodeReader(shellExecutable(toks[0]))
            && toks.slice(1).some((word) => /^[<>]\(/.test(word))) markUncertain();
        if (readsStdinAsCode(toks)) stdinCode = true;
        // echo 'git push --no-verify' > r.sh writes a script that a later unit may
        // run: the file is not there yet for the guard to read, but its text is here.
        const written = writtenScript(toks, unit.text, unwrapped.cwd, precedingOperator === '|' ? echoedBefore : null);
        if (written) {
            for (const path of written.paths) writtenFiles.set(path, `${writtenFiles.get(path) ?? ''}\n${written.text}`);
        }
        echoedBefore = printedText(toks);
        const dynamicName = commandWordExpands(toks[0] ?? '');
        if (toks.length < 2 && !dynamicName) {
            // ./leak.sh or a bare make runs a file of its own.
            const script = toks.length ? executedScript(toks) : null;
            if (script) commands.push({ verb: 'script', ...script, inline: inlineScriptTexts(script, writtenFiles, unwrapped.cwd), cwd: unwrapped.cwd });
            if (toks.length && (!READ_ONLY_SHELL_COMMANDS.has(basename(toks[0])) || hasFileRedirect(unit.text))) {
                prefixIndexMutationRisk ||= commandMayReplaceIndex(toks, unit.text);
                prefixHooksRisk ||= prefixTouchesHooks(toks, unit.text, unwrapped.cwd);
                prefixRisk = true;
            }
            continue;
        }
        const g0 = toks[0];
        const environmentRisk = unique([
            ...persistentEnvironmentRisk,
            ...assignmentRiskNames(unwrapped.assignments),
        ]);
        const targetEnvironmentRisk = hasCrossTargetEnvironmentRisk(environmentRisk, g0);
        if (dynamicName || !isGitExecutable(g0)) {
            if (CURRENT_SHELL_MUTATORS.has(shellExecutable(g0))) markUncertain();
            const indirect = indirectCommitInvocation(toks, unwrapped.cwd)
                || interpretedCommitInvocation(toks, unwrapped.cwd)
                || (unwrapped.uncertain && possibleGitCommit(words)
                    ? indirectCommitDetails(words, unwrapped.cwd, true)
                    : null);
            if (indirect) {
                const indirectTargetEnvironmentRisk = hasCrossTargetEnvironmentRisk(
                    environmentRisk,
                    'git',
                );
                commit = true;
                markUncertain();
                commands.push({
                    verb: 'commit',
                    cwd: indirect.cwd,
                    noVerify: false,
                    bypassHooks: environmentRisk.length > 0,
                    futureIndex: true,
                    classification: 'uncertain',
                    environmentRisk,
                    targetEnvironmentRisk: targetEnvironmentRisk
                        || indirectTargetEnvironmentRisk,
                    prefixRisk,
                    policyTransitionRisk,
                    explicitTargetOption: commandExplicitTargetOption
                        || indirect.explicitTargetOption,
                    targetUncertain: commandTargetUncertain
                        || indirect.targetUncertain,
                    pathDialectUncertain: commandPathDialectUncertain
                        || indirect.pathDialectUncertain,
                });
            } else if (!dynamicName && !NON_EXECUTING_COMMANDS.has(shellExecutable(g0))
                && !REMOTE_COMMAND_DRIVERS.has(shellExecutable(g0))) {
                // Any program can run Git: a wrapper such as find -exec, xargs
                // or caffeinate runs the command from its first Git or shell
                // word, su -c and watch a command line, and an interpreter the
                // Git its code spells. That Git is read at a target the program
                // may change. Only a skipped hook counts: Git run with its hooks
                // is no reason to refuse, nor is a loop the wrapper's shell
                // runs, or grep -l "git push" under find.
                const rest = toks.slice(1);
                const wholeLine = ['parallel', 'watch'].includes(shellExecutable(g0));
                const texts = rest.filter((word, index) => /\s/.test(word)
                    && (wholeLine || rest[index - 1] === '-c' || rest[index - 1] === '--command'));
                const at = rest.findIndex((word) => isGitExecutable(word) || WRAPPED_SHELLS.has(shellExecutable(word)));
                if (at >= 0) texts.unshift(rest.slice(at).map(quoteShellWord).join(' '));
                const program = interpreterCode(toks);
                if (program && (SHELL_CODE_PROGRAMS.has(shellExecutable(g0)) || CODE_RUNS_COMMANDS.test(program.code))) {
                    texts.push(...embeddedGitTexts([program.code, ...program.rest].join(' ')));
                }
                const script = executedScript(toks);
                if (script) commands.push({ verb: 'script', ...script, inline: inlineScriptTexts(script, writtenFiles, unwrapped.cwd), cwd: unwrapped.cwd });
                for (const text of texts) {
                    const ran = parseGit(text, unwrapped.cwd);
                    mergeGitRun({
                        ...ran,
                        unreadable: false,
                        commands: ran.commands.filter(skipsGitHooks),
                    }, unwrapped.cwd);
                }
            } else if (dynamicName && expandedWordMayRunGit(toks, () => (setNames ??= namesSetIn(cmd)), unwrapped.cwd)) {
                // The expanded name can be Git with arguments this check
                // cannot read.
                markUncertain();
                commands.push(unreadableCommand(unwrapped.cwd));
            }
            // echo and printf only read, unless the line writes their output
            // to a file: `echo ... >> .git/config` repoints the hooks.
            if ((!READ_ONLY_SHELL_COMMANDS.has(basename(g0)) || hasFileRedirect(unit.text))
                && !PASSTHROUGH_PREFIX_EXECUTORS.has(shellExecutable(g0))) {
                prefixIndexMutationRisk ||= commandMayReplaceIndex(toks, unit.text);
                prefixHooksRisk ||= prefixTouchesHooks(toks, unit.text, unwrapped.cwd);
                prefixRisk = true;
                if (CURRENT_SHELL_MUTATORS.has(shellExecutable(g0)) || definesShellFunction) {
                    shellTargetUncertain = true;
                }
            }
            continue;
        }
        let i = 1;
        let cwd = unwrapped.cwd;
        let commandBypass = environmentRisk.length > 0;
        let commandHooksPathOverride = environmentRisk.some(gitConfigEnvName);
        let aliasResolutionRisk = !canResolveGitAlias(g0);
        let inlineAliasRisk = false;
        let unknownGlobalOption = false;
        let unseenConfig = null;
        const configRuns = [];
        while (i < toks.length && toks[i].startsWith('-')) {
            const option = toks[i];
            if (option === '-C' && toks[i + 1]) {
                commandExplicitTargetOption = true;
                commandTargetUncertain ||= shellPathHasExpansion(toks[i + 1]);
                commandPathDialectUncertain ||= shellPathIsAmbiguous(toks[i + 1]);
                cwd = resolveShellPath(cwd, toks[i + 1]);
                i += 2;
            } else if (option.startsWith('-C') && option.length > 2) {
                commandExplicitTargetOption = true;
                const target = option.slice(2);
                commandTargetUncertain ||= shellPathHasExpansion(target);
                commandPathDialectUncertain ||= shellPathIsAmbiguous(target);
                cwd = resolveShellPath(cwd, target);
                i += 1;
            } else if (option === '-c' && toks[i + 1]) {
                unseenConfig ||= unseenConfigKey(toks[i + 1]);
                if (hookAffectingConfig(toks[i + 1])) commandBypass = true;
                if (hooksPathOverrideConfig(toks[i + 1])) commandHooksPathOverride = true;
                if (aliasAffectingConfig(toks[i + 1])) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                configRuns.push(...configCommands(toks[i + 1]));
                i += 2;
            } else if (option.startsWith('-c') && option.length > 2) {
                unseenConfig ||= unseenConfigKey(option.slice(2));
                if (hookAffectingConfig(option.slice(2))) commandBypass = true;
                if (hooksPathOverrideConfig(option.slice(2))) commandHooksPathOverride = true;
                if (aliasAffectingConfig(option.slice(2))) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                configRuns.push(...configCommands(option.slice(2)));
                i += 1;
            } else if (option === '--config-env' && toks[i + 1]) {
                // A command-valued key read from the environment is a command
                // this check cannot see.
                unknownGlobalOption ||= commandConfigKey(toks[i + 1].split('=', 1)[0]);
                unseenConfig ||= unseenConfigKey(toks[i + 1]);
                if (hookAffectingConfig(toks[i + 1])) commandBypass = true;
                if (hooksPathOverrideConfig(toks[i + 1])) commandHooksPathOverride = true;
                if (aliasAffectingConfig(toks[i + 1])) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 2;
            } else if (option.startsWith('--config-env=')) {
                unknownGlobalOption ||= commandConfigKey(option.slice('--config-env='.length).split('=', 1)[0]);
                unseenConfig ||= unseenConfigKey(option.slice('--config-env='.length));
                if (hookAffectingConfig(option.slice('--config-env='.length))) commandBypass = true;
                if (hooksPathOverrideConfig(option.slice('--config-env='.length))) commandHooksPathOverride = true;
                if (aliasAffectingConfig(option.slice('--config-env='.length))) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 1;
            } else if (option === '--git-dir' && toks[i + 1]) {
                commandExplicitTargetOption = true;
                commandTargetUncertain ||= shellPathHasExpansion(toks[i + 1]);
                commandPathDialectUncertain ||= shellPathIsAmbiguous(toks[i + 1]);
                const gitDir = resolveShellPath(cwd, toks[i + 1]);
                cwd = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
                i += 2;
            } else if (option.startsWith('--git-dir=')) {
                commandExplicitTargetOption = true;
                const target = option.slice('--git-dir='.length);
                commandTargetUncertain ||= shellPathHasExpansion(target);
                commandPathDialectUncertain ||= shellPathIsAmbiguous(target);
                const gitDir = resolveShellPath(cwd, target);
                cwd = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
                i += 1;
            } else if (option === '--work-tree' && toks[i + 1]) {
                commandExplicitTargetOption = true;
                // --work-tree does not select Git's index, hooks, or policy
                // repository. This single-cwd model cannot safely represent a
                // split git-dir/worktree target, so guarded operations fail closed.
                commandTargetUncertain = true;
                commandPathDialectUncertain ||= shellPathIsAmbiguous(toks[i + 1]);
                i += 2;
            } else if (option.startsWith('--work-tree=')) {
                commandExplicitTargetOption = true;
                const target = option.slice('--work-tree='.length);
                commandTargetUncertain = true;
                commandPathDialectUncertain ||= shellPathIsAmbiguous(target);
                i += 1;
            } else if (GIT_GLOBAL_VALUE_OPTIONS.has(option)) {
                i += 2;
            } else {
                // An option this parser does not know may take a value, and
                // then the next word is not the subcommand git runs.
                unknownGlobalOption ||= !GIT_GLOBAL_OPTIONS.has(option.split('=', 1)[0]);
                i += 1;
            }
        }
        if (unseenConfig) {
            // Whatever the subcommand, even git ls-remote: Git runs it.
            commands.push({
                verb: 'unknown',
                subcommand: toks[i] ?? '',
                args: toks.slice(i + 1),
                cwd,
                bypassHooks: true,
                hooksPathOverride: true,
                runsConfigCommand: unseenConfig,
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                policyTransitionRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: true,
                pathDialectUncertain: commandPathDialectUncertain,
                classification: 'unknown',
            });
            prefixRisk = true;
            prefixHooksRisk = true;
            policyTransitionRisk = true;
            continue;
        }
        if (unknownGlobalOption) {
            commands.push({
                verb: 'unknown',
                subcommand: toks[i] ?? '',
                args: toks.slice(i + 1),
                cwd,
                bypassHooks: commandBypass,
                hooksPathOverride: commandHooksPathOverride,
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                policyTransitionRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: true,
                pathDialectUncertain: commandPathDialectUncertain,
                classification: 'unknown',
            });
            policyTransitionRisk = true;
            continue;
        }
        if (i >= toks.length) continue;
        const verb = toks[i];
        const verbArgs = toks.slice(i + 1);
        // A custom receive-pack can turn a seemingly remote push into a local
        // receive-pack invocation whose hook path is outside the command we
        // inspected. Treat that explicit indirection like a hook override.
        commandBypass ||= gitCommandMayBypassRefGuard(verb, verbArgs);
        // These commands can change the index before a later commit in the same
        // shell command. The current staged snapshot is therefore not the index
        // the commit will use, even when no literal `git add` appeared.
        if (gitIndexMutationRisk(verb, verbArgs)) sawAdd = true;
        // If what Git runs for this command touches the hooks, it does so
        // before Git's own remaining ref updates.
        const gitRun = [
            gitRunPayload(verb, verbArgs),
            ...configRuns,
            ...environmentCommands(unwrapped.assignments),
        ].filter((text) => text !== null);
        const ran = gitRun.length ? parseGit(gitRun.join('\n'), cwd) : null;
        if (ran?.prefixHooksRisk) {
            prefixRisk = true;
            prefixHooksRisk = true;
        }
        if (uncertainShell && /\$\(|`/.test(verb)) {
            commit = true;
            bypassHooks ||= commandBypass;
            commands.push({
                verb: 'commit',
                cwd,
                noVerify: false,
                bypassHooks: commandBypass,
                hooksPathOverride: commandHooksPathOverride,
                futureIndex: true,
                classification: 'uncertain',
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                policyTransitionRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: commandTargetUncertain,
                pathDialectUncertain: commandPathDialectUncertain,
            });
            policyTransitionRisk = true;
            continue;
        }
        if (verb === 'commit') {
            commit = true;
            const commitOptions = inspectCommitOptions(toks.slice(i + 1));
            const commandNoVerify = commitOptions.noVerify;
            noVerify ||= commandNoVerify;
            bypassHooks ||= commandBypass;
            const futureIndex = sawAdd || commitOptions.futureIndex || prefixIndexMutationRisk;
            commands.push({
                verb,
                cwd,
                noVerify: commandNoVerify,
                bypassHooks: commandBypass,
                hooksPathOverride: commandHooksPathOverride,
                futureIndex,
                editorRisk: commitOptions.editorRisk,
                classification: uncertainShell || commitOptions.uncertain
                    ? 'uncertain'
                    : commandNoVerify || commandBypass
                        ? 'bypass'
                        : futureIndex
                            ? 'future-index'
                            : 'direct',
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                indexMutationRisk: prefixIndexMutationRisk,
                policyTransitionRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: commandTargetUncertain,
                pathDialectUncertain: commandPathDialectUncertain,
            });
            policyTransitionRisk ||= raisesPolicyTransitionRisk(verb, verbArgs);
        }
        else if (verb === 'add') {
            const paths = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
            for (const path of paths) addPaths.push(path);
            commands.push({
                verb,
                cwd,
                addPaths: paths,
                environmentRisk,
                targetEnvironmentRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: commandTargetUncertain,
                pathDialectUncertain: commandPathDialectUncertain,
            });
            sawAdd = true;
        } else if (verb === 'config') {
            if (gitConfigMayMutate(toks.slice(i + 1))) {
                prefixRisk = true;
                prefixHooksRisk ||= commandMayTouchHooks(toks, unit.text);
            }
        } else if (verb === 'init') {
            // init copies the hook templates into the hooks directory, and
            // --separate-git-dir moves the directory itself, so the hooks read
            // here are not necessarily the ones the commit runs.
            prefixRisk = true;
            prefixHooksRisk = true;
        } else if (!SAFE_NON_COMMIT_GIT.has(verb)) {
            commands.push({
                verb: 'unknown',
                subcommand: verb,
                args: verbArgs,
                cwd,
                bypassHooks: commandBypass,
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                policyTransitionRisk,
                aliasResolutionRisk,
                inlineAliasRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: commandTargetUncertain,
                pathDialectUncertain: commandPathDialectUncertain,
                classification: 'unknown',
            });
            policyTransitionRisk ||= raisesPolicyTransitionRisk(verb, verbArgs);
        } else if (GIT_POLICY_TRANSITION_COMMANDS.has(verb)
            || GIT_REF_MUTATION_COMMANDS.has(verb)) {
            const skip = hookSkipOptions(verb, verbArgs);
            commands.push({
                verb,
                args: verbArgs,
                cwd,
                noVerify: skip.noVerify,
                bypassHooks: commandBypass,
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                policyTransitionRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: commandTargetUncertain,
                pathDialectUncertain: commandPathDialectUncertain,
                expansionMaySkipHooks: skip.expanded,
                classification: skip.uncertain ? 'uncertain' : 'mutation',
            });
            policyTransitionRisk ||= raisesPolicyTransitionRisk(verb, verbArgs);
        }
        // git submodule foreach git pull runs with each submodule's own hooks.
        if (ran) {
            mergeGitRun(verb === 'submodule'
                ? { ...ran, commands: ran.commands.filter((candidate) => candidate.verb === 'commit' || skipsGitHooks(candidate)) }
                : ran, cwd);
        }
    }
    const indirectCommits = [
        ...pipedShellCommitInvocations(cmd, initialCwd),
        ...dynamicLiteralCommitInvocations(cmd, initialCwd),
    ];
    for (const indirect of indirectCommits) {
        const indirectBypass = Boolean(
            indirect.bypassHooks || indirect.environmentRisk?.length,
        );
        commit = true;
        markUncertain();
        bypassHooks ||= indirectBypass;
        commands.push({
            verb: 'commit',
            cwd: indirect.cwd,
            noVerify: false,
            bypassHooks: indirectBypass,
            futureIndex: true,
            classification: 'uncertain',
            environmentRisk: indirect.environmentRisk || [],
            targetEnvironmentRisk: indirect.targetEnvironmentRisk || false,
            prefixRisk,
            policyTransitionRisk,
            explicitTargetOption: indirect.explicitTargetOption || false,
            targetUncertain: indirect.targetUncertain,
            pathDialectUncertain: indirect.pathDialectUncertain,
        });
    }
    const classification = !commit
        ? 'none'
        : uncertainShell
            ? 'uncertain'
            : noVerify || bypassHooks
                ? 'bypass'
                : commands.some((candidate) => candidate.verb === 'commit' && candidate.futureIndex)
                    ? 'future-index'
                    : 'direct';
    // opaqueCommitHiding narrows uncertainShell to uncertainty that can hide or
    // feed a commit (subshells, substitution, script-feeds, code-executing or
    // unlisted pipe segments). A bare pipeline of known read-only commands
    // (gh ... | tail) cannot, so it is not treated as a potential commit.
    const opaqueCommitHiding = (opaqueShell || (redirectOnly && (prefixHooksRisk || prefixIndexMutationRisk)))
        && !benignReadOnlyPipeline(cmd);
    return {
        commit,
        noVerify,
        bypassHooks,
        uncertainShell,
        opaqueCommitHiding,
        opaqueSink: opaqueCommitHiding && (opaqueSink || (redirectOnly && (prefixHooksRisk || prefixIndexMutationRisk))),
        stdinCode,
        classification,
        environmentRisk: unique(commands.flatMap((candidate) => candidate.environmentRisk || [])),
        prefixRisk,
        prefixHooksRisk,
        unreadable,
        addPaths,
        commands,
    };
}

const READ_ONLY_SHELL_COMMANDS = new Set(['echo', 'printf', 'pwd', 'test', 'true', '[']);

const SHELL_CONTROL_PREFIXES = new Set([
    '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do',
]);

const SHELL_CONTROL_WORDS = new Set([
    ...SHELL_CONTROL_PREFIXES,
    'case', 'esac', 'fi', 'for', 'function', 'done', 'select',
]);

const SHELL_CONTROL_DECLARATIONS = new Set([
    'case', 'done', 'esac', 'fi', 'for', 'function', 'select',
]);

const CURRENT_SHELL_MUTATORS = new Set([
    '.', 'alias', 'autoload', 'enable', 'eval', 'hash', 'rehash', 'setopt',
    'source', 'unalias', 'unfunction',
]);

// A compound shell segment such as `then git commit` is still tokenized as a
// command whose first word is `then`. Strip only reserved prefixes that can be
// followed by an executable command. The whole input remains uncertain so
// strict denies it, while clean/compliance can inspect the surfaced commit's
// staged content before a host allows execution.
export function unwrapShellControl(input) {
    const tokens = [...input];
    let uncertain = false;
    for (;;) {
        if (SHELL_CONTROL_PREFIXES.has(tokens[0])) {
            tokens.shift();
        } else if (tokens[0] === 'case' && tokens[2] === 'in') {
            // case WORD in PATTERN) COMMAND runs the command like any other.
            tokens.splice(0, 3);
        } else if (tokens.length > 1 && /^\(?[^()]*\)$/.test(tokens[0])) {
            // A case pattern such as a), *) or x|y) ahead of its command.
            tokens.shift();
        } else break;
        uncertain = true;
    }
    return { tokens, uncertain };
}

// The guard's own notes among the commands of a line: a script it is to read, an
// aimhooman command, a write into its state. They are not Git, and a line that
// holds only these has no Git command in it.
const NOTE_VERBS = new Set(['aimhooman', 'aimhooman-state', 'script']);

export function hasGitCandidate(commands) {
    return commands.some((candidate) => !NOTE_VERBS.has(candidate.verb));
}

// What a nested parse hands back to the line around it: Git that skips or
// repoints the hooks, a command Git runs from a setting, aimhooman commands that
// loosen the policy, and scripts, which are read. Git run with its hooks is no
// reason to refuse.
function runsBeyondTheLine(candidate) {
    return skipsGitHooks(candidate)
        || Boolean(candidate.runsConfigCommand)
        || NOTE_VERBS.has(candidate.verb);
}

// <<WORD, <<-WORD, <<'WORD' and <<"WORD" at text[at]: the delimiter, whether it
// was quoted (a quoted delimiter keeps the body from being expanded), and where
// the operator ends. <<< is a here-string, not a heredoc.
function heredocOperator(text, at) {
    if (text[at] !== '<' || text[at + 1] !== '<') return null;
    if (text[at + 2] === '<') return { hereString: true, end: at + 3 };
    let i = at + 2;
    const dash = text[i] === '-';
    if (dash) i += 1;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    let delimiter = '';
    let quoted = false;
    for (; i < text.length && !/[\s;&|<>()]/.test(text[i]); i += 1) {
        const char = text[i];
        if (char === "'" || char === '"') {
            const close = text.indexOf(char, i + 1);
            if (close < 0 || text.slice(i + 1, close).includes('\n')) return null;
            delimiter += text.slice(i + 1, close);
            quoted = true;
            i = close;
        } else if (char === '\\' && i + 1 < text.length) {
            delimiter += text[++i];
            quoted = true;
        } else {
            delimiter += char;
        }
    }
    return delimiter ? { delimiter, dash, quoted, end: i } : null;
}

// Where the body of a heredoc that starts at `from`, just after a newline, ends:
// the start of the line that is the delimiter, and the index past that line. A
// body with no such line runs to the end of the text, as the shell reads it.
function heredocBody(text, from, { delimiter, dash }) {
    for (let line = from; line < text.length;) {
        let end = text.indexOf('\n', line);
        if (end < 0) end = text.length;
        const content = text.slice(line, end);
        if ((dash ? content.replace(/^\t+/, '') : content) === delimiter) {
            return { end: line, after: Math.min(end + 1, text.length) };
        }
        line = end + 1;
    }
    return { end: text.length, after: text.length };
}

// The index of the ) that closes a substitution whose text starts at `from`, or
// -1. A heredoc body is data to the matching: its quotes and parentheses open
// and close nothing, so a commit message that says "don't" still closes.
function closingParen(text, from) {
    let depth = 1;
    let quote = '';
    const pending = [];
    for (let i = from; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === '\\' && quote === '"') i += 1;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '\\') {
            i += 1;
        } else if (char === "'" || char === '"') {
            quote = char;
        } else if (char === '<' && text[i + 1] === '<') {
            const operator = heredocOperator(text, i);
            if (operator) {
                if (!operator.hereString) pending.push(operator);
                i = operator.end - 1;
            }
        } else if (char === '\n' && pending.length) {
            let at = i + 1;
            for (const operator of pending.splice(0)) at = heredocBody(text, at, operator).after;
            i = at - 1;
        } else if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth -= 1;
            if (!depth) return i;
        }
    }
    return -1;
}

// The substitutions a line runs, $(...), `...`, <(...) and >(...), outermost
// only: parsing each finds the ones inside it. A single quote keeps them text, a
// double quote does not. Each is {start, end, inner} in the text, with inner null
// when its end cannot be found. The expanded body of a heredoc runs them too.
// Backticks are substitutions only to a POSIX shell: PowerShell escapes with them.
function substitutionSpans(text, backticks = true) {
    const spans = [];
    const pending = [];
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote === "'") {
            if (char === "'") quote = '';
            continue;
        }
        if (char === '\\') {
            i += 1;
            continue;
        }
        if (char === '"') {
            quote = quote ? '' : '"';
            continue;
        }
        if (char === "'" && !quote) {
            quote = "'";
            continue;
        }
        if (char === '<' && text[i + 1] === '<' && !quote) {
            const operator = heredocOperator(text, i);
            if (operator) {
                if (!operator.hereString) pending.push(operator);
                i = operator.end - 1;
                continue;
            }
        }
        if (char === '\n' && pending.length && !quote) {
            let at = i + 1;
            for (const operator of pending.splice(0)) {
                const body = heredocBody(text, at, operator);
                if (!operator.quoted) {
                    for (const span of substitutionSpans(text.slice(at, body.end), backticks)) {
                        spans.push({ ...span, start: span.start + at, end: span.end + at });
                    }
                }
                at = body.after;
            }
            i = at - 1;
            continue;
        }
        if (char === '`' && backticks) {
            let end = i + 1;
            while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
            if (end >= text.length) {
                spans.push({ start: i, end: text.length, inner: null, kind: 'command' });
                break;
            }
            spans.push({ start: i, end: end + 1, inner: text.slice(i + 1, end), kind: 'command' });
            i = end;
            continue;
        }
        const opens = text[i + 1] === '(' && text[i + 2] !== '('
            && (char === '$' || (!quote && (char === '<' || char === '>')));
        if (!opens) continue;
        // $( ) and backticks hand their output to the line as text; <( ) and >( )
        // hand a file, or a pipe into a program.
        const kind = char === '$' ? 'command' : 'process';
        const close = closingParen(text, i + 2);
        if (close < 0) {
            spans.push({ start: i, end: text.length, inner: null, kind });
            break;
        }
        spans.push({ start: i, end: close + 1, inner: text.slice(i + 2, close), kind });
        i = close;
    }
    return spans;
}

// The line with the ( ) and { } blanked: the guard reads what a group holds, so
// the group itself hides nothing.
function blankGroups(text) {
    let out = '';
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            out += char;
            if (char === '\\' && quote === '"' && i + 1 < text.length) out += text[++i];
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '\\' && i + 1 < text.length) {
            out += char + text[++i];
            continue;
        }
        if (char === "'" || char === '"') quote = char;
        out += char === '(' || char === ')' || char === '{' || char === '}' ? ' ' : char;
    }
    return out;
}

// The line with every substitution that was read replaced by a plain word, to
// ask what else in it is opaque.
function maskSubstitutions(text, spans) {
    let out = '';
    let at = 0;
    for (const span of spans) {
        if (span.inner === null || span.start < at) continue;
        out += `${text.slice(at, span.start)}X`;
        at = span.end;
    }
    return out + text.slice(at);
}

// A heredoc body is data to the command that reads it, not a command line:
// $(cat <<'EOF' ... EOF) is how a commit or a pull request message is written,
// and a line of it such as "Never run git push --no-verify" must not read as one.
// A body is dropped when what reads it only prints it (cat and the filters that
// pass text on) and nothing else shares its line; any other body stays, as it is
// for bash <<EOF. An unquoted delimiter still expands the body, so the
// substitutions in it stay.
const HEREDOC_DATA_READERS = new Set([
    'base64', 'cat', 'column', 'cut', 'fmt', 'fold', 'head', 'nl', 'rev', 'sort', 'tac', 'tail',
    'tr', 'uniq', 'wc',
]);

function dataReaderLine(line) {
    const rest = line.replace(/<<-?[^\S\n]*(?:'[^'\n]*'|"[^"\n]*"|\\?[^\s;&|<>()'"]+)/g, ' ')
        .replace(/'[^']*'|"[^"]*"/g, "''");
    if (/[;&`$(){}<>]|\|\|/.test(rest)) return false;
    // cat <<EOF | fold -w 72: the body may pass through a pipe of text filters.
    const [reader, ...sinks] = rest.split('|').map((segment) => shellExecutable(shellWords(segment.trim())[0] ?? ''));
    return HEREDOC_DATA_READERS.has(reader) && sinks.every((sink) => SAFE_PIPE_EXECUTABLES.has(sink));
}

function dropDataHeredocs(text) {
    if (!text.includes('<<')) return text;
    let out = '';
    let copied = 0;
    let lineStart = 0;
    let quote = '';
    const pending = [];
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === '\\' && quote === '"') i += 1;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '\\') {
            i += 1;
        } else if (char === "'" || char === '"') {
            quote = char;
        } else if (char === '<' && text[i + 1] === '<') {
            const operator = heredocOperator(text, i);
            if (operator) {
                if (!operator.hereString) pending.push(operator);
                i = operator.end - 1;
            }
        } else if (char === '\n') {
            if (pending.length) {
                const data = dataReaderLine(text.slice(lineStart, i));
                let at = i + 1;
                out += text.slice(copied, at);
                for (const operator of pending.splice(0)) {
                    const body = heredocBody(text, at, operator);
                    if (data) {
                        if (!operator.quoted) {
                            for (const span of substitutionSpans(text.slice(at, body.end))) {
                                if (span.inner !== null) out += `$(${span.inner})\n`;
                            }
                        }
                        out += text.slice(body.end, body.after);
                    } else {
                        out += text.slice(at, body.after);
                    }
                    at = body.after;
                }
                copied = at;
                i = at - 1;
            }
            lineStart = i + 1;
        }
    }
    return out + text.slice(copied);
}

// ( and { group commands without changing what the words inside run, so
// (git -c core.hooksPath=/dev/null commit) is that commit. The shell splits a
// parenthesis off a word and this tokenizer does not, so one glued to the first
// word is taken off, and as many at the end; (( is arithmetic and stays. A lone
// } or ) only closes a group an earlier unit opened.
function stripCommandGrouping(tokens) {
    // Positions, not slices: a line of nothing but ( made every slice copy the rest.
    let start = 0;
    let first = tokens[0];
    let parens = 0;
    let braces = 0;
    while (start < tokens.length) {
        if (first === '{') {
            braces += 1;
        } else if (first !== '}' && first !== ')') {
            if (!first.startsWith('(') || first.startsWith('((')) break;
            parens += 1;
            first = first.slice(1);
            if (first) continue;
        }
        start += 1;
        first = tokens[start];
    }
    const words = tokens.slice(start);
    if (words.length) words[0] = first;
    let end = words.length;
    while (braces && end > 0 && words[end - 1] === '}') {
        end -= 1;
        braces -= 1;
    }
    let tail;
    while (parens && end > 0) {
        const last = tail ?? words[end - 1];
        if (!last.endsWith(')')) break;
        parens -= 1;
        if (last === ')') {
            end -= 1;
            tail = undefined;
        } else {
            tail = last.slice(0, -1);
        }
    }
    words.length = end;
    if (tail !== undefined && end > 0) words[end - 1] = tail;
    return words;
}

function updateDirectoryStack(tokens, cwd, stack, followingOperator) {
    const command = directoryCommandTokens(tokens);
    const executable = shellExecutable(command[0]);
    if (executable !== 'pushd' && executable !== 'popd') return null;
    const args = command.slice(1);
    const conditionalOnSuccess = followingOperator === '&&' || followingOperator === null;
    if (args.some((arg) => arg.startsWith('-') && arg !== '--')
        || args.some((arg) => /^[+-]\d+$/.test(arg))) {
        return { cwd, uncertain: true, pathDialectUncertain: false };
    }
    const positionals = args.filter((arg) => arg !== '--');
    if (executable === 'pushd') {
        if (positionals.length > 1) return { cwd, uncertain: true, pathDialectUncertain: false };
        if (positionals.length === 0) {
            if (!stack.length) return { cwd, uncertain: true, pathDialectUncertain: false };
            const previous = stack.pop();
            stack.push(cwd);
            return {
                cwd: previous,
                uncertain: !conditionalOnSuccess,
                pathDialectUncertain: false,
            };
        }
        const path = positionals[0];
        if (shellPathHasExpansion(path)) {
            return { cwd, uncertain: true, pathDialectUncertain: false };
        }
        stack.push(cwd);
        return {
            cwd: resolveShellPath(cwd, path),
            uncertain: !conditionalOnSuccess || cdpathMayRedirect(path),
            pathDialectUncertain: shellPathIsAmbiguous(path),
        };
    }
    if (positionals.length || !stack.length) {
        return { cwd, uncertain: true, pathDialectUncertain: false };
    }
    return { cwd: stack.pop(), uncertain: !conditionalOnSuccess, pathDialectUncertain: false };
}

function directoryCommandTokens(tokens) {
    let command = tokens;
    let executable = shellExecutable(command[0]);
    while (executable === '-' || executable === 'nocorrect' || executable === 'noglob') {
        command = command.slice(1);
        executable = shellExecutable(command[0]);
    }
    if (executable === 'builtin') {
        command = command.slice(1);
        if (command[0] === '--') command = command.slice(1);
    }
    return command;
}

// A literal prefix that addresses Git's index makes the staged snapshot read
// by PreToolUse stale before Git starts. This catches direct copy/install/move,
// redirection, and worktree index paths without treating every ordinary build
// command before a commit as an index replacement.
function commandMayReplaceIndex(tokens, source) {
    const text = pathText(tokens, source);
    // A path that ends in /.git/index is one whose last directory name is
    // .git; looking only at the character before it keeps the scan linear.
    return /(?:^|[\s"'=]|[^\s"']\/)\.git\/index(?:\.lock)?(?:$|[\s"'])/i.test(text)
        || /\bGIT_INDEX_FILE\b/.test(text)
        || /\bgit\s+rev-parse\b[^;&|\n]*\b--git-path(?:=|\s+)index\b/i.test(text);
}

// The same shape, asking the other question a prefix raises: it runs in the repo
// before Git starts, with write access to the hooks. A build or a test suite
// cannot take pre-commit away; writing into the hooks directory or repointing
// core.hooksPath can. Literal, like the index check above, so an ordinary
// command does not read as a bypass merely for being unmodelled.
// An include never names the hooks; it carries a core.hooksPath of its own and
// the guard is gone all the same. hooksPathOverrideConfig already counts it for
// the -c spelling, so leaving it out here would let the two spellings of one
// bypass disagree.
export function commandMayTouchHooks(tokens, source) {
    const text = pathText(tokens, source);
    // The directory need not be spelled in full to be removed: `.git/h*` takes
    // it just as well as `.git/hooks`. Match the segment and step around HEAD,
    // the only other `.git/h` an ordinary command reads.
    return /(?:^|[\s"'=/])\.git\/h(?!ead\b)/i.test(text)
        || /--git-path\s+hooks\b/i.test(text)
        || /\bhookspath\b/i.test(text)
        // A config hook runs before the managed hook of its event, and an ext
        // transport runs its URL.
        || /\bhook\.[^\s"'.=]+\.(?:command|event)\b/i.test(text)
        || /\bprotocol\.(?:ext\.)?allow\b/i.test(text)
        || namesIncludePath(text)
        // Whatever is written into .git/config can set core.hooksPath.
        || /(?:^|[\s"'=/])\.git\/config\b/i.test(text)
        || writesProtectedPath(tokens, source);
}

// Options whose value is a pattern to match, not a path to touch:
// find -name .git, grep --exclude-dir=.git.
const PATTERN_VALUE_OPTIONS = new Set([
    '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
    '--exclude', '--exclude-dir', '--exclude-from', '--include', '--ignore',
]);
const PATH_DESTROYERS = new Set(['mv', 'rm', 'rmdir', 'shred', 'unlink']);

// Whether a command writes to the hooks or the config in a spelling the literal
// check misses: a glob that matches them (.git/[h]ooks, .git/*), the .git
// directory removed or moved, or the global gitconfig. A reader writes only
// through a redirect, cp, install and ln write only their last path, and a
// pattern given to find, grep or rsync is not a path.
function writesProtectedPath(tokens, source) {
    const executable = shellExecutable(tokens[0]);
    const written = [];
    if (!FILE_READERS.has(executable)) {
        for (let i = 1; i < tokens.length; i += 1) {
            const word = tokens[i];
            if (PATTERN_VALUE_OPTIONS.has(word)) i += 1;
            else if (!word.startsWith('-')) written.push(word);
        }
    }
    const paths = ['cp', 'install', 'ln'].includes(executable) ? written.slice(-1) : written;
    const destroys = PATH_DESTROYERS.has(executable)
        || (executable === 'find' && tokens.some((word) => ['-delete', '-exec', '-execdir', '-ok'].includes(word)));
    return [...paths, ...redirectTargets(source)].some((word) => (
        namesGitInternals(word, destroys) || namesGlobalGitConfig(word)
    ));
}

// Whether the word is a path to the hooks directory or the config file inside a
// .git, or a glob that can match them, or the .git directory itself when the
// command removes or moves what it names.
function namesGitInternals(word, destroys) {
    if (/\s/.test(word)) return false;
    const segments = posix.normalize(String(word).replace(/\\/g, '/')).split('/');
    const at = segments.indexOf('.git');
    if (at < 0) return false;
    if (at === segments.length - 1) return destroys;
    const next = segments[at + 1];
    const last = at + 2 === segments.length;
    return next === 'hooks' || (next === 'config' && last)
        || (/[*?[]/.test(next) && (globMatches(next, 'hooks') || (last && globMatches(next, 'config'))));
}

function namesGlobalGitConfig(word) {
    if (/\s/.test(word)) return false;
    return /(?:^|\/)\.gitconfig$|(?:^|\/)\.config\/git\/config$|^\/etc\/gitconfig$|^\$\{?XDG_CONFIG_HOME\}?\/git\/config$/
        .test(posix.normalize(String(word).replace(/\\/g, '/')));
}

// A shell glob segment against a name: * ? and [..] only.
function globMatches(pattern, name) {
    let source = '^';
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === '*') source += '[^/]*';
        else if (char === '?') source += '[^/]';
        else if (char === '[' && pattern.indexOf(']', i + 2) > 0) {
            const close = pattern.indexOf(']', i + 2);
            source += `[${pattern.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
            i = close;
        } else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    try {
        return new RegExp(`${source}$`).test(name);
    } catch {
        return true;
    }
}

// A path as the filesystem reads it: \ as /, and // or /./ as one /.
function pathText(tokens, source) {
    return `${tokens.join(' ')} ${source}`
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/\/(?:\.\/)+/g, '/');
}

// Whether a directory is a Git directory or inside one, where a relative path
// such as hooks/pre-commit names the hooks.
function insideGitDirectory(path) {
    return /(?:^|\/)\.git(?:\/|$)/i.test(String(path || '').replace(/\\/g, '/'));
}

// include.path or includeIf.<condition>.path. The condition is looked for
// once per word: a regex retried at every includeIf in one word was quadratic.
function namesIncludePath(text) {
    return text.split(/[\s"'=]+/).some((word) => {
        if (/\binclude\.path\b/i.test(word)) return true;
        const at = word.search(/\bincludeif\./i);
        return at >= 0 && /\.path\b/i.test(word.slice(at + 'includeif.'.length));
    });
}

// An unquoted > or >> that writes a file. fd duplications (2>&1, >&2, >&-)
// write none.
function hasFileRedirect(text) {
    return redirectTargets(text, 1).length > 0;
}

// The files the unquoted > and >> of a command write, up to limit of them.
// Characters are compared in place: slicing the rest of a long line at each >
// made a run of >&2 quadratic.
function redirectTargets(text, limit = Infinity) {
    const targets = [];
    const word = /"[^"]*"|'[^']*'|[^\s;&|<>]+/y;
    let quote = '';
    for (let i = 0; i < text.length && targets.length < limit; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = '';
            else if (char === '\\' && quote === '"') i += 1;
            continue;
        }
        if (char === '\\') {
            i += 1;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (char !== '>' || (text[i + 1] === '&' && /[0-9-]/.test(text[i + 2] ?? ''))) continue;
        let at = i + 1;
        while (text[at] === '>' || text[at] === '|') at += 1;
        while (at < text.length && /\s/.test(text[at])) at += 1;
        word.lastIndex = at;
        const target = word.exec(text)?.[0] ?? '';
        targets.push(target.replace(/^(["'])(.*)\1$/s, '$2'));
        i = Math.max(i, at + target.length - 1);
    }
    return targets;
}

// aimhooman's own commands that loosen what this guard enforces: allow and
// review add exceptions, policy-review accepts a weaker policy, override remove
// and reset drop deny rules, uninstall takes the hooks away, and init with
// --profile can change the profile. Found at the start of a command, by name or
// path, or after the program that launches it (npx, node, npm exec); the word
// aimhooman among another command's arguments, as in cd aimhooman or a message
// that says "run aimhooman allow", is not one.
const AIMHOOMAN_LAUNCHERS = new Set(['bun', 'bunx', 'deno', 'node', 'nodejs', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn']);

function aimhoomanInvocation(tokens) {
    const named = (word) => /^aimhooman(?:@\S*)?(?:\.[cm]?js)?$/i.test(String(word ?? '').replace(/\\/g, '/').split('/').at(-1));
    let at = 0;
    if (!named(tokens[0])) {
        if (!AIMHOOMAN_LAUNCHERS.has(shellExecutable(tokens[0]))) return null;
        at = 1;
        while (at < tokens.length && (tokens[at].startsWith('-') || ['dlx', 'exec', 'x'].includes(tokens[at]))) at += 1;
        if (!named(tokens[at])) return null;
    }
    let args = tokens.slice(at + 1);
    while (named(args[0])) args = args.slice(1);
    const subcommand = args.find((arg) => !arg.startsWith('-')) ?? '';
    const option = args.findIndex((arg) => arg === '--profile' || arg.startsWith('--profile='));
    const profile = option < 0 ? null
        : args[option].startsWith('--profile=') ? args[option].slice('--profile='.length) : (args[option + 1] ?? '');
    if (['allow', 'review', 'policy-review', 'uninstall'].includes(subcommand)
        || (subcommand === 'override' && args.some((arg) => arg === 'remove' || arg === 'reset'))
        || (subcommand === 'init' && profile !== null)) {
        return { subcommand, profile };
    }
    return null;
}

// Programs that change nothing in the files they name, so they change the
// guard's state only through a redirect.
const FILE_READERS = new Set([
    ...READ_ONLY_SHELL_COMMANDS,
    'cd', 'popd', 'pushd',
    'ack', 'ag', 'cat', 'cmp', 'diff', 'du', 'egrep', 'fgrep', 'file', 'grep', 'head',
    'hexdump', 'jq', 'less', 'ls', 'md5', 'md5sum', 'more', 'od', 'rg', 'sha1sum',
    'sha256sum', 'shasum', 'stat', 'tail', 'tree', 'wc', 'xxd',
]);

// Whether a command writes or removes aimhooman's state in .git/aimhooman: the
// commits it refused, the overrides, the profile. Only a path word counts, one
// with no blank in it: a commit message that mentions the directory is not a
// path. A reader changes it only through a redirect.
function mayChangeAimhoomanState(tokens, source, cwd) {
    const inState = /(?:^|\/)\.git\/aimhooman(?:\/|$)/i.test(String(cwd || '').replace(/\\/g, '/'));
    const inGit = insideGitDirectory(cwd);
    const names = (word) => {
        if (/\s/.test(word)) return false;
        const path = posix.normalize(String(word).replace(/\\/g, '/'));
        return /(?:^|\/)\.git\/aimhooman(?:\/|$)/i.test(path) || (inGit && /^aimhooman(?:\/|$)/i.test(path));
    };
    const targets = redirectTargets(source);
    const reader = FILE_READERS.has(shellExecutable(tokens[0]));
    if (inState && (!reader || targets.length)) return true;
    return [...(reader ? [] : tokens.slice(1)), ...targets].some(names);
}

export const GIT_POLICY_TRANSITION_COMMANDS = new Set([
    'am', 'branch', 'checkout', 'cherry-pick', 'commit', 'merge', 'pull', 'read-tree', 'rebase',
    'replace', 'reset', 'restore', 'revert', 'rm', 'switch', 'symbolic-ref', 'update-index',
    'update-ref',
]);

// Verbs whose effect a later command's policy resolution reads: they move HEAD,
// the index, or the worktree that `.aimhooman.json` is resolved from. Only these
// raise the transition flag that refuses a later Git command on the same line.
//
// Deliberately a third set rather than a narrowing of the two around it. Those
// two also decide whether a verb becomes a modelled candidate at all, so
// dropping `push` from ref mutation would take the installed-guard check for
// `git push` with it. `commit` is absent on purpose: the state it moves is state
// this tool just supervised through pre-commit, commit-msg and the ref guard,
// unlike `symbolic-ref` or `stash pop`, which move it unwatched.
export const GIT_POLICY_INPUT_COMMANDS = new Set([
    'am', 'branch', 'checkout', 'cherry-pick', 'merge', 'pull', 'read-tree', 'rebase',
    'replace', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'symbolic-ref',
    'update-index', 'update-ref',
]);

function raisesPolicyTransitionRisk(verb, args = []) {
    return GIT_POLICY_INPUT_COMMANDS.has(verb) && !gitReadOnlyRefCommand(verb, args);
}

// These verbs can create a commit or move a branch/reference. Their final
// safety boundary is the managed reference-transaction hook, so PreToolUse
// must not let config/environment/prefix indirection disable that boundary.
export const GIT_REF_MUTATION_COMMANDS = new Set([
    'am', 'bisect', 'branch', 'checkout', 'cherry-pick', 'fetch', 'maintenance', 'merge', 'notes',
    'pull', 'push', 'rebase', 'remote', 'replace', 'reset', 'revert', 'stash', 'switch',
    'symbolic-ref', 'tag', 'update-ref', 'worktree',
]);

// gitReadOnlyRefCommand reports whether a ref-mutation verb is used in a
// read-only listing form that cannot move a ref or mutate state, so the
// reference-transaction guard has nothing to enforce. branch/remote/stash/notes
// each have listing subcommands developers pipe every day (`git branch | grep`,
// `git remote -v | grep`, `git stash list | head`); the mutating forms keep a
// mutating flag or positional and fall through to the full guard. Conservative:
// any unknown flag combination is treated as a mutation (fail-closed).
const GIT_BRANCH_MUTATING_FLAGS = new Set([
    '-d', '--delete', '-D', '-m', '--move', '-M', '-c', '--copy', '-C',
    '-u', '--set-upstream-to', '--unset-upstream', '--set-upstream', '-t',
    '--track', '--unset-track', '-f', '--force',
]);
const GIT_REMOTE_MUTATING_SUBCOMMANDS = new Set([
    'add', 'rename', 'rm', 'remove', 'set-url', 'set-head', 'prune', 'update',
    'set-urladd',
]);
const GIT_STASH_MUTATING_SUBCOMMANDS = new Set([
    'push', 'pop', 'apply', 'drop', 'clear', 'save', 'create', 'store', 'branch',
]);
const GIT_NOTES_MUTATING_SUBCOMMANDS = new Set([
    'add', 'append', 'copy', 'remove', 'rm', 'edit', 'prune',
]);

export function gitReadOnlyRefCommand(verb, args = []) {
    const { flags, positionals } = refListingWords(verb, args);
    const listMode = flags.some((flag) => REF_LIST_MODE_OPTIONS.has(flag));
    if (verb === 'branch') {
        // `git branch`, `git branch -a/-r/-l/--list/-v/--verbose/--all/--remotes`
        // only list. A name, a start-point, or any create/delete/move/copy flag
        // is a mutation.
        if (flags.some((flag) => GIT_BRANCH_MUTATING_FLAGS.has(flag))) return false;
        const listingOnly = flags.every((flag) => (
            GIT_BRANCH_READONLY_FLAGS.has(flag)
        ));
        if (!listingOnly) return false;
        // A positional outside list mode creates or moves a branch.
        if (positionals.length && !listMode) return false;
        return true;
    }
    if (verb === 'remote') {
        // `git remote` and `git remote -v/--verbose` list; `git remote show <n>`
        // and `git remote get-url <n>` are read-only; everything else mutates.
        if (positionals.length === 0) return flags.every((flag) => flag === '-v' || flag === '--verbose');
        const sub = positionals[0];
        if (GIT_REMOTE_MUTATING_SUBCOMMANDS.has(sub)) return false;
        return sub === 'show' || sub === 'get-url';
    }
    if (verb === 'stash') {
        // No subcommand defaults to `push` (a mutation). Only list/show are read.
        const sub = positionals[0] || 'push';
        if (GIT_STASH_MUTATING_SUBCOMMANDS.has(sub)) return false;
        return sub === 'list' || sub === 'show';
    }
    if (verb === 'notes') {
        // No subcommand defaults to `list` (read). list/show are read-only.
        const sub = positionals[0] || 'list';
        if (GIT_NOTES_MUTATING_SUBCOMMANDS.has(sub)) return false;
        return sub === 'list' || sub === 'show';
    }
    if (verb === 'tag') {
        // `git tag` and `git tag -l/--list` only list. A name, -d/--delete, -f/--force,
        // -a/--annotate, -s, -m, or -u creates/moves/deletes a tag.
        if (flags.some((flag) => GIT_TAG_MUTATING_FLAGS.has(flag))) return false;
        if (positionals.length && !listMode) return false;
        return true;
    }
    // `git worktree list` reads; add, move, remove, prune and the rest do not.
    if (verb === 'worktree') return args[0] === 'list';
    return false;
}

// Options of git branch and git tag that read the next word as their value,
// and those that put either command in list mode as -l does, where a word is
// a pattern rather than a name to create.
const REF_LISTING_VALUE_OPTIONS = new Set([
    '--sort', '--format', '--points-at', '--contains', '--no-contains', '--merged', '--no-merged',
]);
const REF_LIST_MODE_OPTIONS = new Set([
    '-l', '--list', '--points-at', '--contains', '--no-contains', '--merged', '--no-merged',
]);

// Options by name (--sort=x is --sort, and branch -av is -a -v) and the words
// that are not an option's value.
function refListingWords(verb, args) {
    const flags = [];
    const positionals = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }
        const name = arg.split('=', 1)[0];
        if (verb === 'branch' && /^-[^-]/.test(name)) {
            for (const letter of name.slice(1)) flags.push(`-${letter}`);
        } else flags.push(name);
        if (name === arg && REF_LISTING_VALUE_OPTIONS.has(name)) i += 1;
    }
    return { flags, positionals };
}

const GIT_TAG_MUTATING_FLAGS = new Set([
    '-d', '--delete', '-f', '--force', '-a', '--annotate', '-s', '--sign',
    '-m', '-u', '--local-user', '-v', '--verify', '-n',
]);

const GIT_BRANCH_READONLY_FLAGS = new Set([
    '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '--verbose', '-vv',
    '-q', '--quiet', '--no-color', '--color', '--show-current',
    '--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged',
    '--points-at',
]);

export function gitCommandMayBypassRefGuard(verb, args = []) {
    if (verb !== 'push') return false;
    // Git takes any unique prefix: --rece, --e.
    return args.some((arg) => {
        const name = arg.split('=', 1)[0];
        return (name.length >= 6 && '--receive-pack'.startsWith(name))
            || (name.length >= 3 && '--exec'.startsWith(name));
    });
}

export function isProtectedMutation(candidate) {
    return candidate?.verb === 'commit'
        || candidate?.verb === 'unknown'
        || GIT_REF_MUTATION_COMMANDS.has(candidate?.verb);
}

export function isGuardedCandidate(candidate) {
    return candidate?.verb === 'add' || isProtectedMutation(candidate);
}

const GIT_INDEX_MUTATION_COMMANDS = new Set([
    'add', 'checkout', 'mv', 'read-tree', 'reset', 'rm', 'switch', 'update-index',
]);

export function gitIndexMutationRisk(verb, args = []) {
    if (GIT_INDEX_MUTATION_COMMANDS.has(verb)) return true;
    if (verb === 'apply') {
        return args.some((arg) => [
            '--3way', '-3', '--cached', '--index', '--intent-to-add', '-N',
        ].includes(arg));
    }
    if (verb === 'restore') {
        return args.some((arg) => arg === '--staged' || arg === '-S'
            || (/^-[^-]/.test(arg) && arg.slice(1).includes('S')));
    }
    if (verb === 'stash') {
        const subcommand = args.find((arg) => !arg.startsWith('-')) || 'push';
        return !['list', 'show'].includes(subcommand);
    }
    if (verb === 'submodule') {
        return args.find((arg) => !arg.startsWith('-')) === 'add';
    }
    return false;
}

export function gitConfigMayMutate(args) {
    if (args.some((arg) => [
        '--add', '--edit', '-e', '--remove-section', '--rename-section',
        '--replace-all', '--unset', '--unset-all',
    ].includes(arg))) return true;
    if (args.some((arg) => [
        '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l',
    ].includes(arg))) return false;
    const positionals = args.filter((arg) => !arg.startsWith('-'));
    return positionals.length > 1;
}

// A verb missing from this list is captured as 'unknown' before the ref-mutation
// branch below is ever reached, so membership here is what lets a verb be
// modelled at all. Ref-moving verbs need both lists, never this one alone.
export const SAFE_NON_COMMIT_GIT = new Set([
    'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file',
    'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout',
    'cherry-pick', 'clean', 'clone', 'column', 'commit-graph', 'config', 'count-objects',
    'credential', 'describe',
    'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref',
    'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'index-pack', 'init',
    'interpret-trailers',
    'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'merge-tree',
    'mktag', 'mktree', 'mv',
    'name-rev', 'notes', 'pack-objects', 'prune', 'pull', 'push', 'range-diff', 'read-tree',
    'rebase',
    'reflog', 'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse',
    'revert',
    'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status',
    'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-objects', 'update-index',
    'update-ref', 'verify-commit', 'verify-pack', 'verify-tag', 'version', 'whatchanged',
    'worktree', 'write-tree',
]);

// Git's own global options. Those in the first set take their value as the
// next word; -C, -c, --config-env, --git-dir and --work-tree are read above.
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['--namespace', '--shallow-file', '--attr-source', '--super-prefix']);
const GIT_GLOBAL_OPTIONS = new Set([
    ...GIT_GLOBAL_VALUE_OPTIONS,
    '-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch',
    '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs',
    '--noglob-pathspecs', '--icase-pathspecs', '--exec-path', '--html-path', '--man-path',
    '--info-path', '--list-cmds', '-v', '--version', '-h', '--help',
]);

function quoteShellWord(word) {
    return `'${String(word).replace(/'/g, "'\\''")}'`;
}

const KNOWN_GIT_VERBS = new Set([
    ...SAFE_NON_COMMIT_GIT, ...GIT_REF_MUTATION_COMMANDS, ...GIT_POLICY_TRANSITION_COMMANDS,
]);

// Git's dashed programs (libexec/git-core/git-commit) run the same command as
// `git commit`, so they are read in that form.
function dashedGitInvocation(tokens) {
    const path = String(tokens[0] || '').replace(/\\/g, '/');
    const match = /^git-([a-z][a-z0-9-]*?)(?:\.exe)?$/.exec(path.split('/').at(-1).toLowerCase());
    // git-lfs, git-cliff and other tools named git-<name> are not Git.
    if (!match || !(/\/git-core\//i.test(path) || KNOWN_GIT_VERBS.has(match[1]))) return null;
    return ['git', match[1], ...tokens.slice(1)];
}

// A word the shell still expands can become an option. An unquoted $X or a
// backtick splits into words wherever it stands, and the quotes are gone by
// now; a brace expansion yields one only where it starts the word or follows
// a dash ({--no-verify,}). @{u}, HEAD@{1} and {x} in a message cannot. A glob
// becomes the names of matching files, and --no-ver*, -* or * can match one
// named --no-verify; after --name= it only matches more of the same option.
function mayExpandToOption(word) {
    return /[$`]/.test(word) || globOrBraceMayBeOption(word);
}
function globOrBraceMayBeOption(word) {
    const glob = word.startsWith('--') ? word.split('=', 1)[0] : word;
    return (/^[-{]/.test(word) && /[{}]/.test(word))
        || (/^[-*?[]/.test(glob) && /[*?[]/.test(glob));
}

// push, merge and pull take --no-verify; pull hands it to merge. A push skips
// pre-push with it, and git accepts it shortened to any unique prefix there
// (--no-veri), while -n is --dry-run. merge and pull also have
// --no-verify-signatures, so only the full spelling counts for them. A word
// the shell still expands may become any of these: uncertain when the word
// itself shows that, as two dashes after the expansion do through word splitting
// (main$IFS--no-verify), expanded when it only holds a value, which strict alone
// refuses because git push origin "$BRANCH" is everyday work.
export function hookSkipOptions(verb, args) {
    if (!['push', 'merge', 'pull'].includes(verb)) return { noVerify: false, uncertain: false, expanded: false };
    let noVerify = false;
    let uncertain = false;
    let expanded = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--') break;
        // A message or a push option is a value, never one of the flags.
        if (HOOK_SKIP_VALUE_OPTIONS.has(arg)) {
            i += 1;
            continue;
        }
        if (arg === '--verify') noVerify = false;
        else if (arg === '--no-verify'
            || (verb === 'push' && arg.length >= '--no-veri'.length && '--no-verify'.startsWith(arg))) {
            noVerify = true;
        }
        uncertain ||= /[$`].*--/.test(arg) || globOrBraceMayBeOption(arg);
        expanded ||= /[$`]/.test(arg);
    }
    // merge and pull skip only hooks that strict alone requires, so there an
    // expansion counts as --no-verify, not as a ref update nothing can verify.
    if (verb !== 'push' && (uncertain || expanded)) return { noVerify: true, uncertain: false, expanded: false };
    return { noVerify, uncertain, expanded };
}

const HOOK_SKIP_VALUE_OPTIONS = new Set([
    '-m', '-F', '--file', '-o', '--push-option', '--repo', '--receive-pack', '--exec',
    '-s', '--strategy', '-X', '--strategy-option', '--into-name',
]);

// A command word the shell still expands can turn into Git and its arguments:
// git${IFS}push, $G push, /usr/bin/gi? push, {git,push}, and =git in zsh. [
// and [[ are the test commands and a lone { opens a brace group, so neither
// counts. A literal last path segment names the program whatever the
// directories before it expand to: "$VENV/bin/python" runs python.
function commandWordExpands(word) {
    if (/^[A-Za-z_][A-Za-z0-9_]*\[[^\]$`]*\]\+?=/.test(word)) return false;
    const slash = word.lastIndexOf('/');
    if (slash >= 0 && !/[$`*?[\]{}()=\\]/.test(word.slice(slash + 1))) return false;
    return /^=|[$`*?]/.test(word) || inOrder(word, [/\[/, /\]/]) || inOrder(word, [/\{/, /,|\.\./, /\}/]);
}

const WRAPPED_SHELLS = new Set(['ash', 'bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh']);

function skipsGitHooks(candidate) {
    return candidate.noVerify || candidate.bypassHooks || candidate.hooksPathOverride;
}

// Subcommands that make or move commits and refs, or skip the hooks.
const EXPANDED_GIT_VERBS = new Set([
    'am', 'cherry-pick', 'commit', 'merge', 'notes', 'pull', 'push', 'rebase', 'replace',
    'reset', 'revert', 'symbolic-ref', 'update-ref',
]);

// Whether an expanded command word can be Git. A positional parameter carries
// a whole command ($1 $2 after set -- git ..., "$@" in a function); a glob or a
// brace expansion picks a name the line does not show; so can a word that names
// git, a variable the line sets from anything but a plain value, or a word on
// its own. A plain value, or a whole variable named for Git, shows what runs, so
// the command is read as if written out. Otherwise the arguments are read as Git's, and refused only when they
// skip or repoint the hooks for a subcommand that moves refs: another program's
// own -c or -m proves nothing. So ${PYTHON:-python3} -m pip install, $CC -c
// main.c and "$DOCKER" push pass. A variable an earlier command exported in a
// persistent shell can still hold Git with arguments that look harmless; the
// Git hooks and CI remain the backstop there.
function expandedWordMayRunGit(tokens, setNames, cwd) {
    const word = tokens[0];
    const args = tokens.slice(1);
    if (/\$(?:[@*0-9]|\{[#!]?[@*0-9])/.test(word)) return true;
    // Inside ${...}, a ? or a comma belongs to the expansion: ${PYTHON:?}.
    const plain = word.replace(/\$\{[^{}]*\}/g, '$');
    if (/[*?]/.test(plain) || inOrder(plain, [/\[/, /\]/]) || inOrder(plain, [/\{/, /,|\.\./, /\}/])) return true;
    if (/(?:^|[^a-z])git(?![a-z])/i.test(word)) {
        // $GIT status reads like git status; anything glued to it can hide more.
        if (!args.length || !/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(word)) return true;
        const ran = parseGit(['git', ...args].map(quoteShellWord).join(' '), cwd);
        return Boolean(ran.unreadable) || ran.commands.some(isGuardedCandidate);
    }
    for (const [, name] of word.matchAll(/\$\{?[#!]?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!setNames().has(name)) continue;
        const value = setNames().get(name);
        if (!value || (word !== `$${name}` && word !== `\${${name}}`)) return true;
        const ran = parseGit([value, ...args].map(quoteShellWord).join(' '), cwd);
        return Boolean(ran.unreadable) || ran.commands.some(isGuardedCandidate);
    }
    // On its own it can hold a whole command, unless a literal start makes it a
    // path to one program, as in ./$SCRIPT.
    if (!args.length) return /^[$`]/.test(word);
    // Without an option, or a word that can become one, nothing skips a hook.
    if (!args.some((token) => token.startsWith('-') || mayExpandToOption(token))) return false;
    if (args.some((token, index) => (
        (args[index - 1] === '-c' && /^core\.hookspath=/i.test(token)) || /^--config-env=core\.hookspath=/i.test(token)
    ))) return true;
    return parseGit(['git', ...args].map(quoteShellWord).join(' '), cwd).commands.some((candidate) => (
        candidate.verb !== 'unknown' && isProtectedMutation(candidate)
        && (candidate.noVerify || candidate.bypassHooks || candidate.hooksPathOverride)
    ));
}

// What a line sets, in one pass each: a plain NAME=value keeps its value, and
// anything else that can set a name (read, for, printf -vNAME, ${NAME:=...}, a
// value with an expansion, two different values) leaves null, an unknown.
function namesSetIn(line) {
    const names = new Map();
    for (const [, name, raw] of line.matchAll(/(?:^|[\s;&|(){}])([A-Za-z_][A-Za-z0-9_]*)\+?=([^\s;&|()<>]*)/g)) {
        const value = raw.replace(/^(["'])([^"'$`\\*?[\]{}]*)\1$/, '$2');
        const plain = /^[^"'$`\\*?[\]{}]*$/.test(value) && (!names.has(name) || names.get(name) === value);
        names.set(name, plain ? value : null);
    }
    for (const [, assigned, viaOption] of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=|-v[^\S\n]*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        names.set(assigned ?? viaOption, null);
    }
    for (const [, words] of line.matchAll(/\b(?:for|getopts|mapfile|read|readarray|select)\b([^;&|\n]*)/g)) {
        for (const [name] of words.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.set(name, null);
    }
    return names;
}

// The variable printf -v NAME or -vNAME assigns, or null.
function printfVariable(tokens) {
    if (shellExecutable(tokens[0]) !== 'printf') return null;
    if (tokens[1] === '-v') return tokens[2] ?? '';
    return tokens[1]?.startsWith('-v') ? tokens[1].slice(2) : null;
}

function isGitExecutable(value) {
    const executable = String(value || '').replace(/\\/g, '/').split('/').at(-1).toLowerCase();
    return executable === 'git' || executable === 'git.exe';
}

function canResolveGitAlias(value) {
    return /^(?:git|git\.exe)$/i.test(String(value || ''));
}

// A key the shell still has to expand ($'...', $VAR, {a..b}, or a PowerShell
// backtick escape) can turn into any key once the command runs, including the
// ones below, so it is treated as one of them.
function dynamicConfigKey(value) {
    const key = String(value).split('=', 1)[0];
    return shellPathHasExpansion(key) || key.includes('`');
}

function hookAffectingConfig(value) {
    const key = String(value).split('=', 1)[0];
    return dynamicConfigKey(value)
        || runsUnseenCommand(key)
        || /^(?:core\.(?:editor|hookspath)|sequence\.editor|include\.path|includeif\..+\.path|remote\..+\.receivepack)$/i.test(key);
}

// A narrower question than hookAffectingConfig: not "can this change how a hook
// behaves" but "does this take the managed hooks away". core.editor and
// sequence.editor leave pre-commit, commit-msg and reference-transaction
// running; these do not.
function hooksPathOverrideConfig(value) {
    const key = String(value).split('=', 1)[0];
    return dynamicConfigKey(value)
        || runsUnseenCommand(key)
        || /^(?:core\.hookspath|include\.path|includeif\..+\.path)$/i.test(key);
}

function unseenConfigKey(value) {
    const key = String(value).split('=', 1)[0];
    return runsUnseenCommand(key) ? key : null;
}

// Keys that hand Git a command whatever the subcommand. A config hook
// (hook.<name>.command for hook.<name>.event) runs before the managed hook of
// the same event and can rewrite it. protocol.allow and protocol.ext.allow open
// the ext transport, whose URL is a command line.
function runsUnseenCommand(key) {
    return /^(?:hook\..+\.(?:command|event)|protocol\.(?:ext\.)?allow)$/i.test(String(key));
}

function aliasAffectingConfig(value) {
    const key = String(value).split('=', 1)[0];
    return /^alias\./i.test(key);
}

const COMMIT_LONG_OPTIONS = new Map([
    ['ahead-behind', {}],
    ['all', { futureIndex: true }],
    ['allow-empty', {}],
    ['allow-empty-message', {}],
    ['amend', {}],
    ['author', { value: 'required' }],
    ['branch', {}],
    ['cleanup', { value: 'required' }],
    ['date', { value: 'required' }],
    ['dry-run', {}],
    ['edit', { editor: 'open' }],
    ['file', { value: 'required', messageSource: true }],
    ['fixup', { value: 'required', fixup: true }],
    ['gpg-sign', { value: 'optional' }],
    ['include', { futureIndex: true }],
    ['interactive', { futureIndex: true }],
    ['long', {}],
    ['message', { value: 'required', messageSource: true }],
    ['no-ahead-behind', {}],
    ['no-all', {}],
    ['no-amend', {}],
    ['no-author', { value: 'required' }],
    ['no-branch', {}],
    ['no-cleanup', { value: 'required' }],
    ['no-date', { value: 'required' }],
    ['no-dry-run', {}],
    ['no-edit', { editor: 'skip', messageSource: true }],
    ['no-file', { value: 'required' }],
    ['no-fixup', { value: 'required' }],
    ['no-gpg-sign', {}],
    ['no-interactive', {}],
    ['no-long', {}],
    ['no-message', { value: 'required' }],
    ['no-null', {}],
    ['no-only', {}],
    ['no-patch', {}],
    ['no-pathspec-file-nul', {}],
    ['no-pathspec-from-file', { value: 'required' }],
    ['no-porcelain', {}],
    ['no-post-rewrite', {}],
    ['no-quiet', {}],
    ['no-reedit-message', { value: 'required' }],
    ['no-reset-author', {}],
    ['no-reuse-message', { value: 'required' }],
    ['no-short', {}],
    ['no-signoff', {}],
    ['no-squash', { value: 'required' }],
    ['no-status', {}],
    ['no-template', { value: 'required' }],
    ['no-untracked-files', { value: 'optional' }],
    ['no-verbose', {}],
    ['no-verify', { noVerify: true }],
    ['null', {}],
    ['only', { futureIndex: true }],
    ['patch', { futureIndex: true }],
    ['pathspec-file-nul', {}],
    ['pathspec-from-file', { value: 'required', futureIndex: true }],
    ['porcelain', {}],
    ['post-rewrite', {}],
    ['quiet', {}],
    ['reedit-message', { value: 'required', editor: 'open', messageSource: true }],
    ['reset-author', {}],
    ['reuse-message', { value: 'required', messageSource: true }],
    ['short', {}],
    ['signoff', {}],
    ['squash', { value: 'required' }],
    ['status', {}],
    ['template', { value: 'required' }],
    ['trailer', { value: 'required' }],
    ['untracked-files', { value: 'optional' }],
    ['verbose', {}],
    ['verify', { noVerify: false }],
]);

const COMMIT_SHORT_OPTIONS = new Map([
    ['C', { value: 'required', messageSource: true }],
    ['F', { value: 'required', messageSource: true }],
    ['S', { value: 'optional' }],
    ['a', { futureIndex: true }],
    ['c', { value: 'required', editor: 'open', messageSource: true }],
    ['e', { editor: 'open' }],
    ['i', { futureIndex: true }],
    ['m', { value: 'required', messageSource: true }],
    ['n', { noVerify: true }],
    ['o', { futureIndex: true }],
    ['p', { futureIndex: true }],
    ['q', {}],
    ['s', {}],
    ['t', { value: 'required' }],
    ['u', { value: 'optional' }],
    ['v', {}],
    ['z', {}],
]);

export function inspectCommitOptions(args) {
    let noVerify = false;
    let futureIndex = false;
    let messageSource = false;
    let editorOverride = null;
    let uncertain = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            return {
                noVerify,
                futureIndex: futureIndex || i + 1 < args.length,
                editorRisk: editorOverride ?? !messageSource,
                uncertain,
            };
        }
        // An option word the shell still expands (--{no-verify,}, --$X) can
        // become --no-verify as well.
        if (arg.startsWith('-') && mayExpandToOption(arg)) uncertain = true;
        if (arg.startsWith('--')) {
            const separator = arg.indexOf('=');
            const spelling = arg.slice(2, separator < 0 ? undefined : separator);
            const option = resolveLongCommitOption(spelling);
            if (!option) continue;
            const optionValue = separator < 0 ? args[i + 1] : arg.slice(separator + 1);
            if (Object.hasOwn(option, 'noVerify')) noVerify = option.noVerify;
            futureIndex ||= Boolean(option.futureIndex);
            messageSource ||= Boolean(option.messageSource);
            if (option.fixup && !/^(?:amend|reword):/.test(optionValue || '')) {
                messageSource = true;
            }
            if (option.editor) editorOverride = option.editor === 'open';
            if (option.value === 'required' && separator < 0) i += 1;
            continue;
        }
        if (arg.startsWith('-') && arg !== '-') {
            for (let offset = 1; offset < arg.length; offset++) {
                const option = COMMIT_SHORT_OPTIONS.get(arg[offset]);
                if (!option) continue;
                if (Object.hasOwn(option, 'noVerify')) noVerify = option.noVerify;
                futureIndex ||= Boolean(option.futureIndex);
                messageSource ||= Boolean(option.messageSource);
                if (option.editor) editorOverride = option.editor === 'open';
                if (option.value) {
                    if (offset === arg.length - 1 && option.value === 'required') i += 1;
                    break;
                }
            }
            continue;
        }
        // A word the shell still expands ($'...', $VAR, {a,b}, a backtick) can
        // become an option such as --no-verify; read as a pathspec it hid one.
        uncertain ||= mayExpandToOption(arg);
        futureIndex = true;
    }
    return { noVerify, futureIndex, editorRisk: editorOverride ?? !messageSource, uncertain };
}

function resolveLongCommitOption(spelling) {
    if (COMMIT_LONG_OPTIONS.has(spelling)) return COMMIT_LONG_OPTIONS.get(spelling);
    const matches = [...COMMIT_LONG_OPTIONS.keys()].filter((name) => name.startsWith(spelling));
    return matches.length === 1 ? COMMIT_LONG_OPTIONS.get(matches[0]) : null;
}

function nestedShellPayload(tokens) {
    if (!tokens.length) return null;
    const executable = shellExecutable(tokens[0]);
    if (![
        'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh',
        'fish', 'csh', 'tcsh', 'nu', 'elvish',
    ].includes(executable)) return null;
    const valueOptions = new Set(['-O', '-o', '--init-file', '--rcfile']);
    for (let i = 1; i < tokens.length; i++) {
        const option = tokens[i];
        if (option === '--') break;
        if (option === '-c' && typeof tokens[i + 1] === 'string') return tokens[i + 1];
        if (/^-[^-]*c/.test(option) && typeof tokens[i + 1] === 'string') return tokens[i + 1];
        if (option === '-C' && executable === 'fish') {
            i += 1;
            continue;
        }
        if (valueOptions.has(option)) {
            i += 1;
            continue;
        }
        if (!option.startsWith('-')) break;
    }
    return null;
}

// Options whose value Git runs through a shell, as [short letter, long name,
// shortest prefix Git accepts, value must be attached]. difftool keeps unknown
// options for diff and so takes no abbreviation. A fetch from a local path
// starts its --upload-pack itself, as archive does its --exec, and grep -O
// opens the matching files with the command it is given.
const GIT_RUN_OPTIONS = {
    rebase: [['x', '--exec', 4]],
    difftool: [['x', '--extcmd', 8]],
    fetch: [['', '--upload-pack', 3]],
    pull: [['', '--upload-pack', 3]],
    'ls-remote': [['', '--upload-pack', 3], ['', '--exec', 5]],
    clone: [['u', '--upload-pack', 3]],
    archive: [['', '--exec', 3]],
    grep: [['O', '--open-files-in-pager', 4, true]],
};

// Values of an option written -xVALUE, -x VALUE, bundled as -ix VALUE,
// --name=VALUE or --name VALUE.
function optionValues(args, [short, long, shortest, attachedOnly = false]) {
    const values = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--') break;
        let value;
        if (arg.startsWith('--')) {
            const at = arg.indexOf('=');
            const name = at < 0 ? arg : arg.slice(0, at);
            if (name.length < shortest || !long.startsWith(name)) continue;
            value = at >= 0 ? arg.slice(at + 1) : attachedOnly ? undefined : args[(i += 1)];
        } else if (short && /^-[^-]/.test(arg) && arg.includes(short)) {
            value = arg.slice(arg.indexOf(short) + 1) || (attachedOnly ? undefined : args[(i += 1)]);
        } else continue;
        if (value !== undefined) values.push(value);
    }
    return values;
}

// The shell text Git itself runs for this command line, or null: the options
// above, the rest of `submodule foreach` and `bisect run` (Git hands the first
// word to the shell and the others to it as arguments), what `git config`
// stores under a command-valued key, and the command of an ext:: URL.
export function gitRunPayload(verb, args) {
    const runs = URL_VERBS.has(verb)
        ? args.filter((arg) => arg.startsWith('ext::')).flatMap(extCommands)
        : [];
    for (const spec of GIT_RUN_OPTIONS[verb] ?? []) {
        for (const value of optionValues(args, spec)) runs.push(value);
    }
    if (verb === 'clone') {
        for (const value of optionValues(args, ['c', '--config', 3]).flatMap(configCommands)) runs.push(value);
    }
    if (verb === 'config') {
        const at = args.findIndex(commandConfigKey);
        if (at >= 0 && args[at + 1] !== undefined) runs.push(helperCommand(args[at + 1]));
    }
    let words = [];
    if (verb === 'bisect' && args[0] === 'run') words = args.slice(1);
    else if (verb === 'submodule') {
        const at = args.findIndex((arg) => !arg.startsWith('-'));
        if (args[at] === 'foreach') words = args.slice(at + 1);
        while (words[0]?.startsWith('-')) words = words.slice(1);
    }
    if (words.length) runs.push([words[0], ...words.slice(1).map(quoteShellWord)].join(' '));
    return runs.length ? runs.join('\n') : null;
}

// Config keys whose value Git runs as a command: pagers and editors, external
// diff, textconv and diff filters, ssh, proxy and askpass programs, filter,
// merge and credential helpers, signing programs, diff and merge tools,
// trailer commands, upload-pack and receive-pack, sendemail, browser and man
// commands, the IMAP tunnel and submodule update commands.
const COMMAND_CONFIG_KEYS = [
    /^core\.(?:pager|editor|sshcommand|askpass|gitproxy|fsmonitor|alternaterefscommand)$/,
    /^(?:sequence\.editor|diff\.external|interactive\.difffilter|imap\.tunnel|instaweb\.httpd)$/,
    /^(?:uploadpack\.packobjectshook|gpg\.ssh\.defaultkeycommand)$/,
    /^pager\..+$/,
    /^diff\..+\.(?:command|textconv)$/,
    /^(?:diff|merge)tool\..+\.(?:cmd|path)$/,
    /^merge\..+\.driver$/,
    /^filter\..+\.(?:clean|smudge|process)$/,
    /^credential(?:\..+)?\.helper$/,
    /^gpg(?:\..+)?\.program$/,
    /^trailer\..+\.(?:cmd|command)$/,
    /^remote\..+\.(?:uploadpack|receivepack)$/,
    /^sendemail\.(?:sendmail|to|cc|header)cmd$/,
    /^(?:browser|man)\..+\.(?:cmd|path)$/,
    /^submodule\..+\.update$/,
    /^tar\..+\.command$/,
];

function commandConfigKey(key) {
    const name = String(key).toLowerCase();
    return COMMAND_CONFIG_KEYS.some((pattern) => pattern.test(name));
}

// Verbs that take a remote URL, where ext:: names a command.
const URL_VERBS = new Set(['archive', 'clone', 'config', 'fetch', 'ls-remote', 'pull', 'push', 'remote', 'submodule']);

// A helper value that starts with ! is a shell snippet (credential.helper,
// submodule.<name>.update); without it the rest is read the same way.
function helperCommand(value) {
    return String(value).replace(/^\s*!/, '');
}

// Whatever follows ext:: is a command Git runs to reach the remote.
function extCommands(text) {
    const at = String(text).indexOf('ext::');
    return at < 0 ? [] : [String(text).slice(at + 'ext::'.length)];
}

// The commands a key=value setting hands Git to run.
function configCommands(setting) {
    const text = String(setting);
    const at = text.indexOf('=');
    const value = at >= 0 && commandConfigKey(text.slice(0, at)) ? [helperCommand(text.slice(at + 1))] : [];
    return [...value, ...extCommands(text)];
}

// Variables whose value Git runs as a command, and config passed through the
// environment. <unset> and <declared> stand for values the line never shows.
const COMMAND_ENVIRONMENT = new Set([
    'EDITOR', 'GIT_ASKPASS', 'GIT_EDITOR', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_PROXY_COMMAND',
    'GIT_SEQUENCE_EDITOR', 'GIT_SSH', 'GIT_SSH_COMMAND', 'PAGER', 'SSH_ASKPASS', 'VISUAL',
]);

function environmentCommands(assignments) {
    return assignments.flatMap((assignment) => {
        const at = assignment.indexOf('=');
        const name = assignment.slice(0, at).toUpperCase();
        const value = assignment.slice(at + 1);
        if (/^<(?:unset|declared)>$/.test(value)) return [];
        if (COMMAND_ENVIRONMENT.has(name)) return [value];
        if (/^GIT_CONFIG_VALUE_\d+$/.test(name)) return [value, ...extCommands(value)];
        if (name === 'GIT_CONFIG_PARAMETERS') return shellWords(value).flatMap(configCommands);
        return [];
    });
}

function nestedShellStartupTargetUncertain(tokens) {
    const executable = shellExecutable(tokens[0]);
    if (['csh', 'elvish', 'fish', 'nu', 'tcsh'].includes(executable)) return true;
    for (let index = 1; index < tokens.length; index++) {
        const option = tokens[index];
        if (option === '--' || option === '-c') break;
        if (/^-[^-]*c/.test(option)) {
            return /^-[^-]*[il]/.test(option);
        }
        if (['--init-file', '--rcfile'].includes(option)
            || option.startsWith('--init-file=')
            || option.startsWith('--rcfile=')) return true;
        if (option === '-C' && executable === 'fish') return true;
        if (/^-[^-]*[il]/.test(option)) return true;
        if (['-O', '-o'].includes(option)) index += 1;
        else if (!option.startsWith('-')) break;
    }
    return false;
}

function nestedShellArgumentCommitInvocation(tokens, payload, initialCwd) {
    if (!/(?:^|[^A-Za-z0-9_])eval(?:[^A-Za-z0-9_]|$)|\$(?:[@*]|[1-9][0-9]*)/.test(payload)) {
        return null;
    }
    const payloadIndex = tokens.indexOf(payload);
    if (payloadIndex < 0 || payloadIndex === tokens.length - 1) return null;
    return literalCommitDetails(tokens.slice(payloadIndex + 1).join(' '), initialCwd);
}

// Shell nesting, pipelines, background jobs, and command substitution change
// cwd/execution scope in ways a non-executing parser cannot prove. A commit in
// such a command is denied by the agent guard and can be retried as a direct
// Git command, while ordinary `a && b`/`a || b` chains remain supported.
function hasUncertainShellSyntax(command, {
    payload = false,
    safePipes = SAFE_PIPE_EXECUTABLES,
    controlFlow = true,
    programFilters = false,
} = {}) {
    let quote = '';
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\' && quote !== "'") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (quote === '"' && (char === '`' || (char === '$' && command[i + 1] === '('))) {
                return true;
            }
            if (char === quote) quote = '';
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        // `{`/`}` are ambiguous: brace expansion (`{a,b}`, `{owner}`, `x.{js,ts}`)
        // is argument-level and cannot hide a commit or feed code into a pipe
        // sink, while a brace group (`{ list; }`) is control flow and can. Brace
        // expansion touches the surrounding word (no separator before the `{`, no
        // space/`;` after it); a brace-group `{` stands as its own token. PowerShell
        // `{ }` script blocks are handled separately via the non-POSIX executor
        // path, so this POSIX distinction never loosens that.
        if (char === '{' || char === '}') {
            if (isBraceGroupToken(command, i)) return true;
            continue;
        }
        // && and || only chain commands; neither is a pipe or a background job.
        if ((char === '|' || char === '&') && command[i + 1] === char) {
            i += 1;
            continue;
        }
        if (payload && char === '>' && command[i + 1] !== '(') continue;
        if (payload && char === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) continue;
        // The program a pipe feeds, cut at the next shell metacharacter (| head; ls
        // feeds head) and read from a short window, which a longer name is not.
        if (payload && char === '|') {
            const [first = '', ...after] = shellWords(command.slice(i + 1, i + 257), 10).map(String);
            const sink = shellExecutable(first.split(/[;&|)]/)[0]);
            // The sink's own words end where the next command starts.
            const own = after.findIndex((word) => /^(?:\|\|?|&&?|;)$/.test(word));
            if (safePipes.has(sink)
                || (programFilters && (PIPE_INTO_READ_LOOP.has(sink)
                    || textFilterIsData(sink, own < 0 ? after : after.slice(0, own))))) continue;
        }
        if (char === '`' || char === '(' || char === ')' || char === '<' || char === '>') return true;
        if (char === '|' || char === '&') return true;
    }
    if (!controlFlow) return false;
    return shellUnits(command).some((unit) => {
        const words = shellWords(unit.text.trim());
        return SHELL_CONTROL_WORDS.has(words[0]);
    });
}

// A pipe into a loop or a group feeds the read in it: ls | while read f; do ...
// The commands in the loop are read one by one, and a dynamic word among them is
// refused on its own, so the pipe hides nothing.
const PIPE_INTO_READ_LOOP = new Set(['while', 'until', 'for', 'if', 'case', 'select', 'read', '!']);

// Whether a pipe into awk or sed only filters the text: the program is on the
// command line, where it is read, and it neither starts a program nor takes its
// code from a file. awk '{print $2}' and sed 's/a/b/' are everyday; awk
// '{system($0)}', sed 's/x/y/e' and awk -f - run what they are fed.
function textFilterIsData(program, words) {
    const text = words.join(' ');
    if (/(?:^|\s)(?:-f|--file)(?:[=\s]|$)/.test(text)) return false;
    if (['awk', 'gawk', 'mawk', 'nawk'].includes(program)) {
        return !/\b(?:system|getline|popen|ENVIRON)\b|(?:^|[^|])\|(?!\|)/.test(text);
    }
    if (program === 'sed') {
        return !/s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[a-zA-Z0-9]*e|(?:^|[\s;{}\d$/])e(?:\s|;|}|$)/.test(text);
    }
    return false;
}

// BRACE_GROUP_LEAD chars may appear immediately before a brace-group token.
// `:` is included so `cmd: { ... }` is handled, though it is not POSIX shell.
const BRACE_GROUP_LEAD = new Set(['', ' ', '\t', '\n', ';', '&', '|', '(', ')']);
// BRACE_GROUP_OPEN_TRAIL chars may follow a `{` that opens a brace group: the
// reserved word `{` must be followed by whitespace, `;`, or end of string.
const BRACE_GROUP_OPEN_TRAIL = new Set([' ', '\t', '\n', ';', '']);
// BRACE_GROUP_CLOSE_LEAD chars precede a `}` that closes a brace group: the
// closer must follow `;` or whitespace (the end of the group body).
const BRACE_GROUP_CLOSE_LEAD = new Set([' ', '\t', '\n', ';', '']);

// isBraceGroupToken reports whether `{`/`}` at position i in command is a
// POSIX brace-group token (reserved-word `{` or its closer `}`) rather than a
// brace-expansion character. Brace expansion `{a,b}` / `{owner}` / `x.{js,ts}`
// is argument-level and cannot feed code into a pipe sink or run a subcommand,
// so it must not make a command "opaque". A brace group `{ list; }` is
// control flow and can, so it stays opaque. PowerShell script blocks are
// handled by the non-POSIX executor path, not here.
function isBraceGroupToken(command, i) {
    const char = command[i];
    const prev = command[i - 1] ?? '';
    const next = command[i + 1] ?? '';
    if (char === '{') {
        if (!BRACE_GROUP_LEAD.has(prev)) return false;
        if (!BRACE_GROUP_OPEN_TRAIL.has(next)) return false;
        return true;
    }
    // `}` closer: must follow `;` or whitespace.
    return BRACE_GROUP_CLOSE_LEAD.has(prev);
}

// hasUnquotedPipe reports whether command contains a pipe `|` that is not
// `||`, outside of any quote. Used to decide whether the opaque-pipeline deny
// message should mention a pipe at all — the original message always named
// `| bash` even for commands with no pipe.
export function hasUnquotedPipe(command) {
    let quote = '';
    let escaped = false;
    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && quote !== "'") { escaped = true; continue; }
        if (quote) {
            if (char === quote) quote = '';
            continue;
        }
        if (char === "'" || char === '"') { quote = char; continue; }
        if (char === '|' && command[i + 1] === '|') { i += 1; continue; }
        if (char === '|') return true;
    }
    return false;
}

export function shellUnits(s) {
    const out = [];
    let segment = '';
    let quote = '';
    let escaped = false;
    const push = (operator) => {
        if (segment.trim()) out.push({ text: segment, operator });
        segment = '';
    };
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (escaped) {
            segment += c;
            escaped = false;
        } else if (c === '\\' && quote !== "'") {
            segment += c;
            escaped = true;
        } else if (quote) {
            segment += c;
            if (c === quote) quote = '';
        } else if (c === "'" || c === '"') {
            segment += c;
            quote = c;
        } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
            let operator = c;
            if ((c === '|' && s[i + 1] === '|') || (c === '&' && s[i + 1] === '&')) {
                operator += s[++i];
            }
            push(operator);
        } else {
            segment += c;
        }
    }
    push(null);
    return out;
}

// SAFE_PIPE_EXECUTABLES are commands permitted in a "benign read-only pipeline":
// they take only data arguments, never run a sub-command, never execute code,
// never write files, and cannot bypass Git hooks. Anything not listed is treated
// as potentially able to hide or feed a commit (fail-closed). Deliberately
// excluded: shells and interpreters, awk/sed/ed/vim, sqlite3/psql/dc/bc/octave
// and other stdin-as-program readers, tee (writes files), env/xargs/find
// (run sub-commands), and curl/wget (fetch arbitrary content to a pipe). Git is
// handled separately: a read-only Git subcommand is an allowed pipe SOURCE (see
// GIT_READONLY_PIPE_SUBCOMMANDS), but Git is never a safe pipe SINK, because a
// mutating subcommand (apply, am, hash-object --stdin, fast-import) reads its
// program or patch from stdin.
const SAFE_PIPE_EXECUTABLES = new Set([
    'cat', 'tac', 'head', 'tail', 'tr', 'cut', 'paste', 'fold', 'fmt', 'expand',
    'unexpand', 'rev', 'nl', 'pr', 'column', 'sort', 'uniq', 'comm', 'tsort',
    'shuf', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'xxd', 'od',
    'hexdump', 'base64', 'base32', 'md5sum', 'sha1sum', 'sha224sum', 'sha256sum',
    'sha384sum', 'sha512sum', 'cksum', 'b2sum', 'sum', 'file', 'ls', 'exa', 'eza',
    'lsd', 'tree', 'du', 'df', 'stat', 'date', 'whoami', 'id', 'uname',
    'hostname', 'uptime', 'printenv', 'pwd', 'basename', 'dirname', 'realpath',
    'seq', 'yes', 'echo', 'printf', 'test', 'true', 'false', 'jq', 'yq', 'bat',
    'gh', '[', 'less', 'more',
]);

// The pipe sinks above, and tee: it writes its input to files and runs nothing,
// so a line that pipes into it hides no command.
const PIPE_SINKS_THAT_ONLY_STORE = new Set([...SAFE_PIPE_EXECUTABLES, 'tee']);

// SAFE_BUILD_PIPE_EXECUTABLES are build, test, lint and language-toolchain
// commands permitted as a benign pipe SOURCE. They take data/flag arguments,
// report to stdout/stderr, and cannot bypass Git hooks or hide a `git commit`
// invocation from the parser — `npm test | tail`, `cargo build 2>&1 | grep`,
// `jest | head`, `eslint . | head` are how a developer runs a project every
// day. A package script could in principle shell out to git, but that is a
// prefix/indirection risk handled by the same guard that covers `a && b`, not a
// pipe that feeds code into a sink, so it does not make the pipeline opaque.
// Deliberately excluded: shells and interpreters reachable with a program on
// stdin (sh, bash, zsh, python -c, node -e, perl), and anything that runs an
// arbitrary sub-command (xargs, find -exec, env, make with a generated recipe
// is kept because its recipe is repository content, not pipe input).
const SAFE_BUILD_PIPE_EXECUTABLES = new Set([
    // package managers & task runners
    'npm', 'npx', 'yarn', 'pnpm', 'pnpx', 'bun', 'bunx', 'deno', 'cargo',
    'rustc', 'go', 'make', 'cmake', 'ninja', 'bazel', 'buck', 'pants', 'mill',
    'sbt', 'mvn', 'mvnw', 'gradle', 'gradlew', 'rake', 'bundle', 'gem', 'rake',
    'pip', 'pip3', 'pipx', 'poetry', 'pdm', 'uv', 'rye', 'conda', 'mamba',
    // test runners / formatters / linters / type-checkers
    'jest', 'vitest', 'mocha', 'karma', 'ava', 'tape', 'tap', 'pytest',
    'py.test', 'tox', 'nox', 'go-test', 'rspec', 'minitest', 'test', 'ctest',
    'xcodebuild', 'swift', 'swiftc', 'dotnet', 'msbuild', 'tsc', 'tsdx',
    'eslint', 'biome', 'biome-check', 'standard', 'ts-standard', 'prettier',
    'stylelint', 'ruff', 'flake8', 'pylint', 'mypy', 'black', 'isort', 'rubocop',
    'golangci-lint', 'staticcheck', 'revive', 'clippy', 'shellcheck',
    'hadolint', 'actionlint', 'markdownlint', 'remark', 'knip',
    // language runtimes used as direct tools
    'node', 'python', 'python3', 'ruby', 'php', 'java', 'javac', 'dotnet',
]);

// GIT_READONLY_PIPE_SUBCOMMANDS are Git subcommands safe as the SOURCE of a
// benign pipeline: they only report (stdout), do not move refs or mutate the
// index/worktree, do not read a program or patch from stdin, and cannot bypass
// hooks. `git log | head`, `git status | grep`, `git diff | cat` are how a
// developer reads a repository every day, and treating them as opaque commit
// hiding blocked the normal workflow. Anything that can write, move a ref, or
// consume stdin as input (add, commit, apply, am, hash-object, reset, checkout,
// push, fetch, merge, rebase, cherry-pick, read-tree, update-index, update-ref,
// clean, init, clone, bundle, archive, ...) is excluded and stays fail-closed.
// Dual-mode subcommands (branch, tag, remote, config, stash, notes) are kept:
// piped use is almost always the read form, their listing forms cannot hide or
// feed a commit, and a real ref/index mutation is still caught by the managed
// reference-transaction and pre-commit hooks at commit time.
const GIT_READONLY_PIPE_SUBCOMMANDS = new Set([
    'annotate', 'blame', 'branch', 'cat-file', 'check-attr', 'check-ignore',
    'check-mailmap', 'check-ref-format', 'cherry', 'config', 'count-objects',
    'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref',
    'fsck', 'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base',
    'name-rev', 'notes', 'reflog', 'remote', 'rev-list', 'rev-parse', 'shortlog',
    'show', 'show-branch', 'show-ref', 'stash', 'status', 'var',
    'verify-commit', 'verify-pack', 'verify-tag', 'version', 'whatchanged',
]);

// gitPipeSourceSubcommand returns the Git subcommand of a pipe segment that is a
// read-only Git source (e.g. `git -C repo log --oneline`), or null when the
// segment is not a Git command or the subcommand is not read-only. It reuses the
// same global-option skipping the verb parser does, so `-C path`, `-c k=v`,
// `--git-dir`, `--work-tree`, `--namespace` and `--no-pager`/`-p` style flags do
// not hide a mutating subcommand.
function gitPipeSourceSubcommand(segment) {
    const words = shellWords(segment.trim());
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    if (i >= words.length || !isGitExecutable(words[i])) return null;
    i += 1;
    while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
        const option = words[i];
        // Global options that take the next token as their value.
        if (['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace',
            '--upload-pack', '--receive-pack'].includes(option) && words[i + 1]) {
            i += 2;
        } else if (
            option.startsWith('-C')
            || option.startsWith('-c')
            || option.startsWith('--config-env=')
            || option.startsWith('--git-dir=')
            || option.startsWith('--work-tree=')
            || option.startsWith('--namespace=')
            || option.startsWith('--upload-pack=')
            || option.startsWith('--receive-pack=')
        ) {
            i += 1;
        } else {
            // Flags that take no value (--no-pager, -p, --no-replace-objects,
            // --literal-pathspecs, --bare, --exec-path, ...). `--` ends options.
            i += 1;
        }
    }
    if (i < words.length && words[i] === '--') i += 1;
    const subcommand = words[i];
    if (!subcommand) return null;
    // A listing such as git tag -l or git branch --merged reads like git log.
    return GIT_READONLY_PIPE_SUBCOMMANDS.has(subcommand) || gitReadOnlyRefCommand(subcommand, words.slice(i + 1))
        ? subcommand
        : null;
}

// containsOpaquePipeLexeme is a quote-aware scan for shell constructs that can
// hide or feed a commit or subcommand: command substitution, subshells, brace
// expansion/groups, script-feed redirects, and command separators. Output
// redirects (>, >>) and fd-dups such as 2>&1 are intentionally NOT opaque: they
// cannot feed code into a pipe sink. A bare & (background) is opaque unless it
// is part of an fd-dup (>& / <&) or &&.
function containsOpaquePipeLexeme(command) {
    let quote = '';
    let escaped = false;
    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        const prev = command[i - 1];
        const next = command[i + 1];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && quote !== "'") { escaped = true; continue; }
        if (quote) {
            if (quote === '"' && (char === '`' || (char === '$' && next === '('))) return true;
            if (char === quote) quote = '';
            continue;
        }
        if (char === "'" || char === '"') { quote = char; continue; }
        // Brace expansion (`{a,b}`, `{owner}`) is not opaque: it only expands to
        // arguments for the same command and cannot feed code into a pipe sink.
        // Brace groups (`{ list; }`) are opaque. See isBraceGroupToken.
        if (char === '{' || char === '}') {
            if (isBraceGroupToken(command, i)) return true;
            continue;
        }
        if (char === '`' || char === '(' || char === ')') return true;
        if (char === '$' && (next === '(' || next === '{')) return true;
        if (char === '<' || char === ';') return true;
        if (char === '&' && next !== '&' && prev !== '&' && prev !== '>' && prev !== '<') return true;
    }
    return false;
}

// splitPipeSegments splits a command on an unquoted pipe (|) that is not part
// of ||. Unlike shellUnits it does not break on &, so 2>&1 stays within a
// segment.
function splitPipeSegments(command) {
    const segments = [];
    let segment = '';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        if (escaped) { segment += char; escaped = false; continue; }
        if (char === '\\' && quote !== "'") { segment += char; escaped = true; continue; }
        if (quote) { segment += char; if (char === quote) quote = ''; continue; }
        if (char === "'" || char === '"') { segment += char; quote = char; continue; }
        if (char === '|' && command[i + 1] !== '|') { segments.push(segment); segment = ''; continue; }
        segment += char;
    }
    segments.push(segment);
    return segments;
}

// pipelineSegmentExecutable returns the shellExecutable basename of the first
// non-environment-assignment token in a pipe segment, or null when the segment
// has no command. A leading redirect token (e.g. 2>&1 before the command) is
// treated as unlisted -> null -> not benign (fail-closed), which is safe.
function pipelineSegmentExecutable(segment) {
    for (const word of shellWords(segment.trim())) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
        return shellExecutable(word);
    }
    return null;
}

// splitLogicalUnits splits a command line on unquoted command separators that
// do not move data into a pipe sink: &&, ||, and ;. A pipeline between two
// separators stays one unit (its internal | is handled by splitPipeSegments).
function splitLogicalUnits(command) {
    const units = [];
    let unit = '';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        const next = command[i + 1];
        if (escaped) { unit += char; escaped = false; continue; }
        if (char === '\\' && quote !== "'") { unit += char; escaped = true; continue; }
        if (quote) { unit += char; if (char === quote) quote = ''; continue; }
        if (char === "'" || char === '"') { unit += char; quote = char; continue; }
        if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
            units.push(unit); unit = ''; i += 1; continue;
        }
        if (char === ';') { units.push(unit); unit = ''; continue; }
        unit += char;
    }
    units.push(unit);
    return units;
}

// benignReadOnlyUnit reports whether a single shell unit (no &&/||/;) is a
// read-only pipeline or a single read-only command. It is the same fail-closed
// contract as benignReadOnlyPipeline, applied to one piece of a compound line:
// the unit cannot hide or feed a commit when every pipe segment is a known safe
// filter, a read-only Git source, or a build/test toolchain command as source.
function benignReadOnlyUnit(unit) {
    const text = unit.trim();
    if (!text) return true; // an empty piece (e.g. trailing ;) is harmless
    if (containsOpaquePipeLexeme(text)) return false;
    const segments = splitPipeSegments(text);
    if (segments.length < 2) {
        // A single command (no pipe). Benign when it is a known safe command, a
        // build/test toolchain command, a read-only Git command, or a directory
        // change.
        const words = shellWords(text);
        while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
        if (!words.length) return true;
        const executable = shellExecutable(words[0]);
        if (SAFE_PIPE_EXECUTABLES.has(executable)) return true;
        if (SAFE_BUILD_PIPE_EXECUTABLES.has(executable)) return true;
        if (executable === 'cd' || executable === 'pushd' || executable === 'popd') return true;
        return gitPipeSourceSubcommand(text) !== null;
    }
    return segments.every((segment, index) => {
        const executable = pipelineSegmentExecutable(segment);
        if (executable !== null && SAFE_PIPE_EXECUTABLES.has(executable)) return true;
        if (index === 0) {
            // Source-only segments: a read-only Git command, or a build/test
            // toolchain command. Build tools and interpreters must never be a
            // later (sink) segment, where stdin could feed a program or patch.
            if (executable !== null && SAFE_BUILD_PIPE_EXECUTABLES.has(executable)) return true;
            if (gitPipeSourceSubcommand(segment) !== null) return true;
        }
        return false;
    });
}

// benignReadOnlyPipeline reports whether a command line is composed entirely of
// read-only units (joined by &&, ||, or ;) where every piece is a known
// non-code-executing, non-mutating command or a read-only Git source, with no
// opaque shell syntax. Such a line cannot hide or feed a commit, so it is not a
// "potential commit" for the unmodelled-prefix guard. This is how a developer
// reads a repository every day: `cd repo && git log | head`, `git status | grep`,
// `git diff | cat`. Fail-closed: any opaque lexeme, unlisted executable, missing
// executable, mutating Git subcommand, or a non-read-only command returns false.
// A read-only Git command may appear only as the source (first segment) of a
// pipeline, never as a later sink where stdin could drive a mutation.
function benignReadOnlyPipeline(command) {
    if (!command.includes('|') && !/[;&]/.test(command)) return false;
    if (containsOpaquePipeLexeme(command)) return false;
    const units = splitLogicalUnits(command);
    return units.every(benignReadOnlyUnit);
}

function pipedShellCommitInvocations(source, initialCwd) {
    const units = shellUnits(source);
    const commits = [];
    let cwd = initialCwd;
    const directoryStack = [];
    let subshellDepth = 0;
    let previousOperator = null;
    const persistentEnvironmentRisk = new Set();
    let targetUncertain = false;
    let pathDialectUncertain = false;
    const uncertainSyntax = hasUncertainShellSyntax(source);
    const commands = units.map((unit) => {
        const precedingOperator = previousOperator;
        previousOperator = unit.operator;
        const subshellState = shellSubshellState(unit.text);
        const unitInSubshell = subshellDepth > 0 || subshellState.opensSubshell;
        const directoryExecutionUncertain = unitInSubshell
            || uncertainSyntax
            || precedingOperator === '&&'
            || precedingOperator === '||';
        subshellDepth = Math.max(0, subshellDepth + subshellState.delta);
        const words = shellWords(unit.text.trim());
        updatePersistentEnvironment(words, persistentEnvironmentRisk);
        const parsedCommand = unwrapCommand(words, cwd);
        const environmentRisk = unique([
            ...persistentEnvironmentRisk,
            ...assignmentRiskNames(parsedCommand.assignments),
        ]);
        const commandCwd = parsedCommand.cwd;
        const commandTargetUncertain = targetUncertain || parsedCommand.targetUncertain;
        const commandPathDialectUncertain = pathDialectUncertain
            || parsedCommand.pathDialectUncertain;
        const tokens = parsedCommand.tokens;
        const directoryTokens = directoryCommandTokens(tokens);
        if (String(directoryTokens[0]).replace(/^[({]+/, '') === 'cd') {
            const args = directoryTokens.slice(1);
            const hasEndOfOptions = args[0] === '--';
            const positionals = hasEndOfOptions ? args.slice(1) : args;
            const path = positionals[0];
            const directoryEnvironmentRisk = assignmentRiskNames(parsedCommand.assignments)
                .some((name) => name === 'CDPATH' || name === 'HOME');
            if (unitInSubshell || parsedCommand.targetUncertain) {
                targetUncertain = true;
                pathDialectUncertain ||= shellPathIsAmbiguous(path);
            } else if (positionals.length !== 1
                || (!hasEndOfOptions && path?.startsWith('-'))
                || path === '-'
                || shellPathHasExpansion(path)) {
                targetUncertain = true;
            } else {
                cwd = resolveShellPath(cwd, path);
                targetUncertain ||= directoryExecutionUncertain
                    || directoryEnvironmentRisk
                    || cdpathMayRedirect(path)
                    || (unit.operator !== '&&' && unit.operator !== null);
                pathDialectUncertain ||= parsedCommand.pathDialectUncertain
                    || shellPathIsAmbiguous(path);
            }
        } else {
            if ((unitInSubshell || parsedCommand.targetUncertain)
                && ['pushd', 'popd'].includes(shellExecutable(directoryTokens[0]))) {
                targetUncertain = true;
                return {
                    ...parsedCommand,
                    cwd: commandCwd,
                    environmentRisk,
                    targetEnvironmentRisk: hasCrossTargetEnvironmentRisk(
                        environmentRisk,
                        parsedCommand.tokens[0],
                    ),
                    targetUncertain: commandTargetUncertain,
                    pathDialectUncertain: commandPathDialectUncertain,
                };
            }
            const stackChange = updateDirectoryStack(
                tokens,
                cwd,
                directoryStack,
                unit.operator,
            );
            if (stackChange) {
                cwd = stackChange.cwd;
                const directoryEnvironmentRisk = assignmentRiskNames(parsedCommand.assignments)
                    .some((name) => name === 'CDPATH' || name === 'HOME');
                targetUncertain ||= directoryExecutionUncertain
                    || stackChange.uncertain
                    || directoryEnvironmentRisk;
                pathDialectUncertain ||= stackChange.pathDialectUncertain;
            } else if (CURRENT_SHELL_MUTATORS.has(shellExecutable(tokens[0]))) {
                targetUncertain = true;
            }
        }
        return {
            ...parsedCommand,
            cwd: commandCwd,
            environmentRisk,
            targetEnvironmentRisk: hasCrossTargetEnvironmentRisk(
                environmentRisk,
                parsedCommand.tokens[0],
            ),
            targetUncertain: commandTargetUncertain,
            pathDialectUncertain: commandPathDialectUncertain,
        };
    });
    for (let start = 0; start < units.length;) {
        let end = start;
        while (units[end]?.operator === '|') end += 1;
        if (end > start && pipelineCommandConsumesCode(commands[end]?.tokens)) {
            const pipelineEnvironmentRisk = unique(commands
                .slice(start, end + 1)
                .flatMap((entry) => entry.environmentRisk));
            const pipelineTargetEnvironmentRisk = commands
                .slice(start, end + 1)
                .some((entry) => entry.targetEnvironmentRisk);
            for (let index = start; index < end; index++) {
                const payload = literalProducerPayload(commands[index].tokens);
                if (payload === null) continue;
                const details = literalCommitDetails(payload, commands[index].cwd);
                if (details) {
                    details.targetUncertain ||= commands[index].targetUncertain
                        || pipelineEnvironmentRisk.length > 0;
                    details.pathDialectUncertain ||= commands[index].pathDialectUncertain;
                    details.environmentRisk = pipelineEnvironmentRisk;
                    details.targetEnvironmentRisk = pipelineTargetEnvironmentRisk;
                    commits.push(details);
                }
            }
        }
        start = end + 1;
    }
    return commits;
}

function dynamicLiteralCommitInvocations(command, initialCwd) {
    const commits = [];
    const variable = /\$(?:[A-Za-z_@*]|[1-9])/;
    const variableExecution = (
        /(?:^|[;&\n])[^\S\n]*eval\b[^;&\n]*\$(?:[A-Za-z_][A-Za-z0-9_]*|[@*]|[1-9][0-9]*)/m.test(command)
        || command.split(/[;&\n]/).some((segment) => (
            inOrder(segment, [/\b(?:bash|dash|ksh|sh|zsh)\b/, /-[A-Za-z]*c/, variable])
        ))
        || inOrder(command, [/\bset\s+--/, /[;&\n][^\S\n]*["']?\$[@*]/])
    );
    if (variableExecution) {
        const details = literalCommitDetails(command, initialCwd);
        if (details) {
            details.targetUncertain = true;
            commits.push(details);
        }
    }

    // Where each name last starts a command, found in one pass, so a function
    // is known to be called after its body without rescanning the rest.
    const lastCall = new Map();
    for (const call of command.matchAll(/(?:^|[;&\n}])[^\S\n]*([A-Za-z_][A-Za-z0-9_]*)(?=\s|[;&]|$)/g)) {
        lastCall.set(call[1], call.index + call[0].length - call[1].length);
    }
    let targetChange;
    const definition = new RegExp(SHELL_FUNCTION, 'g');
    for (let match; (match = definition.exec(command));) {
        // The body ends at the first }. With none left, no later body can end.
        const close = command.indexOf('}', definition.lastIndex);
        if (close < 0) break;
        const body = command.slice(definition.lastIndex, close);
        definition.lastIndex = close + 1;
        if ((lastCall.get(match[1] ?? match[2]) ?? -1) < close) continue;
        const parsed = parseGit(body, initialCwd);
        for (const candidate of parsed.commands.filter((entry) => entry.verb === 'commit')) {
            targetChange ??= commandMayChangeShellTarget(command);
            commits.push({
                cwd: candidate.cwd,
                bypassHooks: candidate.bypassHooks || false,
                environmentRisk: candidate.environmentRisk || [],
                targetEnvironmentRisk: candidate.targetEnvironmentRisk || false,
                explicitTargetOption: candidate.explicitTargetOption || false,
                targetUncertain: candidate.targetUncertain || targetChange,
                pathDialectUncertain: candidate.pathDialectUncertain || false,
            });
        }
    }
    return commits;
}

// Whether the patterns occur in this order in text. Each search starts where
// the last one ended; one regex with [^;&\n]* between them was cubic.
function inOrder(text, patterns) {
    let rest = text;
    for (const pattern of patterns) {
        const found = pattern.exec(rest);
        if (!found) return false;
        rest = rest.slice(found.index + found[0].length);
    }
    return true;
}

function commandMayChangeShellTarget(command) {
    return /(?:^|[;&\n{}])[^\S\n]*(?:(?:builtin|command)\s+)?(?:(?:alias|autoload|cd|enable|eval|hash|popd|pushd|rehash|setopt|source|unalias|unfunction)\b|\.(?=\s|$))/m
        .test(String(command || ''));
}

function shellSubshellState(value) {
    let quote = '';
    let escaped = false;
    let depth = 0;
    let opensSubshell = false;
    for (const character of String(value || '')) {
        if (escaped) {
            escaped = false;
        } else if (character === '\\' && quote !== "'") {
            escaped = true;
        } else if (quote) {
            if (character === quote) quote = '';
        } else if (character === "'" || character === '"') {
            quote = character;
        } else if (character === '(') {
            depth += 1;
            opensSubshell = true;
        } else if (character === ')') {
            depth -= 1;
        }
    }
    return { delta: depth, opensSubshell };
}

function literalProducerPayload(tokens) {
    const executable = shellExecutable(tokens[0]);
    if (executable !== 'echo' && executable !== 'printf') return null;
    return tokens.slice(1).join(' ');
}

function shellReadsStandardInput(tokens) {
    const executable = shellExecutable(tokens[0]);
    if (!['bash', 'dash', 'ksh', 'sh', 'zsh'].includes(executable)) return false;
    let forceStdin = false;
    for (let index = 1; index < tokens.length; index++) {
        const option = tokens[index];
        if (option === '--') return forceStdin || index === tokens.length - 1;
        if (option === '-c' || /^-[^-]*c/.test(option)) return false;
        if (option === '-s' || /^-[^-]*s/.test(option)) {
            forceStdin = true;
            continue;
        }
        if (option === '-O' || option === '--rcfile') {
            index += 1;
            continue;
        }
        if (option.startsWith('-')) continue;
        return forceStdin;
    }
    return true;
}

function pipelineCommandConsumesCode(tokens) {
    // A trailing | has no command after it; the shell refuses the whole line.
    if (!tokens?.length) return false;
    if (shellReadsStandardInput(tokens)) return true;
    const nested = nestedShellPayload(tokens);
    if (nested === null) return false;
    const units = shellUnits(nested);
    if (units.length === 1) return shellReadsStandardInput(shellWords(units[0].text.trim()));
    const last = shellWords(units.at(-1).text.trim());
    if (!shellReadsStandardInput(last)) return false;
    const first = shellExecutable(shellWords(units[0].text.trim())[0]);
    return STDIN_RELAYS.has(first);
}

const STDIN_RELAYS = new Set(['awk', 'cat', 'grep', 'head', 'sed', 'tail', 'tee', 'tr']);

export function shellExecutable(value) {
    return basename(String(value || '').replace(/^[({]+/, '').replace(/[)}]+$/, ''))
        .toLowerCase()
        .replace(/\.exe$/, '');
}

// Tilde-user and directory-stack forms need shell state that Node cannot infer.
// Git Bash also maps /tmp and /c/... through its MSYS mount table and expands
// all tilde targets from shell state that may differ from Node. Reject those
// guarded targets rather than inspect the wrong repository and policy.
export function shellPathIsAmbiguous(path, platform = process.platform) {
    const value = String(path || '');
    // Quote provenance is intentionally not retained by the tokenizer. A
    // leading tilde may therefore be shell-expanded or literal, and resolving
    // it here would risk choosing the wrong repository on every platform.
    if (value.startsWith('~')) return true;
    // POSIX leaves exactly two leading slashes implementation-defined, while
    // node:path normalizes them to one on POSIX hosts.
    if (platform !== 'win32' && /^\/\/(?:[^/]|$)/.test(value)) return true;
    if (platform !== 'win32') return false;
    // `C:repo` is drive-relative, not absolute. Its meaning depends on the
    // process's hidden per-drive cwd, which may differ between Node and MSYS.
    if (/^[A-Za-z]:(?![\\/])/.test(value)) return true;
    // A valid UNC target needs both server and share components. Incomplete
    // forms can be normalized differently by Node, MSYS, and native Git.
    const uncValue = value.replace(/\\/g, '/');
    if (/^\/\//.test(uncValue) && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(uncValue)) return true;
    return /^(?:\/(?!\/)|\/{3,})/.test(value);
}

function shellPathHasExpansion(path) {
    return /[$`*?\[\]{}]/.test(String(path || ''));
}

function cdpathMayRedirect(path) {
    const value = String(path || '');
    return Boolean(process.env.CDPATH)
        && value.length > 0
        && !isAbsolute(value)
        && !/^\.\.?(?:[\\/]|$)/.test(value)
        && !value.startsWith('~');
}

function resolveShellPath(cwd, path) {
    if (!path || path === '~') return homedir();
    if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
    return resolve(cwd, path);
}

function unwrapCommand(input, initialCwd) {
    if (prefixChainTooLong(input)) {
        return {
            tokens: [],
            assignments: [],
            cwd: initialCwd,
            uncertain: true,
            pathDialectUncertain: false,
            targetUncertain: true,
            explicitTargetOption: false,
        };
    }
    const toks = [...input];
    const assignments = [];
    let cwd = initialCwd;
    let uncertain = false;
    let pathDialectUncertain = false;
    let targetUncertain = false;
    let explicitTargetOption = false;
    const stripAssignments = () => {
        while (isAssignment(toks[0])) assignments.push(toks.shift());
    };
    const stripPrecommands = () => {
        for (; ;) {
            if (toks[0] === '-' || toks[0] === 'nocorrect' || toks[0] === 'noglob') {
                toks.shift();
            } else if (toks[0] === 'coproc') {
                toks.shift();
                targetUncertain = true;
            } else if (toks[0] === 'builtin') {
                toks.shift();
                if (toks[0] === '--') toks.shift();
            } else if (toks[0] === 'repeat' && toks.length > 1) {
                toks.splice(0, 2);
                targetUncertain = true;
            } else {
                break;
            }
            uncertain = true;
            stripAssignments();
        }
    };
    stripAssignments();
    stripPrecommands();
    while (toks[0] === 'command' || shellExecutable(toks[0]) === 'env' || toks[0] === 'exec') {
        const wrapperToken = toks.shift();
        const wrapper = shellExecutable(wrapperToken);
        if (wrapper === 'env' && wrapperToken !== 'env') {
            // Pathed/env.exe wrappers are executable indirection, not a shell
            // builtin identity the parser can authenticate.
            uncertain = true;
            targetUncertain = true;
        }
        if (wrapper === 'command') {
            while (toks[0]?.startsWith('-')) {
                if (toks[0] === '--') {
                    toks.shift();
                    break;
                }
                if (toks[0] === '-v' || toks[0] === '-V') {
                    toks.length = 0;
                    break;
                }
                uncertain = true;
                toks.shift();
            }
        } else if (wrapper === 'exec') {
            if (toks[0] === '--') toks.shift();
            while (toks[0]?.startsWith('-')) {
                uncertain = true;
                if (toks[0] === '-a' && toks[1]) toks.splice(0, 2);
                else toks.shift();
            }
        } else {
            while (toks.length) {
                if (toks[0] === '-u' || toks[0] === '--unset') {
                    if (toks[1]) assignments.push(`${toks[1]}=<unset>`);
                    toks.splice(0, Math.min(2, toks.length));
                } else if (toks[0].startsWith('-u') && toks[0].length > 2) {
                    assignments.push(`${toks[0].slice(2)}=<unset>`);
                    toks.shift();
                } else if (toks[0].startsWith('--unset=')) {
                    assignments.push(`${toks[0].slice('--unset='.length)}=<unset>`);
                    toks.shift();
                } else if (toks[0] === '-C' || toks[0] === '--chdir') {
                    explicitTargetOption = true;
                    if (!toks[1]) {
                        uncertain = true;
                        toks.shift();
                    } else {
                        targetUncertain ||= shellPathHasExpansion(toks[1]);
                        pathDialectUncertain ||= shellPathIsAmbiguous(toks[1]);
                        cwd = resolveShellPath(cwd, toks[1]);
                        toks.splice(0, 2);
                    }
                } else if (toks[0].startsWith('--chdir=')) {
                    explicitTargetOption = true;
                    const target = toks[0].slice('--chdir='.length);
                    targetUncertain ||= shellPathHasExpansion(target);
                    pathDialectUncertain ||= shellPathIsAmbiguous(target);
                    cwd = resolveShellPath(cwd, target);
                    toks.shift();
                } else if (toks[0].startsWith('-C') && toks[0].length > 2) {
                    explicitTargetOption = true;
                    const target = toks[0].slice(2);
                    targetUncertain ||= shellPathHasExpansion(target);
                    pathDialectUncertain ||= shellPathIsAmbiguous(target);
                    cwd = resolveShellPath(cwd, target);
                    toks.shift();
                } else if (toks[0] === '-P') {
                    uncertain = true;
                    toks.splice(0, Math.min(2, toks.length));
                } else if (toks[0] === '-S' || toks[0] === '--split-string') {
                    const payload = toks[1];
                    toks.splice(0, Math.min(2, toks.length), ...shellWords(payload || ''));
                    uncertain = true;
                    break;
                } else if (toks[0].startsWith('--split-string=')) {
                    const payload = toks.shift().slice('--split-string='.length);
                    toks.unshift(...shellWords(payload));
                    uncertain = true;
                    break;
                } else if (/^-S.+/.test(toks[0])) {
                    const payload = toks.shift().slice(2);
                    toks.unshift(...shellWords(payload));
                    uncertain = true;
                    break;
                } else if (['-i', '--ignore-environment'].includes(toks[0])) {
                    uncertain = true;
                    toks.shift();
                } else if (['-0', '--null', '-v', '--debug'].includes(toks[0])) {
                    toks.shift();
                } else if (toks[0].startsWith('-')) {
                    uncertain = true;
                    toks.shift();
                }
                else if (isAssignment(toks[0])) assignments.push(toks.shift());
                else break;
            }
        }
        stripAssignments();
        stripPrecommands();
    }
    return {
        tokens: toks,
        assignments,
        cwd,
        uncertain,
        pathDialectUncertain,
        targetUncertain,
        explicitTargetOption,
    };
}

function possibleGitCommit(words) {
    const fragments = words.flatMap((word) => word.split(/\s+/).filter(Boolean));
    const git = fragments.findIndex((word) => isGitExecutable(word.replace(/^\(+/, '')));
    return git >= 0 && fragments.slice(git + 1).includes('commit');
}

const INDIRECT_EXECUTORS = new Set([
    'busybox', 'call', 'chrt', 'cmd', 'doas', 'eval', 'find', 'ionice', 'nice',
    'nohup', 'parallel', 'powershell', 'pwsh', 'setsid', 'start', 'start-process',
    'stdbuf', 'sudo', 'time', 'timeout', 'watch', 'wsl', 'xargs',
    'iex', 'invoke-expression',
    // Local process wrappers whose visible command may invoke Git. Remote and
    // container drivers (ssh, docker, podman) are intentionally excluded: they
    // run Git in a repository where this local guard has no jurisdiction. The
    // cwd/namespace-changing subset below fails closed before policy lookup.
    'su', 'pkexec', 'runuser', 'gosu', 'su-exec',
    'strace', 'ltrace', 'valgrind', 'perf', 'gdb', 'taskset', 'numactl', 'prlimit',
    'firejail', 'bwrap', 'chroot', 'unshare', 'nsenter', 'setpriv',
    'torsocks', 'tsocks', 'proxychains', 'proxychains4',
    'systemd-run', 'faketime', 'script',
]);

// Programs that print, search or describe text: a git among their words is
// data, as in echo git push --no-verify or grep -r 'git commit' src.
const NON_EXECUTING_COMMANDS = new Set([
    ...READ_ONLY_SHELL_COMMANDS,
    'ack', 'ag', 'apropos', 'cat', 'cmp', 'column', 'cut', 'diff', 'egrep', 'fgrep', 'fold',
    'grep', 'head', 'help', 'info', 'jq', 'less', 'man', 'more', 'nl', 'rg', 'sort', 'tail',
    'tee', 'tr', 'type', 'uniq', 'wc', 'whatis', 'whereis', 'which', 'yq',
]);

// Programs that run their command on another machine or in a container, a
// repository this guard does not answer for.
const REMOTE_COMMAND_DRIVERS = new Set([
    'colima', 'docker', 'kubectl', 'lima', 'limactl', 'mosh', 'multipass', 'nerdctl', 'podman',
    'ssh', 'vagrant',
]);

// These wrappers can evaluate command text, change cwd, or enter another
// filesystem namespace before Git starts. Their target cannot be authenticated
// from the caller's repository, even when a literal `git commit` is visible.
const UNCERTAIN_TARGET_INDIRECT_EXECUTORS = new Set([
    'busybox', 'bwrap', 'call', 'chroot', 'cmd', 'find', 'firejail',
    'gdb', 'iex', 'invoke-expression', 'nsenter', 'parallel', 'powershell',
    'pwsh', 'runuser', 'script', 'start', 'start-process', 'su', 'sudo',
    'systemd-run', 'unshare', 'watch', 'wsl', 'xargs',
]);

// Passthrough prefixes exec the inner command verbatim: the same argv, the same
// cwd, the same target. `time`, `timeout`, `nice`, `ionice` and friends only
// measure or schedule — they cannot inject a flag, rewrite the command line, or
// hide a --no-verify the way eval/sudo/bash -c can. An indirect commit seen
// through one of these is therefore treated as direct, so `time git commit` is
// judged like `git commit` instead of being refused as opaque indirection. The
// carve-out only applies when nothing else is risky (no environment override,
// no uncertain target); otherwise the wrapper falls back to the closed path.
// Prefixes that run the next command with the same argv: the options of
// theirs that take a separate value, and how many operands come before it.
const PASSTHROUGH_PREFIXES = new Map([
    ['time', { values: ['-f', '--format', '-o', '--output'], operands: 0 }],
    ['timeout', { values: ['-s', '--signal', '-k', '--kill-after'], operands: 1 }],
    ['nice', { values: ['-n', '--adjustment'], operands: 0 }],
    ['ionice', { values: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'], operands: 0 }],
    ['chrt', { values: [], operands: 1 }],
    ['taskset', { values: [], operands: 1 }],
    ['numactl', { values: ['-N', '-m', '-C', '-p', '-i'], operands: 0 }],
    ['stdbuf', { values: ['-i', '-o', '-e'], operands: 0 }],
    ['setsid', { values: [], operands: 0 }],
    ['nohup', { values: [], operands: 0 }],
    ['prlimit', { values: ['-p', '--pid'], operands: 0 }],
    ['faketime', { values: ['-m', '-f'], operands: 1 }],
    // sudo and doas run the same argv as another user, whose Git config and
    // hooks need not be this repository's, so the target counts as uncertain.
    ['sudo', {
        values: [
            '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
            '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout',
            '-U', '--other-user', '-R', '--chroot',
        ],
        operands: 0,
        otherUser: true,
    }],
    ['doas', { values: ['-u', '-C'], operands: 0, otherUser: true }],
]);
const PASSTHROUGH_PREFIX_EXECUTORS = new Set(PASSTHROUGH_PREFIXES.keys());
const MAX_PREFIXED_WORDS = 4096;
const PREFIX_WORDS = new Set([
    ...PASSTHROUGH_PREFIX_EXECUTORS, '-', 'builtin', 'command', 'coproc', 'env', 'exec', 'nocorrect', 'noglob', 'repeat',
]);

function prefixChainTooLong(words) {
    return words.length > MAX_PREFIXED_WORDS
        && (isAssignment(words[0]) || PREFIX_WORDS.has(words[0]) || PREFIX_WORDS.has(shellExecutable(words[0])));
}

// The command a passthrough prefix runs: what follows the prefix's own
// options, the values they take and its operands (timeout's duration).
function passthroughTarget(tokens) {
    const prefix = PASSTHROUGH_PREFIXES.get(shellExecutable(tokens[0]));
    if (!prefix) return null;
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '-') {
        if (tokens[i] === '--') {
            i += 1;
            break;
        }
        i += prefix.values.includes(tokens[i]) ? 2 : 1;
    }
    i += prefix.operands;
    return i < tokens.length ? tokens.slice(i) : null;
}

function indirectCommitInvocation(words, initialCwd) {
    if (!words.length) return false;
    const executable = shellExecutable(words[0]);
    const dynamicExecutable = /[$`]/.test(words[0]);
    if (!dynamicExecutable && !INDIRECT_EXECUTORS.has(executable)) return null;
    const targetUncertain = UNCERTAIN_TARGET_INDIRECT_EXECUTORS.has(executable)
        || dynamicExecutable;
    const details = indirectCommitDetails(words, initialCwd, targetUncertain)
        || literalCommitDetails(words.slice(1).join(' '), initialCwd);
    if (details && targetUncertain) details.targetUncertain = true;
    return details;
}

// Recognized eval flags per interpreter: flags that take a code string to
// evaluate. The original set (python/node/perl/ruby/php) is extended with other
// common interpreters an agent could use to wrap a commit.
const INTERPRETER_EVAL_OPTIONS = new Map([
    ['node', ['-e', '--eval', '-p', '--print']],
    ['nodejs', ['-e', '--eval', '-p', '--print']],
    ['perl', ['-e']],
    ['ruby', ['-e']],
    ['php', ['-r']],
    ['lua', ['-e']],
    ['luajit', ['-e']],
    ['rscript', ['-e']],
    ['r', ['-e']],
    ['expect', ['-c']],
    ['julia', ['-e']],
    ['groovy', ['-e']],
    ['elixir', ['-e']],
    ['erl', ['-eval']],
    ['swipl', ['-g', '-t']],
    ['guile', ['-c']],
    ['sbcl', ['--eval']],
    // GNU make reads --eval as makefile text, whose recipes run in a shell.
    ['make', ['--eval', '-E']],
    ['gmake', ['--eval', '-E']],
]);

// evalFlagCode finds the code string that follows a recognized eval-style flag
// (and the remaining tokens after it), mirroring Git/POSIX short/long/joined
// option forms. Returns null when no such flag is present.
function evalFlagCode(words, options) {
    for (let index = 1; index < words.length; index++) {
        if (options.includes(words[index]) && typeof words[index + 1] === 'string') {
            return { code: words[index + 1], rest: words.slice(index + 2) };
        }
        const longOption = options.find((candidate) => (
            candidate.startsWith('--') && words[index].startsWith(`${candidate}=`)
        ));
        if (longOption) {
            return { code: words[index].slice(longOption.length + 1), rest: words.slice(index + 1) };
        }
        const shortOption = options.find((candidate) => (
            candidate.length === 2 && words[index].startsWith(candidate) && words[index].length > 2
        ));
        if (shortOption) {
            return { code: words[index].slice(shortOption.length), rest: words.slice(index + 1) };
        }
    }
    return null;
}

// Programs whose -e/-c/-r argument is a pattern or script text, NOT executed
// code. Used to keep the generic eval-flag fallback from false-positiving on
// commands like `grep -e "system git commit"`.
const NON_EXECUTING_EVAL_PROGRAMS = new Set([
    'grep', 'egrep', 'fgrep', 'rg', 'sed', 'ack', 'git', 'find', 'cat', 'echo', 'printf',
]);

function interpretedCommitInvocation(words, initialCwd) {
    const found = interpreterCode(words);
    if (!found) return null;
    return literalCommitDetails(found.code, initialCwd)
        || interpretedArgumentCommitInvocation(found.code, found.rest, initialCwd);
}

// The code an interpreter runs from its command line, with the words after it,
// or null.
function interpreterCode(words) {
    if (!words.length) return null;
    const executable = shellExecutable(words[0]);

    const options = /^python(?:\d+(?:\.\d+)*)?$/.test(executable) ? ['-c']
        : INTERPRETER_EVAL_OPTIONS.get(executable);
    if (options) {
        const found = evalFlagCode(words, options);
        if (found) return found;
    }

    // awk family: the program is the first positional argument (often quoted),
    // not a flag, and it IS evaluated (system()/getline pipe can run commands).
    if (['awk', 'gawk', 'mawk', 'nawk'].includes(executable)) {
        let skippingValue = false;
        for (let index = 1; index < words.length; index++) {
            const arg = words[index];
            if (skippingValue) { skippingValue = false; continue; }
            if (arg === '--') {
                const program = words[index + 1];
                return program ? { code: program, rest: [] } : null;
            }
            if (/^-[Ffv]/.test(arg) && arg.length === 2) { skippingValue = true; continue; }
            if (arg.startsWith('-')) continue;
            return { code: arg, rest: [] };
        }
    }

    // Generic fallback: an unrecognized <prog> <eval-flag> <code> whose code
    // executes something. Catches future interpreters (janet, deno --eval,
    // bun -e) without enumerating each. The execution-indicator requirement +
    // non-executing denylist avoids false positives such as `grep -e "git commit"`.
    if (!NON_EXECUTING_EVAL_PROGRAMS.has(executable)) {
        const generic = evalFlagCode(words, ['-e', '-c', '--eval', '--exec', '-p', '--print', '-r']);
        if (generic && /\b(?:argv|child_process|exec|popen|spawn|subprocess|system)\b/.test(generic.code)) return generic;
    }

    return null;
}

// Code that can start a process: a system, exec, spawn or popen call, Python's
// subprocess, Node's child_process, Perl's qx and pipe open, awk's getline,
// and the backtick and %x of Ruby and Perl. print('git push') starts nothing.
const CODE_RUNS_COMMANDS = /\b(?:child_process|exec\w*|getline|open|popen|qx|spawn\w*|subprocess|system)\b|`|%x/;

// Programs whose code is shell commands outright, such as a make recipe.
const SHELL_CODE_PROGRAMS = new Set(['gmake', 'make']);

// Subcommands of yarn and pnpm that are not a package.json script.
const PACKAGE_MANAGER_COMMANDS = new Set([
    'add', 'audit', 'bin', 'cache', 'config', 'create', 'dlx', 'exec', 'global', 'help', 'i',
    'import', 'info', 'init', 'install', 'licenses', 'link', 'list', 'login', 'logout', 'ls',
    'outdated', 'owner', 'pack', 'prune', 'publish', 'rebuild', 'remove', 'rm', 'root', 'store',
    'unlink', 'up', 'update', 'upgrade', 'version', 'why', 'workspace', 'workspaces',
]);

// Programs that run what they are given as code: the shells, the interpreters
// with a code option, and the tools whose program or recipe is a file or a
// command line, as make, awk and sed.
const OTHER_CODE_READERS = new Set([
    'fish', 'csh', 'tcsh', 'nu', 'elvish', 'pwsh', 'powershell', 'deno', 'bun', 'tclsh', 'osascript',
    'awk', 'gawk', 'mawk', 'nawk', 'sed',
]);

function isCodeReader(program) {
    return WRAPPED_SHELLS.has(program) || OTHER_CODE_READERS.has(program)
        || /^python(?:\d+(?:\.\d+)*)?$/.test(program) || INTERPRETER_EVAL_OPTIONS.has(program);
}

// A shell or interpreter started with no code on its command line and no script
// file reads the code from its input: sh, bash -s, python3 -, node -.
function readsStdinAsCode(tokens) {
    const program = shellExecutable(tokens[0]);
    if (!isCodeReader(program) || program === 'make' || program === 'gmake' || OTHER_CODE_READERS.has(program)) return false;
    const args = tokens.slice(1);
    const evalOptions = INTERPRETER_EVAL_OPTIONS.get(program) ?? ['-c'];
    if (args.some((arg) => evalOptions.includes(arg) || (WRAPPED_SHELLS.has(program) && /^-[a-zA-Z]*c/.test(arg)))) return false;
    return !args.some((arg) => arg !== '-' && !arg.startsWith('-'));
}

// The text an echo or printf unit prints, or null. printf, and the echo of zsh
// and sh -e, turn \n and \t into a newline and a tab; a recipe line of a makefile
// needs the tab.
function printedText(tokens) {
    const program = shellExecutable(tokens[0]);
    if (program !== 'echo' && program !== 'printf') return null;
    const end = tokens.findIndex((word, index) => index > 0 && /^[0-9&]*>/.test(word));
    const words = tokens.slice(1, end < 0 ? undefined : end);
    return (program === 'printf' ? words.join('\n') : words.join(' ')).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// A path as one place on disk, for telling a file the line writes from the file
// it runs: relative to where the unit runs, and no ./ or // in it.
function placeOf(cwd, path) {
    return resolve(cwd, posix.normalize(String(path).replace(/\\/g, '/')));
}

// The script an echo or printf unit writes to a file, or tee writes after one in
// a pipe: the file is not on disk yet for the guard to read, but its text is in
// the line. Returns the places written and the text.
function writtenScript(tokens, source, cwd, pipedText) {
    const targets = shellExecutable(tokens[0]) === 'tee' && pipedText !== null
        ? tokens.slice(1).filter((word) => !word.startsWith('-'))
        : redirectTargets(source);
    const text = pipedText !== null && shellExecutable(tokens[0]) === 'tee' ? pipedText : printedText(tokens);
    const places = targets.filter((target) => target && !target.startsWith('/dev/')).map((target) => placeOf(cwd, target));
    return text !== null && places.length ? { paths: places, text } : null;
}

// What a script that was written earlier in the same line will hold.
function inlineScriptTexts(script, writtenFiles, cwd) {
    if (!writtenFiles.size) return [];
    const paths = script.kind === 'files' ? script.paths : script.kind === 'package' ? ['package.json'] : [];
    return paths.map((path) => writtenFiles.get(placeOf(cwd, path))).filter(Boolean);
}

// The file a command runs shell text from, for the guard to read: the
// makefiles of make, the package.json script npm, yarn, pnpm or bun runs, a
// script handed to a shell or to source, or an executable run by its path.
// An agent can write such a file with an editor tool this guard never sees.
function executedScript(tokens) {
    const program = shellExecutable(tokens[0]);
    const args = tokens.slice(1);
    if (program === 'make' || program === 'gmake') {
        const paths = [];
        for (let i = 0; i < args.length; i += 1) {
            if (['-f', '--file', '--makefile'].includes(args[i]) && args[i + 1]) paths.push(args[++i]);
            else if (/^--(?:file|makefile)=/.test(args[i])) paths.push(args[i].slice(args[i].indexOf('=') + 1));
            else if (/^-f./.test(args[i])) paths.push(args[i].slice(2));
        }
        return { kind: 'files', paths: paths.length ? paths : ['GNUmakefile', 'makefile', 'Makefile'], label: program };
    }
    if (['bun', 'npm', 'pnpm', 'yarn'].includes(program)) {
        const words = args.filter((word) => !word.startsWith('-'));
        let name = null;
        if (['run', 'run-script', 'rum', 'urn'].includes(words[0])) name = words[1] ?? null;
        else if (program !== 'bun' && ['test', 'start', 'stop', 'restart', 't', 'tst'].includes(words[0])) {
            name = ['t', 'tst'].includes(words[0]) ? 'test' : words[0];
        } else if ((program === 'yarn' || program === 'pnpm') && words[0] && !PACKAGE_MANAGER_COMMANDS.has(words[0])) {
            name = words[0];
        }
        return name ? { kind: 'package', name, label: `${program} ${name}` } : null;
    }
    if (WRAPPED_SHELLS.has(program) || program === 'source' || program === '.') {
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--') return args[i + 1] ? { kind: 'files', paths: [args[i + 1]], label: `${program} ${args[i + 1]}` } : null;
            if (['-O', '-o', '--init-file', '--rcfile'].includes(args[i])) i += 1;
            else if (!args[i].startsWith('-') || args[i] === '-') {
                return args[i] === '-' ? null : { kind: 'files', paths: [args[i]], label: `${program} ${args[i]}` };
            }
        }
        return null;
    }
    return String(tokens[0] ?? '').includes('/') ? { kind: 'files', paths: [tokens[0]], shebang: true, label: tokens[0] } : null;
}

// The Git commands a program's code spells: the words after each git, read
// once with the quotes that join string literals taken out ('core.hooks''Path',
// 'comm''it') and once with every quote as a separator (['git','push']). Code
// that builds a word at run time ('--no-ver' + 'ify', a decoded string) is not
// seen; strict refuses a commit there, and CI stays the backstop.
function embeddedGitTexts(code) {
    const texts = [];
    for (const view of [code.replace(/['"`]/g, ''), code.replace(/['"`]/g, ' ')]) {
        const fragments = view.split(/[\s,;()[\]{}+]+/).filter(Boolean);
        for (let at = 0; at < fragments.length; at += 1) {
            if (!isGitExecutable(fragments[at])) continue;
            const words = ['git'];
            for (let next = at + 1; next < fragments.length && words.length < 64; next += 1) {
                if (/^(?:&&|\|\||\||&)$/.test(fragments[next]) || isGitExecutable(fragments[next])) break;
                words.push(fragments[next]);
            }
            texts.push(words.map(quoteShellWord).join(' '));
        }
    }
    return texts;
}

function interpretedArgumentCommitInvocation(code, args, initialCwd) {
    if (!/\b(?:argv|child_process|exec|popen|spawn|subprocess|system)\b/.test(code)) return null;
    return literalCommitDetails(args.join(' '), initialCwd);
}

function literalCommitDetails(value, initialCwd) {
    const fragments = String(value || '')
        .split(/[\s'"`,;()[\]{}]+/)
        .filter(Boolean);
    return indirectCommitDetails(['literal', ...fragments], initialCwd, true);
}

function indirectCommitDetails(words, initialCwd, allowImplicitGit = false) {
    const fragments = words.slice(1).flatMap((word) => word.split(/\s+/).filter(Boolean));
    const commit = fragments.findIndex((word) => /^commit(?:[\s,]|$)/.test(word));
    if (commit < 0) return null;
    const git = fragments.findIndex((word, index) => (
        index < commit && isGitExecutable(word.replace(/^\(+/, '').replace(/\)+$/, ''))
    ));
    if (git < 0 && !allowImplicitGit) return null;
    let cwd = initialCwd;
    let targetUncertain = git < 0;
    let pathDialectUncertain = false;
    let explicitTargetOption = false;
    let forceTargetUncertain = false;
    const beforeCommit = fragments.slice(0, commit);
    const env = beforeCommit.findIndex((candidate, index) => (
        index < git && shellExecutable(candidate.replace(/^\(+/, '')) === 'env'
    ));
    for (let index = 0; index < beforeCommit.length; index++) {
        const word = beforeCommit[index].replace(/^\(+/, '');
        let path = null;
        if (word === 'cd' && beforeCommit[index + 1]) {
            path = beforeCommit[++index].replace(/\)+$/, '');
        } else if (
            env >= 0
            && index > env
            && index < git
            && (word === '-C' || word === '--chdir')
            && beforeCommit[index + 1]
        ) {
            explicitTargetOption = true;
            path = beforeCommit[++index].replace(/\)+$/, '');
        } else if (env >= 0 && index > env && index < git && word.startsWith('--chdir=')) {
            explicitTargetOption = true;
            path = word.slice('--chdir='.length).replace(/\)+$/, '');
        } else if (env >= 0 && index > env && index < git && word.startsWith('-C') && word.length > 2) {
            explicitTargetOption = true;
            path = word.slice(2).replace(/\)+$/, '');
        } else if (index > git && word === '-C' && beforeCommit[index + 1]) {
            explicitTargetOption = true;
            path = beforeCommit[++index].replace(/\)+$/, '');
        } else if (index > git && word.startsWith('-C') && word.length > 2) {
            explicitTargetOption = true;
            path = word.slice(2).replace(/\)+$/, '');
        } else if (index > git && (
            word === '--git-dir'
            || word === '--work-tree'
        ) && beforeCommit[index + 1]) {
            explicitTargetOption = true;
            forceTargetUncertain = true;
            index += 1;
        } else if (index > git && (
            word.startsWith('--git-dir=')
            || word.startsWith('--work-tree=')
        )) {
            explicitTargetOption = true;
            forceTargetUncertain = true;
        }
        if (path === null) continue;
        if (shellPathHasExpansion(path)) {
            targetUncertain = true;
            continue;
        }
        pathDialectUncertain ||= shellPathIsAmbiguous(path);
        cwd = resolveShellPath(cwd, path);
    }
    return {
        cwd,
        targetUncertain: targetUncertain || forceTargetUncertain,
        pathDialectUncertain,
        explicitTargetOption,
    };
}

function isAssignment(token) {
    return typeof token === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function updatePersistentEnvironment(words, risks) {
    if (!words.length) return true;
    if (words.every(isAssignment)) {
        for (const name of assignmentRiskNames(words)) risks.add(name);
        return true;
    }
    if (['declare', 'export', 'local', 'readonly', 'typeset'].includes(words[0])) {
        const declarations = words.slice(1).flatMap((word) => {
            if (isAssignment(word)) return [word];
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return [`${word}=<declared>`];
            return [];
        });
        for (const name of assignmentRiskNames(declarations)) risks.add(name);
        return true;
    }
    if (words[0] === 'unset') {
        for (const name of words.slice(1).filter((word) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(word))) {
            for (const risk of assignmentRiskNames([`${name}=<unset>`])) risks.add(risk);
        }
        return true;
    }
    return false;
}

// An assignment that can inject arbitrary Git config can set core.hooksPath, so
// it can remove every managed hook. Named at the key level so both the
// assignment list and the already-computed risk names can ask the same question.
function gitConfigEnvName(key) {
    if (key === 'GIT_CONFIG_PARAMETERS' || key === 'GIT_CONFIG_COUNT') return true;
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) return true;
    if ([
        'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
    ].includes(key)) return true;
    return ['HOME', 'XDG_CONFIG_HOME'].includes(key);
}

function gitConfigAssignmentsBypass(assignments) {
    return assignments.some((assignment) => {
        const separator = assignment.indexOf('=');
        return gitConfigEnvName(assignment.slice(0, separator).toUpperCase());
    });
}

const RUNTIME_ASSIGNMENTS = new Set([
    'BASH_ENV', 'CDPATH', 'ENV', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
    'EDITOR', 'GIT_DIR', 'GIT_EDITOR', 'GIT_EXEC_PATH', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_SEQUENCE_EDITOR', 'GIT_WORK_TREE', 'IFS',
    'LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'NODE_PATH',
    'NODE_REPL_EXTERNAL_MODULE', 'PATH', 'SHELLOPTS', 'VISUAL', 'ZDOTDIR',
]);

const CROSS_TARGET_ASSIGNMENTS = new Set([
    'BASH_ENV', 'CDPATH', 'ENV', 'GIT_COMMON_DIR', 'GIT_DIR', 'GIT_EXEC_PATH',
    'GIT_WORK_TREE', 'HOME', 'ZDOTDIR',
    'LD_LIBRARY_PATH', 'LD_PRELOAD',
]);

function hasCrossTargetEnvironmentRisk(names, executable) {
    return names.some((name) => (
        CROSS_TARGET_ASSIGNMENTS.has(name)
        || name.startsWith('DYLD_')
        || (name === 'PATH' && canResolveGitAlias(executable))
    ));
}

function assignmentRiskNames(assignments) {
    const risky = [];
    for (const assignment of assignments) {
        const separator = assignment.indexOf('=');
        const key = assignment.slice(0, separator).toUpperCase();
        if (
            RUNTIME_ASSIGNMENTS.has(key)
            || key.startsWith('DYLD_')
            || gitConfigAssignmentsBypass([assignment])
        ) risky.push(key);
    }
    return unique(risky);
}

export function unique(values) {
    return [...new Set(values)];
}

// Minimal shell tokenizer for recognizing Git commands without executing or
// expanding them. It preserves whitespace inside quotes and handles ordinary
// backslash escapes; shell expansion remains intentionally out of scope.
// limit stops it early for a caller that needs only the first words.
export function shellWords(s, limit = Infinity) {
    const out = [];
    let word = '';
    let started = false;
    let quote = '';
    let escaped = false;
    for (const c of s) {
        if (escaped) {
            // A backslash-newline outside single quotes is a shell line
            // continuation: drop both characters instead of folding the newline
            // into the word. Folding it would split a flag/config key (e.g.
            // `--no-\<LF>verify` or `core.hook\<LF>sPath`) and hide a bypass.
            if (c === '\n') {
                escaped = false;
            } else {
                // Inside double quotes, POSIX shells preserve a backslash
                // unless it escapes $, `, ", or another backslash. Keeping it
                // here is load-bearing for native Windows target paths.
                if (quote === '"' && !['$', '`', '"', '\\'].includes(c)) word += '\\';
                word += c;
                started = true;
                escaped = false;
            }
        } else if (c === '\\' && quote !== "'") {
            started = true;
            escaped = true;
        } else if (quote) {
            if (c === quote) quote = '';
            else {
                word += c;
                started = true;
            }
        } else if (c === "'" || c === '"') {
            started = true;
            quote = c;
        } else if (/\s/.test(c)) {
            if (started) {
                out.push(word);
                if (out.length >= limit) return out;
                word = '';
                started = false;
            }
        } else {
            word += c;
            started = true;
        }
    }
    if (escaped) {
        word += '\\';
        started = true;
    }
    if (started) out.push(word);
    return out;
}
