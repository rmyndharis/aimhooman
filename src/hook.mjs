import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_TIMEOUT_MS } from './git-environment.mjs';
import { newEngineWithDiagnostics } from './scan.mjs';
import { openRepo, stagedEntries } from './gitx.mjs';
import { applyExclude, patternsForRules } from './exclude.mjs';
import { activeGitHook, installedHooks } from './githooks.mjs';
import { loadConfig } from './state.mjs';
import { visible } from './report.mjs';
import { extractRuleset } from './ruleset-text.mjs';
import { resolvePolicy } from './policy-resolver.mjs';
import { engineForPolicy, resolveStagedPolicy } from './scan-target.mjs';
import { scanEntries } from './scan-session.mjs';
import {
    GIT_POLICY_INPUT_COMMANDS,
    GIT_POLICY_TRANSITION_COMMANDS,
    GIT_REF_MUTATION_COMMANDS,
    SAFE_NON_COMMIT_GIT,
    commandMayTouchHooks,
    gitCommandMayBypassRefGuard,
    gitConfigMayMutate,
    gitIndexMutationRisk,
    gitReadOnlyRefCommand,
    hasUnquotedPipe,
    inspectCommitOptions,
    isGuardedCandidate,
    isProtectedMutation,
    parseGit,
    shellExecutable,
    shellUnits,
    shellWords,
    unique,
    unwrapShellControl,
} from './shell-parse.mjs';

// The shell analysis layer lives in shell-parse.mjs; re-export its public
// pieces so this module's import surface is unchanged.
export { parseGit, shellPathIsAmbiguous } from './shell-parse.mjs';

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
        const patterns = patternsForRules(eng.rules);
        // Each refresh is housekeeping with its own silent failure, mirroring
        // the pre-tool-use path: a read-only .git/info must not skip the
        // worktree .gitignore refresh below, and neither may decide anything.
        try {
            applyExclude(repo.excludeFile, patterns);
        } catch {
            /* exclude refresh is best effort */
        }
        // A clone that opted into the committed variant gets the same refresh in
        // its worktree .gitignore; every failure degrades silently, same as the
        // exclude write above.
        try {
            if (loadConfig(repo.stateDir).gitignore?.enabled) {
                applyExclude(join(repo.root, '.gitignore'), patterns);
            }
        } catch {
            /* gitignore refresh is best effort */
        }
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
            // Some ref-mutation verbs have read-only listing forms that move no
            // ref and so cannot bypass the reference-transaction guard. Reading
            // a repository (`git branch | grep`, `git remote -v | grep origin`,
            // `git stash list | head`) is everyday work; refusing it behind a
            // pipeline forced developers out of their normal workflow. A real
            // mutation still carries a mutating flag or positional and stays
            // subject to every check below. This sits above the transition veto
            // because a command that reads cannot be made unsafe by whatever ran
            // before it; it stays below the checks above, which are about not
            // being able to see the repository at all.
            if (gitReadOnlyRefCommand(gitCommand.verb, gitCommand.args || [])) continue;
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
            // The hooks are installed but this command routes around them. Unlike
            // --no-verify, which leaves reference-transaction to catch the ref
            // update, an overridden hooks path removes every managed guard at
            // once, so there is nothing downstream to delegate to. Persisting the
            // same override already denies, so this keeps the two forms agreeing.
            if (gitCommand.verb === 'commit' && gitCommand.hooksPathOverride) {
                return emitDecision(
                    'deny',
                    'aimhooman cannot verify the managed pre-commit and reference-transaction guards for '
                    + 'git commit when the command overrides the hooks path; run the commit without the override.'
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
    // diagnosticWarning is about the rule pack and can stop a strict command;
    // hygieneWarning is housekeeping that never touches the decision. Kept apart
    // because only one of the two is ever grounds to deny.
    let diagnosticWarning = '';
    let hygieneWarning = '';
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
    } catch (e) {
        const reason = e?.name === 'LocalOverridesError'
            ? `aimhooman cannot load local overrides: ${e.message}`
            : `aimhooman could not load policy rules: ${e.message}`;
        if (e?.name === 'LocalOverridesError') return emitDecision('deny', reason);
        if (profile === 'strict') return emitDecision('deny', reason);
        // Rules that will not load are the least basis there is for granting an
        // allow, and clean/compliance do not deny on them. Say nothing instead.
        return 0;
    }
    // Refreshing the excludes is gitignore hygiene, not part of the verdict:
    // pre-commit never writes them and still answers. Kept out of the block
    // above so a read-only .git/info (CI checkout, read-only volume, a
    // repository owned by another user) cannot decide what is allowed.
    if (repo) {
        const patterns = patternsForRules(eng.rules);
        try {
            applyExclude(repo.excludeFile, patterns);
        } catch (e) {
            hygieneWarning = `could not refresh ${repo.excludeFile}: ${e.message}`;
        }
        // The committed variant of the block gets the same best-effort refresh
        // when this clone opted into it; a failure there is housekeeping too,
        // never part of the verdict.
        try {
            if (loadConfig(repo.stateDir).gitignore?.enabled) {
                applyExclude(join(repo.root, '.gitignore'), patterns);
            }
        } catch (e) {
            const gitignoreWarning = `could not refresh ${join(repo.root, '.gitignore')}: ${e.message}`;
            hygieneWarning = hygieneWarning ? `${hygieneWarning}; ${gitignoreWarning}` : gitignoreWarning;
        }
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
    // cannot sneak a blocked staged file past the guard.
    const commitPrefixRisk = parsed.commands.some((candidate) => (
        (candidate.verb === 'commit' || candidate.verb === 'unknown')
        && candidate.prefixRisk
    ));
    // Nothing here was modelled, yet the shape can still hide a commit — a pipe
    // into a shell, a fed script. There is no argv to read a --no-verify out of,
    // which is the reason to refuse rather than a reason to let it past.
    const opaqueCommitRisk = parsed.opaqueCommitHiding
        && parsed.commands.length === 0
        && parsed.prefixRisk;
    const prefixBypass = commitPrefixRisk || opaqueCommitRisk;
    const aliasBypass = parsed.commands.some((candidate) => (
        (candidate.verb === 'commit' || candidate.verb === 'unknown')
        && candidate.inlineAliasRisk
    ));
    const hiddenBypass = noVerify || bypassHooks || parsed.uncertainShell
        || prefixBypass || aliasBypass;
    // Being unmodelled is not the same as being a bypass. Once a commit has been
    // read out of the command, a prefix earns the refusal below only when it can
    // take the guard away: it names the hooks, or the commit already bypasses
    // them. A build, a test run, ls — those leave pre-commit to answer, and
    // refusing them taught agents to drop the `&&` gate rather than to run the
    // command separately. hiddenBypass stays wider on purpose; it is what keeps
    // the staged-content backstop reading the blobs, so a blocked file already
    // in the index still stops the commit here.
    const prefixHookBypass = opaqueCommitRisk
        || (commitPrefixRisk && (noVerify || bypassHooks || parsed.prefixHooksRisk));
    // The same distinction, for the deny paths that ask "will anything scan this
    // commit". hiddenBypass answers a different question — "should the backstop
    // read the blobs" — and answering the first with the second refuses
    // `build && git add . && git commit`, which is how most commits get made.
    const guardBypass = noVerify || bypassHooks || parsed.uncertainShell
        || prefixHookBypass || aliasBypass;
    const bypassContext = aliasBypass
        ? 'an inline Git alias cannot be proved to preserve the pre-commit guard'
        : prefixBypass
            ? 'an earlier command may have changed the repository or its pre-commit guard'
            : '--no-verify or shell indirection bypasses the pre-commit guard';
    const unmodelledPrefixReason =
        'aimhooman cannot verify the final staged snapshot or Git hooks after an earlier unmodelled command; run that command separately, then retry the commit.';
    // A pipeline whose sink can execute code (a shell, an interpreter fed on
    // stdin) can hide a commit or run arbitrary commands, and there is no argv
    // to read a --no-verify out of. The earlier message reused the commit text
    // above, which told a developer to "retry the commit" for a command that
    // was not a commit at all — this names the real shape instead. The message
    // is conditional on whether a pipe is actually present: opaque syntax
    // without a pipe (a subshell, a brace group, command substitution) should
    // not tell the developer to "drop the `| bash` segment" on a command that
    // has no `|`.
    const opaquePipelineReason = commit
        ? unmodelledPrefixReason
        : hasUnquotedPipe(executorCommand)
            ? 'aimhooman cannot prove this pipeline is read-only: a shell or code-executing segment can hide a commit or run arbitrary commands. Drop that segment (for example the `| bash`) and run the pieces separately.'
            : 'aimhooman cannot prove this command is read-only: it uses shell syntax (a subshell, command substitution, script-feed redirect, background job, or brace group) that can hide a commit or run arbitrary commands. Run the pieces separately.';
    const blocks = [];
    // potentialCommit treats a command as leading to a commit. uncertainShell
    // was too broad: it flagged any pipe, so a benign read-only pipeline
    // (gh ... | tail) was scanned and denied as if it staged a blocked file.
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
    // nor in addPaths, so they were never scanned. Rather than let unscanned
    // content through, deny. (Strict already denied the bypass above.) The rare
    // false-positive on an explicit `git add <path> && git commit --no-verify`
    // is safe-side; drop --no-verify to proceed.
    //
    // Shell indirection (eval, sudo, wrappers, printf|sh, interpreters) can hide
    // a --no-verify inside the inner command, where parsed.noVerify cannot see
    // it (the parser only inspects literal argv). Such an uncertain commit is
    // therefore treated as a potential hook bypass for the clean/compliance
    // staged-content backstop, so a blocked file cannot slip past the guard
    // wrapped in eval.
    const indexReplacement = parsed.commands.some((candidate) => (
        candidate.verb === 'commit' && candidate.indexMutationRisk
    ));
    if (profile !== 'strict' && commit && guardBypass
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
        if (profile !== 'strict' && potentialCommit && prefixHookBypass) {
            return emitDecision(
                'deny',
                opaquePipelineReason,
            );
        }
        // Nothing found and nothing to object to, so emit nothing and leave the
        // host's permission rules in charge. An allow auto-approves the call and
        // skips them, and neither warning is an opinion about this command: one
        // is about the rule pack, the other about a housekeeping write. Both
        // still reach the notes on the findings path below.
        return 0;
    }

    const reason = denyReason(blocks);
    if (profile === 'strict') {
        return emitDecision('deny', reason);
    }
    // clean / compliance: advisory only (the git pre-commit unstage is the real
    // enforcement) — except when --no-verify/core.hooksPath bypasses that hook.
    // A bypassed guard is the one case clean cannot delegate to git, so a
    // secret-category finding (a local rule pack can still declare one) is
    // denied here; hygiene findings stay advisory.
    const bypassed = Boolean(potentialCommit && hiddenBypass);
    if (bypassed && blocks.some((f) => f.category === 'secret')) {
        return emitDecision(
            'deny',
            `aimhooman blocked this: ${bypassContext}, so ${reasonParts(blocks).join('; ')} would be committed. Run the commit separately without the bypass, or unstage it. AI works, hoomans ship.`,
        );
    }
    if (profile !== 'strict' && potentialCommit && prefixHookBypass) {
        return emitDecision(
            'deny',
            opaquePipelineReason,
        );
    }
    const guarded = repo && !bypassed && installedHooks(repo).includes('pre-commit');
    const advisory = advisoryReason(blocks, guarded, bypassed ? bypassContext : '');
    const notes = [diagnosticWarning, hygieneWarning].filter(Boolean).join('; ');
    return emitAdvisory(notes ? `${advisory} Warning: ${notes}.` : advisory);
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

function resolveGitAliases(parsed) {
    const commands = [];
    const aliasAddPaths = [];
    let aliasPolicyTransitionRisk = false;
    let aliasIndexMutationRisk = false;
    let aliasPrefixRisk = false;
    // parseGit derives prefixHooksRisk from the literal command text, and an
    // alias hides its expansion from that text entirely. Without this the alias
    // channel raises prefixRisk but never the hooks half, so a hooks-removing
    // prefix reached through an alias reads as an ordinary build step.
    let aliasHooksRisk = false;
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
        // The same narrowing the parser applies. Without it every commit-like
        // candidate is re-stamped here after parseGit has run, and the veto
        // below fires again on lines where nothing moved a policy input.
        aliasPolicyTransitionRisk ||= effective.verb === 'unknown'
            || (GIT_POLICY_INPUT_COMMANDS.has(effective.verb)
                && !gitReadOnlyRefCommand(effective.verb, effective.args || []));
        aliasIndexMutationRisk ||= effective.verb === 'unknown'
            || effective.indexMutationRisk
            || gitIndexMutationRisk(effective.verb, effective.args);
        aliasPrefixRisk ||= effective.verb === 'unknown' || effective.prefixMutationRisk;
        aliasHooksRisk ||= Boolean(effective.prefixMutationRisk)
            && commandMayTouchHooks(effective.args || [], effective.aliasExpansion || '');
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
        prefixHooksRisk: Boolean(parsed.prefixHooksRisk || aliasHooksRisk),
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
    emit({
        permissionDecision: decision,
        permissionDecisionReason: reason,
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: reason,
        },
    });
    return 0;
}

// emitAdvisory surfaces findings without a permission decision. An 'allow'
// would auto-approve the call and skip the host's own permission rules — and
// the one moment findings exist is exactly the wrong moment to waive them.
// The context still reaches the model; the host prompts as it normally would,
// mirroring the deliberate silence of the no-findings path above.
function emitAdvisory(reason) {
    emit({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: reason,
        },
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
