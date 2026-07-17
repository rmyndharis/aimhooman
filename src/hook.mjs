import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_TIMEOUT_MS } from './git-environment.mjs';
import { newEngineWithDiagnostics } from './scan.mjs';
import { openRepo, stagedEntries } from './gitx.mjs';
import { applyExclude, patternsForRules } from './exclude.mjs';
import { activeGitHook, installedHooks } from './githooks.mjs';
import { visible } from './report.mjs';
import { extractRuleset } from './ruleset-text.mjs';
import { resolvePolicy } from './policy-resolver.mjs';
import { engineForPolicy, resolveStagedPolicy } from './scan-target.mjs';
import { scanEntries } from './scan-session.mjs';

const AGENTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'AGENTS.md');
const AMBIGUOUS_PATH_REASON =
    'aimhooman cannot map a POSIX-root or tilde target path to the repository that the shell will use; pass an expanded native absolute path or run the Git command from that repository.';
const UNCERTAIN_TARGET_REASON =
    'aimhooman cannot determine the Git operation or repository target after shell expansion or a dynamic directory change; pass a literal absolute path and run the Git operation separately.';

// asObject returns v only when it is a plain object; otherwise {}.
// Guards against hostile/malformed hook payloads: JSON.parse('null') yields
// null, and `null.cwd` would throw, crashing the hook.
export function asObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function ruleset() {
    try {
        return extractRuleset(readFileSync(AGENTS_PATH, 'utf8'), AGENTS_PATH);
    } catch {
        return 'This repository uses aimhooman: never commit AI session files, secrets, or AI attribution. AI works, hoomans ship.';
    }
}

function enforcementPolicy(repo) {
    const { policy, head } = resolveStagedPolicy(repo);
    return { ...policy, head };
}

// runHook implements `aimhooman hook <event>` for AI coding tool adapters.
export async function runHook(args) {
    const event = args[0];
    let input = {};
    let inputError = '';
    try {
        const raw = await readStdin();
        if (!raw.trim()) {
            inputError = 'the hook payload was empty';
        } else {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                inputError = 'the hook payload must be a JSON object';
            } else {
                input = parsed;
            }
        }
    } catch (error) {
        inputError = `the hook payload is not valid JSON (${error.message})`;
        input = {};
    }
    if (event === 'pre-tool-use' && inputError) {
        return emitDecision(
            'deny',
            `aimhooman cannot inspect this tool call because ${inputError}; retry the command so the host sends a complete JSON payload.`
        );
    }
    if (typeof input.cwd === 'string') {
        try {
            process.chdir(input.cwd);
        } catch {
            /* best effort */
        }
    }
    if (event === 'session-start') return hookSessionStart();
    if (event === 'pre-tool-use') return hookPreToolUse(input);
    return 0;
}

export function hookSessionStart() {
    try {
        const repo = openRepo();
        const policy = resolvePolicy(repo, { target: 'worktree' });
        const { engine: eng } = newEngineWithDiagnostics(policy.profile, repo.stateDir);
        applyExclude(repo.excludeFile, patternsForRules(eng.rules));
    } catch {
        /* not a repo; nothing to exclude */
    }
    const ctx = ruleset();
    emit({
        additionalContext: ctx,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
    });
    return 0;
}

function hookPreToolUse(input) {
    const executor = classifyExecutor(toolName(input));
    if (!executor) return 0;
    const executorCommand = command(input, executor);
    if (executorCommand === null) return unknownExecutorShape(input, executor.name);
    const rawParsed = parseGit(executorCommand);
    if (nonPosixExecutor(executor.name)) {
        rawParsed.uncertainShell = true;
        // The benign-pipeline classifier is POSIX-only; never exempt a non-POSIX
        // shell line (pwsh/fish/cmd/nu) from opaque-commit-hiding treatment.
        rawParsed.opaqueCommitHiding = true;
    }
    if (executorTargetSyntaxUncertain(executor.name, executorCommand, rawParsed)
        && (rawParsed.addPaths.length > 0 || rawParsed.commands.some(isProtectedMutation))) {
        return emitDecision(
            'deny',
            'aimhooman cannot prove a repository target selected with non-POSIX shell syntax; use a direct Git command from that repository.',
        );
    }
    if (rawParsed.commands.some((candidate) => (
        isGuardedCandidate(candidate) && candidate.pathDialectUncertain
    ))) {
        return emitDecision(
            'deny',
            AMBIGUOUS_PATH_REASON,
        );
    }
    const rawTargetEnvironment = rawParsed.commands.find((candidate) => (
        isGuardedCandidate(candidate) && candidate.targetEnvironmentRisk
    ));
    if (rawTargetEnvironment) {
        return emitDecision(
            'deny',
            `aimhooman cannot verify which repository policy applies with runtime or Git target environment assignments `
            + `(${(rawTargetEnvironment.environmentRisk || []).join(', ')}); run the Git command without those assignments.`,
        );
    }
    if (rawParsed.commands.some((candidate) => (
        isGuardedCandidate(candidate) && candidate.targetUncertain
    ))) {
        return emitDecision(
            'deny',
            UNCERTAIN_TARGET_REASON,
        );
    }
    const parsed = resolveGitAliases(rawParsed);
    const { commit, noVerify, addPaths } = parsed;
    const bypassHooks = parsed.bypassHooks;
    const protectedMutation = parsed.commands.some(isProtectedMutation);
    if (!commit && !protectedMutation && addPaths.length === 0 && !parsed.uncertainShell) return 0;
    if (parsed.commands.some((candidate) => (
        isGuardedCandidate(candidate) && candidate.pathDialectUncertain
    ))) {
        return emitDecision(
            'deny',
            AMBIGUOUS_PATH_REASON,
        );
    }
    const targetEnvironment = parsed.commands.find((candidate) => (
        isGuardedCandidate(candidate) && candidate.targetEnvironmentRisk
    ));
    if (targetEnvironment) {
        return emitDecision(
            'deny',
            `aimhooman cannot verify which repository policy applies with runtime or Git target environment assignments `
            + `(${(targetEnvironment.environmentRisk || []).join(', ')}); run the Git command without those assignments.`,
        );
    }
    if (parsed.commands.some((candidate) => (
        isGuardedCandidate(candidate) && candidate.targetUncertain
    ))) return emitDecision('deny', UNCERTAIN_TARGET_REASON);

    let repo = null;
    try {
        const primary = parsed.commands.find((candidate) => candidate.verb === 'commit')
            || parsed.commands.find((candidate) => candidate.verb === 'unknown')
            || parsed.commands.find(isProtectedMutation)
            || parsed.commands.find((candidate) => candidate.verb === 'add');
        repo = openRepo(primary?.cwd || process.cwd());
    } catch {
        repo = null;
    }
    let profile = 'clean';
    let policy = null;
    if (repo) {
        try {
            policy = enforcementPolicy(repo);
            profile = policy.profile;
        } catch (e) {
            return emitDecision('deny', `aimhooman cannot load project policy: ${e.message}`);
        }
    }

    // A command the parser flagged as uncertain shell syntax (nesting, a
    // pipeline, a background job, executable indirection, or an unresolved
    // wrapper) is denied under strict even when no commit was recognized,
    // because a hidden commit + --no-verify could not be safely excluded. This
    // only needs to catch commands the per-command loop below cannot reach
    // (empty commands); when commands are present, that loop emits the more
    // specific denial reason.
    if (profile === 'strict' && parsed.uncertainShell && parsed.commands.length === 0) {
        return emitDecision(
            'deny',
            'aimhooman cannot safely verify this command under the strict profile; ' +
            'it uses shell nesting, a pipeline, a background job, or indirection the guard cannot fully resolve. ' +
            'Run the Git commit as a direct, supported command.'
        );
    }

    // Evaluate bypass/future-index risk against each command's actual `git -C`
    // repository, not merely the host tool's initial cwd.
    for (const gitCommand of parsed.commands.filter(isProtectedMutation)) {
        let targetRepo;
        try {
            if (gitCommand.environmentRisk?.includes('GIT_INDEX_FILE')) {
                return emitDecision(
                    'deny',
                    'aimhooman cannot verify the exact staged snapshot when GIT_INDEX_FILE selects another index; run the Git command without that assignment.'
                );
            }
            if (gitCommand.targetEnvironmentRisk) {
                return emitDecision(
                    'deny',
                    `aimhooman cannot verify which repository policy applies with runtime or Git target environment assignments ` +
                    `(${gitCommand.environmentRisk.join(', ')}); run the Git command without those assignments.`
                );
            }
            if (gitCommand.targetUncertain) {
                return emitDecision(
                    'deny',
                    'aimhooman cannot determine the policy that will apply after dynamic execution; run the Git commit separately.'
                );
            }
            if (gitCommand.policyTransitionRisk) {
                return emitDecision(
                    'deny',
                    'aimhooman cannot determine the policy after an earlier Git state change; run the Git commit separately.'
                );
            }
            targetRepo = openRepo(gitCommand.cwd);
            const targetProfile = enforcementPolicy(targetRepo).profile;
            // An unresolved subcommand/alias may itself move a ref. When its
            // hook path or execution context is altered, there is no safe
            // content snapshot to fall back to, so treat it like a direct ref
            // mutation in every profile.
            const directRefMutation = gitCommand.verb !== 'commit';
            if (gitCommand.verb === 'unknown') {
                const label = gitCommand.inlineAliasRisk
                    ? 'an inline Git alias whose expansion is not part of the inspected command'
                    : `Git subcommand or alias "${gitCommand.subcommand}"`;
                return emitDecision(
                    'deny',
                    `aimhooman cannot prove that ${label} preserves the managed reference-transaction guard; `
                    + 'run a direct supported Git command.'
                );
            }
            if (gitCommand.verb === 'push' && configuredPushReceiver(targetRepo)) {
                return emitDecision(
                    'deny',
                    'aimhooman cannot prove that a configured remote receive-pack preserves the managed reference-transaction guard; remove remote.*.receivepack or run a direct push without receiver indirection.'
                );
            }
            if (directRefMutation && (
                parsed.uncertainShell
                || gitCommand.classification === 'uncertain'
                || gitCommand.prefixRisk
                || gitCommand.bypassHooks
                || gitCommand.environmentRisk?.length
            )) {
                return emitDecision(
                    'deny',
                    `aimhooman cannot verify the final reference update for git ${gitCommand.verb} `
                    + 'after hook, environment, shell, or prefix indirection; run the Git command directly with the managed reference-transaction hook.'
                );
            }
            const activeHooks = installedHooks(targetRepo);
            const requiredHooks = gitCommand.verb === 'commit'
                ? ['pre-commit', 'commit-msg', 'reference-transaction']
                : ['reference-transaction'];
            const missingHooks = requiredHooks
                .filter((hook) => !activeHooks.includes(hook));
            if (missingHooks.length) {
                return emitDecision(
                    'deny',
                    `aimhooman requires current, reachable ${requiredHooks.join(', ')} guards before this Git operation; ` +
                    `${missingHooks.join(' and ')} ${missingHooks.length === 1 ? 'is' : 'are'} unavailable. ` +
                    "Run 'aimhooman init' and retry."
                );
            }
            if (targetProfile !== 'strict') continue;
            if (parsed.uncertainShell || gitCommand.classification === 'uncertain') {
                return emitDecision(
                    'deny',
                    'aimhooman cannot safely verify a strict Git commit inside shell nesting, a pipeline, a background job, or executable indirection; run the Git command directly.'
                );
            }
            if (gitCommand.prefixRisk) {
                return emitDecision(
                    'deny',
                    'aimhooman cannot verify strict commit guards after an earlier command may have changed the repository or its hooks; run the Git commit separately.'
                );
            }
            if (gitCommand.environmentRisk?.length) {
                return emitDecision(
                    'deny',
                    `aimhooman strict profile cannot verify a commit with runtime or Git target environment assignments ` +
                    `(${gitCommand.environmentRisk.join(', ')}); run the Git command without those assignments.`
                );
            }
            if (gitCommand.noVerify || gitCommand.bypassHooks) {
                return emitDecision(
                    'deny',
                    'aimhooman strict profile forbids bypassing repository policy hooks (--no-verify/-n or core.hooksPath override).'
                );
            }
            if (gitCommand.verb === 'commit') {
                const prepareMessageHook = activeGitHook(targetRepo, 'prepare-commit-msg');
                if (prepareMessageHook.active) {
                    return emitDecision(
                        'deny',
                        'aimhooman cannot verify a strict agent commit while an active prepare-commit-msg hook can change the final message guard; remove or integrate that hook before retrying.'
                    );
                }
                if (gitCommand.editorRisk) {
                    return emitDecision(
                        'deny',
                        'aimhooman cannot verify a strict agent commit that opens a local editor after pre-commit; provide the message with -m, -F, -C, or --no-edit.'
                    );
                }
            }
        } catch (e) {
            return emitDecision('deny', `aimhooman cannot verify target repository policy and guards: ${e.message}`);
        }
    }
    let eng;
    let diagnosticWarning = '';
    try {
        const loaded = repo
            ? engineForPolicy(repo, policy, policy.head)
            : newEngineWithDiagnostics(profile);
        eng = loaded.engine;
        const errors = loaded.errors || loaded.diagnostics || [];
        if (errors.length) {
            diagnosticWarning = errors.map((error) => error.message || String(error)).join('; ');
            if (profile === 'strict') {
                return emitDecision('deny', `aimhooman strict policy could not load local rules: ${diagnosticWarning}`);
            }
        }
        if (repo) applyExclude(repo.excludeFile, patternsForRules(eng.rules));
    } catch (e) {
        const reason = e?.name === 'LocalOverridesError'
            ? `aimhooman cannot load local overrides: ${e.message}`
            : `aimhooman could not load policy rules: ${e.message}`;
        if (e?.name === 'LocalOverridesError') return emitDecision('deny', reason);
        if (profile === 'strict') return emitDecision('deny', reason);
        return emitDecision('allow', `${reason}; continuing because profile=${profile}`);
    }
    // A strict policy cannot make a meaningful guarantee if Git's own guards
    // are explicitly bypassed. Deny before the shell can stage-and-commit in a
    // single command, when inspecting the future index would be impossible.
    if (profile === 'strict' && commit && (noVerify || bypassHooks)) {
        return emitDecision(
            'deny',
            'aimhooman strict profile forbids bypassing repository policy hooks (--no-verify/-n or core.hooksPath override).'
        );
    }

    // A preceding command that may have changed the repository or its hooks is
    // also a potential pre-commit bypass. Strict rejects it above; clean and
    // compliance still need the staged-content backstop so a hook mutation
    // cannot expose a secret that was already in the index.
    const prefixBypass = parsed.commands.some((candidate) => (
        (candidate.verb === 'commit' || candidate.verb === 'unknown')
        && candidate.prefixRisk
    )) || (parsed.opaqueCommitHiding && parsed.commands.length === 0 && parsed.prefixRisk);
    const aliasBypass = parsed.commands.some((candidate) => (
        (candidate.verb === 'commit' || candidate.verb === 'unknown')
        && candidate.inlineAliasRisk
    ));
    const hiddenBypass = noVerify || bypassHooks || parsed.uncertainShell
        || prefixBypass || aliasBypass;
    const bypassContext = aliasBypass
        ? 'an inline Git alias cannot be proved to preserve the pre-commit guard'
        : prefixBypass
            ? 'an earlier command may have changed the repository or its pre-commit guard'
            : '--no-verify or shell indirection bypasses the pre-commit guard';
    const unmodelledPrefixReason =
        'aimhooman cannot verify the final staged snapshot or Git hooks after an earlier unmodelled command; run that command separately, then retry the commit.';
    const blocks = [];
    // potentialCommit treats a command as leading to a commit. uncertainShell
    // was too broad: it flagged any pipe, so a benign read-only pipeline
    // (gh ... | tail) was scanned and denied as if it staged a secret.
    // opaqueCommitHiding keeps every commit-hiding shape (subshells,
    // substitution, script-feeds, code-executing/unlisted pipe segments) while
    // excluding pipelines of known read-only commands.
    const potentialCommit = commit || parsed.opaqueCommitHiding;
    if (potentialCommit && repo) {
        try {
            const entries = stagedEntries(repo);
            for (const entry of entries) {
                blocks.push(...eng.checkPaths([entry.path], {
                    objectId: entry.oid,
                    mode: entry.mode,
                    transition: 'staged',
                })
                    .filter((finding) => finding.decision === 'block'));
            }
            // A direct --no-verify/core.hooksPath bypass disables pre-commit,
            // so clean/compliance must inspect the immutable staged blobs here.
            // Normal commits leave this work to pre-commit to keep the agent
            // guard fast and avoid reading the same objects twice.
            if (profile !== 'strict' && hiddenBypass) {
                const scan = scanEntries(repo, eng, entries);
                blocks.push(...scan.findings.filter((finding) => finding.decision === 'block'));
                if (!scan.complete) {
                    return emitDecision(
                        'deny',
                        `aimhooman cannot fully scan staged content while ${bypassContext}; run the commit separately without the bypass.`,
                    );
                }
            }
        } catch (e) {
            if (profile === 'strict' || hiddenBypass) {
                return emitDecision('deny', `aimhooman cannot verify staged content: ${e.message}`);
            }
        }
    }
    if (addPaths.length) {
        blocks.push(...eng.checkPaths(addPaths).filter((f) => f.decision === 'block'));
    }
    // Safety net for clean/compliance: --no-verify / core.hooksPath bypass
    // disables the real pre-commit guard, leaving this hook the only check.
    // When the commit also stages files at commit time (-a/--all/-u/--patch, or
    // a preceding `git add`), those files are neither in stagedPaths(repo) now
    // nor in addPaths, so they were never scanned. Rather than let an unscanned
    // secret through, deny. (Strict already denied the bypass above.) The rare
    // false-positive on an explicit `git add <path> && git commit --no-verify`
    // is safe-side; drop --no-verify to proceed.
    //
    // Shell indirection (eval, sudo, wrappers, printf|sh, interpreters) can hide
    // a --no-verify inside the inner command, where parsed.noVerify cannot see
    // it (the parser only inspects literal argv). Such an uncertain commit is
    // therefore treated as a potential hook bypass for the clean/compliance
    // secret backstop, so a secret cannot slip past the guard wrapped in eval.
    const indexReplacement = parsed.commands.some((candidate) => (
        candidate.verb === 'commit' && candidate.indexMutationRisk
    ));
    if (profile !== 'strict' && commit && hiddenBypass
        && parsed.commands.some((c) => c.verb === 'commit' && c.futureIndex)) {
        if (indexReplacement) {
            return emitDecision(
                'deny',
                'aimhooman cannot verify a commit after an earlier command replaces the Git index; run the index-changing command separately so the final staged snapshot can be scanned.'
            );
        }
        return emitDecision(
            'deny',
            'aimhooman cannot verify a commit that stages files at commit time ' +
            '(-a/--all/-u/--patch or a preceding git add) while --no-verify or shell ' +
            'indirection bypasses the pre-commit guard; run the commit directly without ' +
            '--no-verify, or stage the files first. AI works, hoomans ship.',
        );
    }
    if (blocks.length === 0) {
        if (profile !== 'strict' && potentialCommit && prefixBypass) {
            return emitDecision(
                'deny',
                unmodelledPrefixReason,
            );
        }
        if (diagnosticWarning) {
            return emitDecision('allow', `aimhooman warning: ${diagnosticWarning}; invalid local pack skipped`);
        }
        return 0;
    }

    const reason = denyReason(blocks);
    if (profile === 'strict') {
        return emitDecision('deny', reason);
    }
    // clean / compliance: advisory only (the git pre-commit unstage is the real
    // enforcement) — except when --no-verify/core.hooksPath bypasses that hook.
    // A bypassed guard is the one case clean cannot delegate to git, so a blocked
    // secret is denied here, matching the documented "secret stops the commit when
    // automatic unstaging fails"; hygiene findings stay advisory.
    const bypassed = Boolean(potentialCommit && hiddenBypass);
    if (bypassed && blocks.some((f) => f.category === 'secret')) {
        return emitDecision(
            'deny',
            `aimhooman blocked this: ${bypassContext}, so ${reasonParts(blocks).join('; ')} would be committed. Run the commit separately without the bypass, or unstage it. AI works, hoomans ship.`,
        );
    }
    if (profile !== 'strict' && potentialCommit && prefixBypass) {
        return emitDecision(
            'deny',
            unmodelledPrefixReason,
        );
    }
    const guarded = repo && !bypassed && installedHooks(repo).includes('pre-commit');
    const advisory = advisoryReason(blocks, guarded, bypassed ? bypassContext : '');
    return emitDecision(
        'allow',
        diagnosticWarning ? `${advisory} Warning: ${diagnosticWarning}.` : advisory
    );
}

function toolName(i) {
    return i.tool_name || i.toolName || '';
}

const EXECUTOR_SCHEMAS = new Map([
    ['bash', ['command']],
    ['cmd', ['command', 'cmd']],
    ['exec', ['command', 'cmd']],
    ['exec_command', ['cmd', 'command']],
    ['execute', ['command', 'cmd']],
    ['execute_command', ['command', 'cmd']],
    ['fish', ['command']],
    ['powershell', ['command']],
    ['pwsh', ['command']],
    ['run_command', ['command', 'cmd']],
    ['run_shell_command', ['command']],
    ['sh', ['command']],
    ['shell', ['command']],
    ['shell_command', ['command']],
    ['terminal', ['command', 'cmd']],
    ['terminal_exec', ['command', 'cmd']],
    ['zsh', ['command']],
]);
const NON_POSIX_TARGET_EXECUTORS = new Set(['cmd', 'fish', 'powershell', 'pwsh']);

// Host manifests intentionally receive every PreToolUse event. Only known
// command executors are interpreted here; unrelated tools are left alone.
function classifyExecutor(value) {
    const original = String(value || '').trim().toLowerCase();
    if (!original) return null;
    const candidates = [original];
    if (original.includes('__')) candidates.push(original.split('__').at(-1));
    if (/[./:]/.test(original)) candidates.push(original.split(/[./:]/).at(-1));
    for (const name of candidates) {
        const fields = EXECUTOR_SCHEMAS.get(name);
        if (fields) return { name, fields };
    }
    // A tool name containing an executor-like segment (run, git, exec, ...) is
    // treated as a possible executor. This intentionally over-classifies: a
    // non-executing tool with such a name and no command/cmd field reaches
    // unknownExecutorShape, which under strict denies (safe side) rather than
    // silently allowing a tool that might shell out. Narrowing this heuristic
    // risks letting a real executor through, so the safe-side false deny is kept.
    const segments = original.split(/[^a-z0-9]+/).filter(Boolean);
    if (segments.some((segment) => [
        'bash', 'cmd', 'command', 'exec', 'execute', 'fish', 'git', 'powershell', 'pwsh',
        'run', 'sh', 'shell', 'terminal', 'zsh',
    ].includes(segment))) {
        return { name: original, fields: ['command', 'cmd'] };
    }
    return null;
}

function executorTargetSyntaxUncertain(executorName, value, parsed) {
    if (!nonPosixExecutor(executorName)) return false;
    const directoryCommand = shellUnits(String(value || '')).some((unit) => {
        let tokens = unwrapShellControl(shellWords(unit.text.trim())).tokens;
        while (['builtin', 'command'].includes(shellExecutable(tokens[0]))) tokens = tokens.slice(1);
        return ['cd', 'popd', 'pushd', 'set-location', 'pop-location', 'push-location']
            .includes(shellExecutable(tokens[0]));
    });
    return directoryCommand
        || parsed.prefixRisk
        || parsed.commands.some((candidate) => candidate.explicitTargetOption);
}

function nonPosixExecutor(executorName) {
    return [String(executorName || ''), ...String(executorName || '').split(/[^a-z0-9]+/)]
        .some((segment) => NON_POSIX_TARGET_EXECUTORS.has(segment));
}

function command(i, executor) {
    let args = i.tool_input ?? i.toolArgs;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            return null;
        }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    for (const field of executor.fields) {
        if (typeof args[field] === 'string') return args[field];
    }
    return null;
}

function unknownExecutorShape(input, executorName) {
    let repo;
    try {
        repo = openRepo();
    } catch {
        return 0;
    }
    try {
        if (enforcementPolicy(repo).profile !== 'strict') return 0;
    } catch (error) {
        return emitDecision('deny', `aimhooman cannot load project policy: ${error.message}`);
    }
    return emitDecision(
        'deny',
        `aimhooman cannot inspect the ${executorName} command payload in this strict repository; retry with a direct shell command.`
    );
}

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
            if (!READ_ONLY_SHELL_COMMANDS.has(basename(g0))) {
                prefixIndexMutationRisk ||= commandMayReplaceIndex(toks, unit.text);
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
                if (aliasAffectingConfig(toks[i + 1])) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 2;
            } else if (option.startsWith('-c') && option.length > 2) {
                if (hookAffectingConfig(option.slice(2))) commandBypass = true;
                if (aliasAffectingConfig(option.slice(2))) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 1;
            } else if (option === '--config-env' && toks[i + 1]) {
                if (hookAffectingConfig(toks[i + 1])) commandBypass = true;
                if (aliasAffectingConfig(toks[i + 1])) {
                    aliasResolutionRisk = true;
                    inlineAliasRisk = true;
                }
                i += 2;
            } else if (option.startsWith('--config-env=')) {
                if (hookAffectingConfig(option.slice('--config-env='.length))) commandBypass = true;
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
            prefixRisk ||= gitConfigMayMutate(toks.slice(i + 1));
        } else if (verb === 'init') {
            prefixRisk = true;
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
function unwrapShellControl(input) {
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

const GIT_POLICY_TRANSITION_COMMANDS = new Set([
    'am', 'branch', 'checkout', 'cherry-pick', 'commit', 'merge', 'pull', 'read-tree', 'rebase',
    'replace', 'reset', 'restore', 'revert', 'rm', 'switch', 'symbolic-ref', 'update-index',
    'update-ref',
]);

// These verbs can create a commit or move a branch/reference. Their final
// safety boundary is the managed reference-transaction hook, so PreToolUse
// must not let config/environment/prefix indirection disable that boundary.
const GIT_REF_MUTATION_COMMANDS = new Set([
    'am', 'bisect', 'branch', 'checkout', 'cherry-pick', 'fetch', 'merge', 'pull', 'push',
    'rebase', 'remote', 'replace', 'reset', 'revert', 'stash', 'switch', 'symbolic-ref',
    'update-ref', 'worktree',
]);

function gitCommandMayBypassRefGuard(verb, args = []) {
    if (verb !== 'push') return false;
    return args.some((arg) => arg === '--receive-pack'
        || arg === '--exec'
        || arg.startsWith('--receive-pack=')
        || arg.startsWith('--exec='));
}

function configuredPushReceiver(repo) {
    try {
        return execFileSync(
            'git',
            ['config', '--get-regexp', '^remote\\..*\\.receivepack$'],
            {
                cwd: repo.root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: GIT_TIMEOUT_MS,
            },
        ).trim().length > 0;
    } catch (error) {
        if (error?.status === 1) return false;
        throw error;
    }
}

function isProtectedMutation(candidate) {
    return candidate?.verb === 'commit'
        || candidate?.verb === 'unknown'
        || GIT_REF_MUTATION_COMMANDS.has(candidate?.verb);
}

function isGuardedCandidate(candidate) {
    return candidate?.verb === 'add' || isProtectedMutation(candidate);
}

const GIT_INDEX_MUTATION_COMMANDS = new Set([
    'add', 'checkout', 'mv', 'read-tree', 'reset', 'rm', 'switch', 'update-index',
]);

function gitIndexMutationRisk(verb, args = []) {
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

function gitConfigMayMutate(args) {
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

const SAFE_NON_COMMIT_GIT = new Set([
    'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file',
    'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout',
    'cherry-pick', 'clean', 'clone', 'column', 'config', 'count-objects', 'credential', 'describe',
    'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref',
    'fsck', 'gc', 'grep', 'hash-object', 'help', 'index-pack', 'init', 'interpret-trailers',
    'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mktag', 'mktree', 'mv',
    'name-rev', 'pack-objects', 'prune', 'pull', 'push', 'range-diff', 'read-tree', 'rebase',
    'reflog', 'remote', 'repack', 'replace', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert',
    'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status',
    'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-objects', 'update-index',
    'update-ref', 'verify-commit', 'verify-pack', 'verify-tag', 'version', 'whatchanged',
    'worktree', 'write-tree',
]);

function resolveGitAliases(parsed) {
    const commands = [];
    const aliasAddPaths = [];
    let aliasPolicyTransitionRisk = false;
    let aliasIndexMutationRisk = false;
    let aliasPrefixRisk = false;
    for (const candidate of parsed.commands) {
        let resolved = candidate;
        if (candidate.verb === 'unknown') {
            if (
                candidate.prefixRisk
                || candidate.policyTransitionRisk
                || candidate.aliasResolutionRisk
                || candidate.bypassHooks
                || candidate.environmentRisk?.length
            ) {
                resolved = candidate;
            } else {
                resolved = resolveAliasCandidate(candidate);
            }
        }
        if (!resolved) continue;
        const commitLike = resolved.verb === 'commit' || resolved.verb === 'unknown';
        const effective = commitLike ? {
            ...resolved,
            policyTransitionRisk: Boolean(
                resolved.policyTransitionRisk || aliasPolicyTransitionRisk
            ),
            futureIndex: Boolean(resolved.futureIndex || aliasIndexMutationRisk),
            prefixRisk: Boolean(resolved.prefixRisk || aliasPrefixRisk),
        } : resolved;
        commands.push(effective);
        if (effective.verb === 'add') aliasAddPaths.push(...effective.addPaths);
        aliasPolicyTransitionRisk ||= effective.verb === 'unknown'
            || GIT_POLICY_TRANSITION_COMMANDS.has(effective.verb)
            || GIT_REF_MUTATION_COMMANDS.has(effective.verb);
        aliasIndexMutationRisk ||= effective.verb === 'unknown'
            || effective.indexMutationRisk
            || gitIndexMutationRisk(effective.verb, effective.args);
        aliasPrefixRisk ||= effective.verb === 'unknown' || effective.prefixMutationRisk;
    }
    const commitCommands = commands.filter((candidate) => (
        candidate.verb === 'commit' || candidate.verb === 'unknown'
    ));
    const noVerify = commitCommands.some((candidate) => candidate.noVerify);
    const bypassHooks = commitCommands.some((candidate) => candidate.bypassHooks);
    const unknown = commitCommands.some((candidate) => candidate.verb === 'unknown');
    const futureIndex = commitCommands.some((candidate) => candidate.futureIndex);
    return {
        ...parsed,
        commit: commitCommands.length > 0,
        noVerify,
        bypassHooks,
        addPaths: [...parsed.addPaths, ...aliasAddPaths],
        commands,
        environmentRisk: unique(commitCommands.flatMap((candidate) => candidate.environmentRisk || [])),
        classification: parsed.uncertainShell
            ? 'uncertain'
            : unknown
                ? 'unknown'
                : noVerify || bypassHooks
                    ? 'bypass'
                    : futureIndex
                        ? 'future-index'
                        : commitCommands.length ? 'direct' : 'none',
    };
}

function resolveAliasCandidate(candidate) {
    let subcommand = candidate.subcommand;
    let args = [...candidate.args];
    const seen = new Set();
    for (let depth = 0; depth < 8; depth++) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(subcommand) || seen.has(subcommand)) {
            return { ...candidate, subcommand, aliasCycle: seen.has(subcommand) };
        }
        seen.add(subcommand);
        const alias = readGitAlias(candidate.cwd, subcommand);
        if (alias === null) return { ...candidate, subcommand };
        if (alias.trimStart().startsWith('!')) {
            const shellParsed = parseGit(alias.trimStart().slice(1), candidate.cwd);
            const shellCommits = shellParsed.commands.filter((command) => (
                command.verb === 'commit' || command.verb === 'unknown'
            ));
            return {
                ...candidate,
                subcommand,
                alias: candidate.subcommand,
                aliasExpansion: alias,
                aliasShell: true,
                noVerify: shellParsed.noVerify,
                bypassHooks: shellParsed.bypassHooks,
                futureIndex: shellCommits.some((command) => command.futureIndex),
                targetUncertain: candidate.targetUncertain
                    || shellCommits.some((command) => command.targetUncertain),
                pathDialectUncertain: candidate.pathDialectUncertain
                    || shellCommits.some((command) => command.pathDialectUncertain),
                prefixRisk: true,
                policyTransitionRisk: shellCommits.some((command) => (
                    command.policyTransitionRisk
                )),
                classification: 'unknown',
            };
        }
        const words = shellWords(alias);
        if (!words.length || words[0].startsWith('-')) {
            return { ...candidate, subcommand };
        }
        const verb = words[0];
        args = [...words.slice(1), ...args];
        if (verb === 'commit') {
            const options = inspectCommitOptions(args);
            return {
                ...candidate,
                verb: 'commit',
                alias: candidate.subcommand,
                aliasExpansion: alias,
                noVerify: options.noVerify,
                bypassHooks: candidate.bypassHooks,
                futureIndex: options.futureIndex,
                editorRisk: options.editorRisk,
                classification: candidate.bypassHooks || options.noVerify
                    ? 'bypass'
                    : options.futureIndex ? 'future-index' : 'direct',
            };
        }
        if (verb === 'add') {
            const paths = args.filter((value) => !value.startsWith('-'));
            return { ...candidate, verb: 'add', addPaths: paths, classification: 'add' };
        }
        if (SAFE_NON_COMMIT_GIT.has(verb)) {
            const indexMutationRisk = gitIndexMutationRisk(verb, args);
            const prefixMutationRisk = verb === 'init'
                || (verb === 'config' && gitConfigMayMutate(args));
            const bypassHooks = candidate.bypassHooks
                || gitCommandMayBypassRefGuard(verb, args);
            if (GIT_POLICY_TRANSITION_COMMANDS.has(verb)
                || GIT_REF_MUTATION_COMMANDS.has(verb)
                || indexMutationRisk
                || prefixMutationRisk) {
                return {
                    ...candidate,
                    verb,
                    args,
                    alias: candidate.subcommand,
                    aliasExpansion: alias,
                    indexMutationRisk,
                    prefixMutationRisk,
                    bypassHooks,
                    classification: 'non-commit',
                };
            }
            return null;
        }
        subcommand = verb;
    }
    return { ...candidate, subcommand, aliasCycle: true };
}

function readGitAlias(cwd, name) {
    try {
        return execFileSync('git', ['config', '--get', `alias.${name}`], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: GIT_TIMEOUT_MS,
        }).trim();
    } catch {
        return null;
    }
}

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

function inspectCommitOptions(args) {
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
        if (char === '`' || char === '(' || char === ')' || char === '{' || char === '}' || char === '<' || char === '>') return true;
        if (char === '|' && command[i + 1] !== '|') return true;
        if (char === '&' && command[i + 1] !== '&' && command[i - 1] !== '&') return true;
    }
    return shellUnits(command).some((unit) => {
        const words = shellWords(unit.text.trim());
        return SHELL_CONTROL_WORDS.has(words[0]);
    });
}

function shellUnits(s) {
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
// and other stdin-as-program readers, git, tee (writes files), env/xargs/find
// (run sub-commands), and curl/wget (fetch arbitrary content to a pipe).
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
        if (char === '`' || char === '(' || char === ')' || char === '{' || char === '}') return true;
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

// benignReadOnlyPipeline reports whether a command is a bare pipeline whose
// every segment is a known non-code-executing, non-mutating command with no
// opaque shell syntax. Such a pipe cannot hide or feed a commit, so it is not a
// "potential commit" for the unmodelled-prefix guard. Fail-closed: any opaque
// lexeme, unlisted executable, missing executable, or non-pipe returns false.
function benignReadOnlyPipeline(command) {
    if (!command.includes('|')) return false;
    if (containsOpaquePipeLexeme(command)) return false;
    const segments = splitPipeSegments(command);
    if (segments.length < 2) return false;
    return segments.every((segment) => {
        const executable = pipelineSegmentExecutable(segment);
        return executable !== null && SAFE_PIPE_EXECUTABLES.has(executable);
    });
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

function shellExecutable(value) {
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
        for (;;) {
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

function gitConfigAssignmentsBypass(assignments) {
    return assignments.some((assignment) => {
        const separator = assignment.indexOf('=');
        const key = assignment.slice(0, separator).toUpperCase();
        if (key === 'GIT_CONFIG_PARAMETERS' || key === 'GIT_CONFIG_COUNT') return true;
        if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) return true;
        if ([
            'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
        ].includes(key)) return true;
        return ['HOME', 'XDG_CONFIG_HOME'].includes(key);
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

function unique(values) {
    return [...new Set(values)];
}

// Minimal shell tokenizer for recognizing Git commands without executing or
// expanding them. It preserves whitespace inside quotes and handles ordinary
// backslash escapes; shell expansion remains intentionally out of scope.
function shellWords(s) {
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

function reasonParts(blocks) {
    return blocks.map(
        (f) => (f.path ? `${visible(f.path)} (${f.reason})` : f.reason) + ` [${f.ruleId}]`
    );
}

function denyReason(blocks) {
    return (
        `aimhooman blocked this: ${reasonParts(blocks).join('; ')}. ` +
        "Unstage it with 'git restore --staged <path>' and keep it out of Git. AI works, hoomans ship."
    );
}

// advisoryReason explains a clean/compliance hygiene advisory without implying
// that an absent Git-boundary hook will remove the path automatically.
function advisoryReason(blocks, guarded, bypassContext) {
    const paths = [...new Set(blocks.map((f) => f.path).filter(Boolean))];
    const what = paths.length ? paths.map(visible).join(', ') : 'the flagged content';
    const parts = reasonParts(blocks).join('; ');
    if (bypassContext) {
        return `aimhooman advisory: ${bypassContext}; ${what} cannot be assumed to be automatically removed. Run the commit separately without the bypass, or unstage it before committing. (${parts})`;
    }
    if (guarded) {
        return `aimhooman advisory: the pre-commit guard will keep ${what} out automatically (${parts}).`;
    }
    return `aimhooman advisory: ${what} matches policy (${parts}). Unstage it or run 'aimhooman init' to install the Git-boundary guard.`;
}

function emitDecision(decision, reason) {
    const hookSpecificOutput = {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
    };
    if (decision === 'allow') hookSpecificOutput.additionalContext = reason;
    emit({
        permissionDecision: decision,
        permissionDecisionReason: reason,
        hookSpecificOutput,
    });
    return 0;
}

function emit(obj) {
    process.stdout.write(JSON.stringify(obj));
}

function readStdin() {
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) {
            resolve('');
            return;
        }
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (data += c));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}
