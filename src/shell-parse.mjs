// shell-parse implements the static shell-command analysis behind the
// PreToolUse guard: a non-executing tokenizer, cd/pushd/directory-stack
// tracking, and classification of Git invocations (commits, staged paths,
// ref mutations, hook bypasses, read-only pipelines). Pure string/command
// analysis only: nothing here touches a repository, policy, or output.
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

// parseGit inspects a shell command line for staged-path, commit, policy-transition,
// and branch/reference operations that need an agent-side guard decision.
export function parseGit(cmd, initialCwd = process.cwd()) {
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
    let shellCwd = initialCwd;
    const directoryStack = [];
    let subshellDepth = 0;
    let previousOperator = null;
    let shellTargetUncertain = false;
    let shellPathDialectUncertain = false;
    const definesShellFunction = /(?:^|[;&\n])\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{/.test(cmd);
    const persistentEnvironmentRisk = new Set();
    let prefixRisk = false;
    let prefixIndexMutationRisk = false;
    let prefixHooksRisk = false;
    let policyTransitionRisk = false;
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
        const control = unwrapShellControl(shellWords(unit.text.trim()));
        const words = control.tokens;
        uncertainShell ||= control.uncertain;
        if (updatePersistentEnvironment(words, persistentEnvironmentRisk)) continue;
        const unwrapped = unwrapCommand(words, shellCwd);
        const toks = unwrapped.tokens;
        uncertainShell ||= unwrapped.uncertain;
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
            addPaths.push(...parsed.addPaths);
            commands.push(...parsed.commands.map((candidate) => ({
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
            })));
            sawAdd ||= parsed.addPaths.length > 0;
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
        if (SHELL_CONTROL_DECLARATIONS.has(toks[0])) continue;
        if (toks.length < 2) {
            if (toks.length && !READ_ONLY_SHELL_COMMANDS.has(basename(toks[0]))) {
                prefixIndexMutationRisk ||= commandMayReplaceIndex(toks, unit.text);
                prefixHooksRisk ||= commandMayTouchHooks(toks, unit.text);
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
        if (!isGitExecutable(g0)) {
            if (CURRENT_SHELL_MUTATORS.has(shellExecutable(g0))) uncertainShell = true;
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
                // A passthrough prefix (time, timeout, nice, ...) execs the inner
                // command with the same argv in the same place, so it cannot
                // inject a flag or hide a --no-verify the way eval/sudo/bash -c
                // can. Re-parse the inner command from its `git` token so the
                // commit is judged exactly as if the prefix were not there
                // (--no-verify still denied, a clean commit still allowed). The
                // carve-out only applies when nothing else injects risk;
                // otherwise the wrapper falls back to the closed uncertain path.
                const passthroughExecutable = PASSTHROUGH_PREFIX_EXECUTORS.has(shellExecutable(g0))
                    && environmentRisk.length === 0
                    && !targetEnvironmentRisk
                    && !indirectTargetEnvironmentRisk
                    && !commandTargetUncertain
                    && !indirect.targetUncertain
                    && !indirect.pathDialectUncertain
                    && !commandPathDialectUncertain
                    && !unwrapped.uncertain
                    ? shellExecutable(g0)
                    : null;
                if (passthroughExecutable) {
                    const gitIndex = toks.findIndex((token, index) => (
                        index > 0 && isGitExecutable(token.replace(/^\(+/, '').replace(/\)+$/, ''))
                    ));
                    if (gitIndex > 0) {
                        const inner = parseGit(toks.slice(gitIndex).join(' '), unwrapped.cwd);
                        commit ||= inner.commit;
                        noVerify ||= inner.noVerify;
                        bypassHooks ||= inner.bypassHooks;
                        uncertainShell ||= inner.uncertainShell;
                        addPaths.push(...inner.addPaths);
                        commands.push(...inner.commands);
                        sawAdd ||= inner.addPaths.length > 0;
                        continue;
                    }
                }
                commit = true;
                uncertainShell = true;
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
            }
            if (!READ_ONLY_SHELL_COMMANDS.has(basename(g0))
                && !PASSTHROUGH_PREFIX_EXECUTORS.has(shellExecutable(g0))) {
                prefixIndexMutationRisk ||= commandMayReplaceIndex(toks, unit.text);
                prefixHooksRisk ||= commandMayTouchHooks(toks, unit.text);
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
                if (hookAffectingConfig(toks[i + 1])) commandBypass = true;
                if (hooksPathOverrideConfig(toks[i + 1])) commandHooksPathOverride = true;
                if (aliasAffectingConfig(toks[i + 1])) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 2;
            } else if (option.startsWith('-c') && option.length > 2) {
                if (hookAffectingConfig(option.slice(2))) commandBypass = true;
                if (hooksPathOverrideConfig(option.slice(2))) commandHooksPathOverride = true;
                if (aliasAffectingConfig(option.slice(2))) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 1;
            } else if (option === '--config-env' && toks[i + 1]) {
                if (hookAffectingConfig(toks[i + 1])) commandBypass = true;
                if (hooksPathOverrideConfig(toks[i + 1])) commandHooksPathOverride = true;
                if (aliasAffectingConfig(toks[i + 1])) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 2;
            } else if (option.startsWith('--config-env=')) {
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
            } else {
                i += option === '--namespace' ? 2 : 1;
            }
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
                classification: uncertainShell
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
            policyTransitionRisk = true;
        }
        else if (verb === 'add') {
            const paths = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
            addPaths.push(...paths);
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
            policyTransitionRisk ||= GIT_POLICY_TRANSITION_COMMANDS.has(verb);
        } else if (GIT_POLICY_TRANSITION_COMMANDS.has(verb)
            || GIT_REF_MUTATION_COMMANDS.has(verb)) {
            commands.push({
                verb,
                args: verbArgs,
                cwd,
                bypassHooks: commandBypass,
                environmentRisk,
                targetEnvironmentRisk,
                prefixRisk,
                policyTransitionRisk,
                explicitTargetOption: commandExplicitTargetOption,
                targetUncertain: commandTargetUncertain,
                pathDialectUncertain: commandPathDialectUncertain,
                classification: 'mutation',
            });
            policyTransitionRisk = true;
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
        uncertainShell = true;
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
    const opaqueCommitHiding = uncertainShell && !benignReadOnlyPipeline(cmd);
    return {
        commit,
        noVerify,
        bypassHooks,
        uncertainShell,
        opaqueCommitHiding,
        classification,
        environmentRisk: unique(commands.flatMap((candidate) => candidate.environmentRisk || [])),
        prefixRisk,
        prefixHooksRisk,
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
    while (SHELL_CONTROL_PREFIXES.has(tokens[0])) {
        uncertain = true;
        tokens.shift();
    }
    return { tokens, uncertain };
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
    const text = `${tokens.join(' ')} ${source}`.replace(/\\/g, '/');
    return /(?:^|[\s"'=])(?:\.git\/index|[^\s"']+\/\.git\/index)(?:\.lock)?(?:$|[\s"'])/i.test(text)
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
    const text = `${tokens.join(' ')} ${source}`.replace(/\\/g, '/');
    // The directory need not be spelled in full to be removed: `.git/h*` takes
    // it just as well as `.git/hooks`. Match the segment and step around HEAD,
    // the only other `.git/h` an ordinary command reads.
    return /(?:^|[\s"'=/])\.git\/h(?!ead\b)/i.test(text)
        || /--git-path\s+hooks\b/i.test(text)
        || /\bhookspath\b/i.test(text)
        || /\binclude(?:if\.[^\s"'=]*)?\.path\b/i.test(text);
}

export const GIT_POLICY_TRANSITION_COMMANDS = new Set([
    'am', 'branch', 'checkout', 'cherry-pick', 'commit', 'merge', 'pull', 'read-tree', 'rebase',
    'replace', 'reset', 'restore', 'revert', 'rm', 'switch', 'symbolic-ref', 'update-index',
    'update-ref',
]);

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
    'get-url', 'set-urladd',
]);
const GIT_STASH_MUTATING_SUBCOMMANDS = new Set([
    'push', 'pop', 'apply', 'drop', 'clear', 'save', 'create', 'store', 'branch',
]);
const GIT_NOTES_MUTATING_SUBCOMMANDS = new Set([
    'add', 'append', 'copy', 'remove', 'rm', 'edit', 'prune',
]);

export function gitReadOnlyRefCommand(verb, args = []) {
    const flags = args.filter((arg) => arg.startsWith('-'));
    const positionals = args.filter((arg) => !arg.startsWith('-'));
    if (verb === 'branch') {
        // `git branch`, `git branch -a/-r/-l/--list/-v/--verbose/--all/--remotes`
        // only list. A name, a start-point, or any create/delete/move/copy flag
        // is a mutation.
        if (flags.some((flag) => GIT_BRANCH_MUTATING_FLAGS.has(flag))) return false;
        const listingOnly = flags.every((flag) => (
            GIT_BRANCH_READONLY_FLAGS.has(flag)
        ));
        if (!listingOnly) return false;
        // A positional without --list/-l creates or moves a branch.
        if (positionals.length && !flags.some((flag) => flag === '-l' || flag === '--list')) {
            return false;
        }
        return true;
    }
    if (verb === 'remote') {
        // `git remote` and `git remote -v/--verbose` list; `git remote show <n>`
        // is read-only; everything else mutates.
        if (positionals.length === 0) return flags.every((flag) => flag === '-v' || flag === '--verbose');
        const sub = positionals[0];
        if (GIT_REMOTE_MUTATING_SUBCOMMANDS.has(sub)) return false;
        return sub === 'show';
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
        if (positionals.length && !flags.some((flag) => flag === '-l' || flag === '--list')) {
            return false;
        }
        return true;
    }
    return false;
}

const GIT_TAG_MUTATING_FLAGS = new Set([
    '-d', '--delete', '-f', '--force', '-a', '--annotate', '-s', '--sign',
    '-m', '-u', '--local-user', '-v', '--verify', '-n',
]);

const GIT_BRANCH_READONLY_FLAGS = new Set([
    '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '--verbose', '-vv',
    '-q', '--quiet', '--no-color', '--color',
    '--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged',
    '--points-at',
]);

export function gitCommandMayBypassRefGuard(verb, args = []) {
    if (verb !== 'push') return false;
    return args.some((arg) => arg === '--receive-pack'
        || arg === '--exec'
        || arg.startsWith('--receive-pack=')
        || arg.startsWith('--exec='));
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

function isGitExecutable(value) {
    const executable = String(value || '').replace(/\\/g, '/').split('/').at(-1).toLowerCase();
    return executable === 'git' || executable === 'git.exe';
}

function canResolveGitAlias(value) {
    return /^(?:git|git\.exe)$/i.test(String(value || ''));
}

function hookAffectingConfig(value) {
    const key = String(value).split('=', 1)[0];
    return /^(?:core\.(?:editor|hookspath)|sequence\.editor|include\.path|includeif\..+\.path|remote\..+\.receivepack)$/i.test(key);
}

// A narrower question than hookAffectingConfig: not "can this change how a hook
// behaves" but "does this take the managed hooks away". core.editor and
// sequence.editor leave pre-commit, commit-msg and reference-transaction
// running; these do not.
function hooksPathOverrideConfig(value) {
    const key = String(value).split('=', 1)[0];
    return /^(?:core\.hookspath|include\.path|includeif\..+\.path)$/i.test(key);
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
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            return {
                noVerify,
                futureIndex: futureIndex || i + 1 < args.length,
                editorRisk: editorOverride ?? !messageSource,
            };
        }
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
        futureIndex = true;
    }
    return { noVerify, futureIndex, editorRisk: editorOverride ?? !messageSource };
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
function hasUncertainShellSyntax(command) {
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
        if (char === '`' || char === '(' || char === ')' || char === '<' || char === '>') return true;
        if (char === '|' && command[i + 1] !== '|') return true;
        if (char === '&' && command[i + 1] !== '&' && command[i - 1] !== '&') return true;
    }
    return shellUnits(command).some((unit) => {
        const words = shellWords(unit.text.trim());
        return SHELL_CONTROL_WORDS.has(words[0]);
    });
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
        if (char === '|' && command[i + 1] !== '|') return true;
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
    'gh', '[',
]);

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
    return GIT_READONLY_PIPE_SUBCOMMANDS.has(subcommand) ? subcommand : null;
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
    const variableExecution = (
        /(?:^|[;&\n])\s*eval\b[^;&\n]*\$(?:[A-Za-z_][A-Za-z0-9_]*|[@*]|[1-9][0-9]*)/m.test(command)
        || /\b(?:bash|dash|ksh|sh|zsh)\b[^;&\n]*-[A-Za-z]*c[^;&\n]*\$(?:[A-Za-z_][A-Za-z0-9_]*|[@*]|[1-9][0-9]*)/.test(command)
        || /\bset\s+--[\s\S]*?(?:^|[;&\n])\s*["']?\$(?:@|\*)/m.test(command)
    );
    if (variableExecution) {
        const details = literalCommitDetails(command, initialCwd);
        if (details) {
            details.targetUncertain = true;
            commits.push(details);
        }
    }

    const definition = /(?:^|[;&\n])\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{([\s\S]*?)\}/gm;
    for (const match of command.matchAll(definition)) {
        const tail = command.slice(match.index + match[0].length);
        const invoked = new RegExp(`(?:^|[;&\\n])\\s*${match[1]}(?:\\s|[;&]|$)`).test(tail);
        if (!invoked) continue;
        const parsed = parseGit(match[2], initialCwd);
        for (const candidate of parsed.commands.filter((entry) => entry.verb === 'commit')) {
            commits.push({
                cwd: candidate.cwd,
                bypassHooks: candidate.bypassHooks || false,
                environmentRisk: candidate.environmentRisk || [],
                targetEnvironmentRisk: candidate.targetEnvironmentRisk || false,
                explicitTargetOption: candidate.explicitTargetOption || false,
                targetUncertain: candidate.targetUncertain
                    || commandMayChangeShellTarget(command),
                pathDialectUncertain: candidate.pathDialectUncertain || false,
            });
        }
    }
    return commits;
}

function commandMayChangeShellTarget(command) {
    return /(?:^|[;&\n{}])\s*(?:(?:builtin|command)\s+)?(?:(?:alias|autoload|cd|enable|eval|hash|popd|pushd|rehash|setopt|source|unalias|unfunction)\b|\.(?=\s|$))/m
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
const PASSTHROUGH_PREFIX_EXECUTORS = new Set([
    'time', 'timeout', 'nice', 'ionice', 'chrt', 'taskset', 'numactl',
    'stdbuf', 'setsid', 'nohup', 'prlimit', 'faketime',
]);

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
    if (!words.length) return null;
    const executable = shellExecutable(words[0]);

    const options = /^python(?:\d+(?:\.\d+)*)?$/.test(executable) ? ['-c']
        : INTERPRETER_EVAL_OPTIONS.get(executable);
    if (options) {
        const found = evalFlagCode(words, options);
        if (found) {
            return literalCommitDetails(found.code, initialCwd)
                || interpretedArgumentCommitInvocation(found.code, found.rest, initialCwd);
        }
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
                return program ? literalCommitDetails(program, initialCwd) : null;
            }
            if (/^-[Ffv]/.test(arg) && arg.length === 2) { skippingValue = true; continue; }
            if (arg.startsWith('-')) continue;
            return literalCommitDetails(arg, initialCwd);
        }
    }

    // Generic fallback: an unrecognized <prog> <eval-flag> <code> whose code
    // both executes something and references a git commit. Catches future
    // interpreters (janet, deno --eval, bun -e) without enumerating each. The
    // execution-indicator requirement + non-executing denylist avoids false
    // positives such as `grep -e "git commit"`.
    if (!NON_EXECUTING_EVAL_PROGRAMS.has(executable)) {
        const generic = evalFlagCode(words, ['-e', '-c', '--eval', '--exec', '-p', '--print', '-r']);
        if (generic && /\b(?:argv|child_process|exec|popen|spawn|subprocess|system)\b/.test(generic.code)) {
            const details = literalCommitDetails(generic.code, initialCwd)
                || interpretedArgumentCommitInvocation(generic.code, generic.rest, initialCwd);
            if (details) return details;
        }
    }

    return null;
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
export function shellWords(s) {
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
