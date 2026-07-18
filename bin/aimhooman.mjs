#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_TIMEOUT_MS } from '../src/git-environment.mjs';
import { newEngineWithDiagnostics } from '../src/scan.mjs';
import { exitCode, human, jsonReport, visible } from '../src/report.mjs';
import {
    GitRevisionError,
    gitConfig,
    introducedCommits,
    openRepo,
    readCommitPath,
    readStagedPath,
    stagedPaths,
    stagedRenameSources,
    unstagePaths,
    withIndexFromTree,
} from '../src/gitx.mjs';
import { loadConfig, loadOverrides, loadProjectPolicy, normalizeOverrideTarget, saveConfig, saveOverrides } from '../src/state.mjs';
import { applyExclude, inspectExclude, patternsForRules, removeExclude } from '../src/exclude.mjs';
import { effectiveHooksDir, hookDiagnostics, installHooks, installGlobalHooks, uninstallGlobalHooks, globalHooksDir, installedHooks, remainingDispatchers, uninstallHooks, unrestoredChainedBackups } from '../src/githooks.mjs';
import { ArgumentError, parseArguments } from '../src/args.mjs';
import { engineForPolicy, scanGitTarget, scanMessage } from '../src/scan-target.mjs';
import { resolvePolicy } from '../src/policy-resolver.mjs';
import { atomicWrite, withLock } from '../src/atomic-write.mjs';
import { commitParents, resolveCommit } from '../src/history-scan.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CLI_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROFILES = new Set(['clean', 'strict', 'compliance']);
const REQUIRED_GIT_HOOKS = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'reference-transaction'];
const MINIMUM_GIT_VERSION = [2, 28, 0];
const LIFECYCLE_LOCK_OPTIONS = { retries: 1000 };

function tryRepo() {
    try {
        return openRepo();
    } catch {
        return null;
    }
}

function currentRepositoryIsBare() {
    try {
        return execFileSync('git', ['rev-parse', '--is-bare-repository'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: GIT_TIMEOUT_MS,
        }).trim() === 'true';
    } catch {
        return false;
    }
}

function tone() {
    return process.env.AIMHOOMAN_TONE === 'professional' || process.env.CI ? 'professional' : 'playful';
}

// The per-scan budget sizes the `cat-file --batch` read buffer, so a value that
// travelled with a clone would let a hostile repository drive the verifier out
// of memory instead of being rejected by it. These stay in the environment for
// that reason, never in .aimhooman.json, and a raise is capped for the same one.
// Lowering needs no ceiling: a smaller budget only skips more, and a skip is
// already an incomplete scan, which fails closed at 31.
const MAX_SCAN_LIMIT_BYTES = 1 << 30;

// Crossing a scan budget marks the scan incomplete on every profile, and an
// incomplete scan is a ref update the reference-transaction hook refuses — the
// one boundary --no-verify does not skip. A repository tracking a lockfile, an
// image or a vendored bundle over the default therefore could not commit at all,
// and "reduce the target or limits and retry" named something no flag, schema
// field or config key could do. This is that knob.
function scanLimits() {
    const limits = {};
    for (const [key, name] of [
        ['maxFileBytes', 'AIMHOOMAN_MAX_FILE_BYTES'],
        ['maxTotalBytes', 'AIMHOOMAN_MAX_TOTAL_BYTES'],
    ]) {
        const raw = process.env[name];
        if (raw === undefined || raw === '') continue;
        if (!/^\d+$/.test(raw)) {
            throw new ArgumentError(`${name} must be a whole number of bytes; got "${visible(raw)}"`);
        }
        const value = Number(raw);
        if (value < 1 || value > MAX_SCAN_LIMIT_BYTES) {
            throw new ArgumentError(
                `${name} must be between 1 and ${MAX_SCAN_LIMIT_BYTES} bytes; got ${raw}`
            );
        }
        limits[key] = value;
    }
    return limits;
}

function configuredEngine(profile, repo) {
    const { engine, errors } = newEngineWithDiagnostics(profile, repo?.stateDir);
    if (errors.length && profile === 'strict') {
        throw new Error(errors.map((error) => error.message).join('; '));
    }
    for (const error of errors) {
        process.stderr.write(`aimhooman: warning: ${error.message}; pack skipped\n`);
    }
    if (repo) {
        const ov = loadOverrides(repo.stateDir);
        const ordinary = (entries) => entries.filter((entry) => (
            entry.scope === undefined
            || entry.scope === 'path'
            || entry.scope === 'rule'
            || entry.scope === 'secret-path'
        ));
        engine.setOverrides(ordinary(ov.allow), ordinary(ov.deny));
    }
    return engine;
}

function main(argv) {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case 'check':
            return cmdCheck(rest);
        case 'audit':
        case 'scan':
            return cmdCheck(['--tracked', ...rest]);
        case 'precommit':
            return cmdPrecommit(rest);
        case 'commitmsg':
            return cmdCommitmsg(rest);
        case 'refcheck':
            return cmdRefcheck(rest);
        case 'init':
            return cmdInit(rest);
        case 'status':
            return cmdStatus(rest);
        case 'explain':
            return cmdExplain(rest);
        case 'allow':
            return cmdOverride(rest, true);
        case 'deny':
            return cmdOverride(rest, false);
        case 'override':
            return cmdOverrideLifecycle(rest);
        case 'review':
            return cmdReview(rest);
        case 'policy-review':
            return cmdPolicyReview(rest);
        case 'fix':
            return cmdFix(rest);
        case 'doctor':
            return cmdDoctor(rest);
        case 'uninstall':
            return cmdUninstall(rest);
        case 'version':
        case '--version':
        case '-v':
            parseNoArguments(rest);
            console.log(VERSION);
            return 0;
        case undefined:
        case 'help':
        case '--help':
        case '-h':
            parseNoArguments(rest);
            usage();
            return 0;
        default:
            console.error(`aimhooman: unknown command "${cmd}"`);
            usage();
            return 20;
    }
}

function parseNoArguments(args) {
    parseArguments(args, { maxPositionals: 0 });
}

function expectedErrorCode(error) {
    if (error instanceof ArgumentError) return 20;
    if (/^(?:ProjectPolicy|LocalConfig|LocalOverrides|PolicyProfile|PolicyTarget|PolicyRules|RulePack)/.test(error?.name || '')) {
        return 20;
    }
    if (error?.name === 'GitRevisionError' || error instanceof TypeError) return 20;
    return 30;
}

function emitDiagnostics(diagnostics = []) {
    const seen = new Set();
    for (const diagnostic of diagnostics) {
        const message = diagnostic.message || String(diagnostic);
        if (seen.has(message)) continue;
        seen.add(message);
        process.stderr.write(`aimhooman: warning: ${message}\n`);
    }
}

function incompleteMessage(scan) {
    const reasons = scan.stats?.skipped || {};
    const skipped = Object.entries(reasons)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ');
    // Every other reason is a size or budget the caller can shrink. A pack that
    // will not compile is not, and the warning above already names the file and
    // the error, so point at that instead of misdirecting to the limits. When a
    // byte budget is what stopped the scan, name the budget: the caller whose own
    // tree outgrew it needs to raise one, and "reduce the limits" sends them the
    // wrong way down a road they cannot leave.
    const budgeted = reasons['size-limit'] || reasons['total-byte-limit'];
    const hint = reasons['local-pack-error']
        ? 'fix the reported rule pack and retry'
        : budgeted
            ? 'reduce the target, or raise AIMHOOMAN_MAX_FILE_BYTES / AIMHOOMAN_MAX_TOTAL_BYTES, and retry'
            : 'reduce the target or limits and retry';
    return `aimhooman: scan incomplete${skipped ? ` (${skipped})` : ''}; ${hint}\n`;
}

function snapshotFile(path) {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return { path, existed: true, untouched: true };
        if (!stat.isFile()) throw new Error(`refusing to replace non-file path "${path}"`);
        return { path, existed: true, data: readFileSync(path), mode: stat.mode & 0o777 };
    } catch (error) {
        if (error?.code === 'ENOENT') return { path, existed: false };
        throw error;
    }
}

function restoreSnapshot(snapshot) {
    if (snapshot.untouched) return;
    if (!snapshot.existed) {
        rmSync(snapshot.path, { force: true });
        return;
    }
    atomicWrite(snapshot.path, snapshot.data, { mode: snapshot.mode });
    chmodSync(snapshot.path, snapshot.mode);
}

function gitConfigAtScope(root, scope, key) {
    try {
        return execFileSync('git', ['config', scope, '--get', key], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: GIT_TIMEOUT_MS,
        }).trim();
    } catch {
        return '';
    }
}

function gitVersion() {
    try { return execFileSync('git', ['--version'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim(); }
    catch { return 'Git unavailable'; }
}

function supportedGitVersion() {
    const display = gitVersion();
    const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(display);
    if (!match) return { supported: false, display };
    const version = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    const supported = version.some((value, index) => value > MINIMUM_GIT_VERSION[index]
        && version.slice(0, index).every((prior, priorIndex) => prior === MINIMUM_GIT_VERSION[priorIndex]))
        || version.every((value, index) => value === MINIMUM_GIT_VERSION[index]);
    return { supported, display, version };
}

function rejectUnsupportedGit() {
    const current = supportedGitVersion();
    if (current.supported) return false;
    console.error(
        `aimhooman: Git 2.28.0 or newer is required for the reference-transaction guard; found ${current.display}`
    );
    return true;
}

function dispatchHooksChanged(repo, profile) {
    if (!process.env.AIMHOOMAN_ACTIVE_HOOK) return false;
    const finalBoundary = process.env.AIMHOOMAN_ACTIVE_HOOK === 'reference-transaction';
    const activeHooks = installedHooks(repo);
    const missingHooks = REQUIRED_GIT_HOOKS.filter((name) => !activeHooks.includes(name));
    if (!missingHooks.length) return false;
    // A predecessor can remove a later dispatcher before it has a chance to
    // run. Every profile must stop at the first hook that notices; otherwise a
    // clean/compliance pre-commit predecessor could delete the final ref guard
    // and leave no downstream boundary at all.
    const boundary = finalBoundary ? 'final' : profile === 'strict' ? 'strict' : 'required';
    process.stderr.write(
        `aimhooman: ${boundary} Git guards changed while ${process.env.AIMHOOMAN_ACTIVE_HOOK} was running; ` +
        `${missingHooks.join(', ')} ${missingHooks.length === 1 ? 'is' : 'are'} unavailable. ` +
        "The commit was stopped; run 'aimhooman init' and retry.\n"
    );
    return true;
}

function cmdPrecommit(args) {
    parseNoArguments(args);
    const repo = tryRepo();
    if (!repo) { console.error('aimhooman: not a git repository'); return 30; }
    const limits = scanLimits();
    let scan;
    try {
        scan = scanGitTarget(repo, { kind: 'staged', limits });
    } catch (e) {
        console.error(`aimhooman: cannot scan staged content: ${e.message}`);
        return expectedErrorCode(e);
    }
    emitDiagnostics(scan.diagnostics);
    const profile = scan.profile;
    const allFindings = scan.findings;
    if (dispatchHooksChanged(repo, profile)) return 20;
    const reviews = allFindings.filter((f) => f.decision === 'review');
    const blocks = allFindings
        .filter((f) => f.decision === 'block');
    if (!blocks.length) {
        if (reviews.length) process.stderr.write(human(reviews, tone()));
        if (!scan.complete) {
            process.stderr.write(incompleteMessage(scan));
            return 31;
        }
        return profile === 'strict' && reviews.length ? 11 : 0;
    }
    if (profile === 'strict') {
        process.stderr.write(human(allFindings, tone()));
        if (!scan.complete) process.stderr.write(incompleteMessage(scan));
        return 10;
    }
    const paths = [...new Set(blocks.map((f) => f.path).filter(Boolean))];
    let emptied = false;
    try {
        const unstageTargets = new Set(paths);
        for (const finding of blocks) {
            if (finding.status === 'R' && finding.sourcePath && unstageTargets.has(finding.path)) {
                unstageTargets.add(finding.sourcePath);
            }
        }
        for (const source of stagedRenameSources(repo, paths)) unstageTargets.add(source);
        // Whether the repair empties the index is derived from the staged paths
        // captured before repair, not from a second git read after
        // `git restore --staged`. That post-repair read followed an index write
        // and could transiently report the wrong state under heavy CI load,
        // flaking the repair tests. unstagePaths is atomic (it throws on
        // failure), so when every staged path is a repair target the index
        // matches HEAD afterward. The capture is best-effort and runs before the
        // repair: if this read fails the unstage still runs and the commit is
        // left to proceed rather than blocked on a state we could not read.
        let stagedBefore;
        try {
            stagedBefore = stagedPaths(repo);
        } catch {
            stagedBefore = null;
        }
        unstagePaths(repo, [...unstageTargets]);
        // Under heavy CI load a `git restore --staged` or the rename-source
        // detection above can transiently leave a target staged, which flakes
        // the repair tests and would let an artifact ride through. Re-detect
        // rename sources and re-unstage any still-staged target until every
        // target is gone or the budget is reached.
        for (let attempt = 0; attempt < 4; attempt += 1) {
            let stillStaged;
            try {
                for (const source of stagedRenameSources(repo, paths)) unstageTargets.add(source);
                stillStaged = new Set(stagedPaths(repo));
            } catch {
                break;
            }
            const pending = [...unstageTargets].filter((path) => stillStaged.has(path));
            if (!pending.length) break;
            unstagePaths(repo, pending);
        }
        emptied = stagedBefore !== null
            && stagedBefore.every((path) => unstageTargets.has(path));
        process.stderr.write(
            `aimhooman: unstaged ${paths.length} file(s) from this commit: ${paths.map(visible).join(', ')} (index only; nothing on disk was deleted)${emptied ? ' — nothing else was staged, so the commit is stopped rather than left empty' : ''}\n`
        );
    } catch (e) {
        process.stderr.write(
            `aimhooman: could not unstage protected files: ${e.message} ` +
            '(commit stopped; repair the index and retry)\n'
        );
        return 10;
    }
    // Seven of the rules that can reach the summary above are secret rules, so it
    // cannot name a cause without guessing wrong for a private key or an AWS
    // credential — and it used to be the only thing printed for a block. Let the
    // findings speak instead: human() already carries the rule id, the path, the
    // reason and the remediation, and already redacts secret text. It labels each
    // one BLOCK, which is the decision that unstaged the path, not a stopped
    // commit; the summary above says what actually happened to them.
    process.stderr.write(human([...blocks, ...reviews], tone()));
    if (!scan.complete) process.stderr.write(incompleteMessage(scan));
    // Git refuses a commit with nothing staged; repair runs after git has already
    // decided otherwise, so carrying on here mints the empty commit git would
    // not. The request was to commit the artifact, not to stamp the history with
    // its message and no content.
    if (emptied) return 10;
    return scan.complete ? 0 : 31;
}

function cmdCommitmsg(args) {
    const { options, positionals } = parseArguments(args, {
        options: {
            tree: { names: ['--tree'], type: 'string' },
        },
        minPositionals: 1,
        maxPositionals: 1,
    });
    const file = positionals[0];
    const repo = tryRepo();
    if (!repo) { console.error('aimhooman: not a git repository'); return 30; }
    // A .aimhooman-bak from an earlier commit went stale the moment that commit
    // finished, and git reuses this message path. Clear the previous run's backup
    // now, before this run may write its own, so at most one ever lingers.
    try { rmSync(`${file}.aimhooman-bak`, { force: true }); } catch { /* best effort */ }
    // Frictionless profiles (clean/compliance) never cancel a commit merely
    // because the message file cannot be read; only strict fails closed.
    let hookProfile = 'clean';
    const againstWouldBeTree = (fn) => options.tree
        ? withIndexFromTree(repo, options.tree, fn)
        : fn();
    try {
        hookProfile = againstWouldBeTree(() => resolvePolicy(repo, {
            target: options.tree ? 'staged' : 'worktree',
        }).profile);
    } catch (error) {
        if (options.tree) {
            console.error(`aimhooman: cannot inspect would-be commit policy: ${error.message}`);
            return expectedErrorCode(error);
        }
    }
    let messageBytes;
    try { messageBytes = readFileSync(file); } catch (e) {
        if (hookProfile === 'strict') {
            console.error(`aimhooman: cannot read message file: ${e.message}`);
            return 30;
        }
        console.error(`aimhooman: could not read message file: ${e.message}; skipping commit-msg guard`);
        return 0;
    }
    const text = messageBytes.toString('utf8');
    const validUtf8 = Buffer.from(text, 'utf8').equals(messageBytes);
    const limits = scanLimits();
    let scan;
    let treeScan = null;
    try {
        const checked = againstWouldBeTree(() => ({
            message: scanMessage(repo, text, { target: 'staged' }),
            tree: options.tree ? scanGitTarget(repo, { kind: 'staged', limits }) : null,
        }));
        scan = checked.message;
        treeScan = checked.tree;
    } catch (e) {
        console.error(`aimhooman: cannot inspect commit message: ${e.message}`);
        return expectedErrorCode(e);
    }
    emitDiagnostics(scan.diagnostics);
    if (treeScan) emitDiagnostics(treeScan.diagnostics);
    const { profile, findings } = scan;
    if (treeScan) {
        const treeCode = exitCode(treeScan.findings, treeScan.profile, treeScan.complete);
        if (treeCode !== 0) {
            if (treeScan.findings.length) process.stderr.write(human(treeScan.findings, tone()));
            if (!treeScan.complete) process.stderr.write(incompleteMessage(treeScan));
            return treeCode;
        }
    }
    if (dispatchHooksChanged(repo, profile)) return 20;
    // Strict must fail closed on an incomplete scan: a block still wins (10),
    // otherwise an incomplete strict scan stops the commit (31) like cmdPrecommit.
    if (profile === 'strict' && !scan.complete) {
        if (findings.length) process.stderr.write(human(findings, tone()));
        process.stderr.write(incompleteMessage(scan));
        return findings.some((finding) => finding.decision === 'block') ? 10 : 31;
    }
    if (!scan.complete) process.stderr.write(incompleteMessage(scan));
    if (!findings.length) return 0;
    const blocks = findings.filter((finding) => finding.decision === 'block');
    if (profile === 'strict') {
        process.stderr.write(human(findings, tone()));
        return blocks.length ? 10 : 11;
    }
    const { cleaned, removed } = scan.repair;
    if (removed.length) {
        if (!validUtf8) {
            process.stderr.write('aimhooman: commit message is not valid UTF-8; no bytes were changed because a safe repair cannot be proved\n');
            process.stderr.write(human(findings, tone()));
            return 10;
        }
        try {
            atomicWrite(file + '.aimhooman-bak', messageBytes);
            atomicWrite(file, cleaned);
        } catch (e) {
            try { rmSync(file + '.aimhooman-bak', { force: true }); } catch { /* keep the write error */ }
            // blocks.length is always > 0 here: removed entries are block findings
            // and blocks ⊇ removed, so this path always stops the commit (exit 10).
            process.stderr.write(`aimhooman: could not clean commit message: ${e.message}; commit stopped\n`);
            process.stderr.write(human(findings, tone()));
            return 10;
        }
        process.stderr.write(`aimhooman: stripped ${removed.length} AI attribution line(s); backup at ${file}.aimhooman-bak\n`);
    }
    const removedLines = new Set(removed.map((finding) => finding.line));
    const remaining = findings.filter((finding) => !removedLines.has(finding.line));
    if (remaining.length) process.stderr.write(human(remaining, tone()));
    return remaining.some((finding) => finding.decision === 'block') ? 10 : 0;
}

function cmdRefcheck(args) {
    const { positionals } = parseArguments(args, {
        minPositionals: 1,
        maxPositionals: 1,
    });
    const phase = positionals[0];
    if (!['preparing', 'prepared', 'committed', 'aborted'].includes(phase)) {
        throw new ArgumentError('refcheck phase must be preparing, prepared, committed, or aborted');
    }
    // Git 2.54 added an earlier `preparing` callback. At that point references
    // are not locked and symbolic refs are not resolved, so keep the full scan
    // at `prepared`. Do not return before checking dispatcher integrity, though:
    // a chained hook could otherwise delete this hook between the two phases.
    if (phase === 'committed' || phase === 'aborted') return 0;

    const repo = tryRepo();
    if (phase === 'preparing') {
        // This phase never scans, and without a repository there is no
        // dispatcher directory to inspect either. Git fires it while `git init`
        // is still building the repository, so refusing here would only stop
        // repository creation on behalf of a phase with nothing to say.
        return repo && dispatchHooksChanged(repo, 'clean') ? 20 : 0;
    }
    let input;
    try { input = readFileSync(0, 'utf8'); }
    catch (error) {
        console.error(`aimhooman: cannot read proposed reference updates: ${error.message}`);
        return 30;
    }
    const updates = [];
    for (const line of input.split('\n').filter(Boolean)) {
        const match = /^(\S+) (\S+) (.+)$/.exec(line);
        if (!match) {
            console.error('aimhooman: malformed reference-transaction input; update stopped');
            return 30;
        }
        const [, oldObjectId, newObjectId, ref] = match;
        if (ref !== 'HEAD' && !ref.startsWith('refs/heads/')) continue;
        if (ref === 'HEAD' && newObjectId.startsWith('ref:')) continue;
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oldObjectId)
            || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(newObjectId)) {
            console.error('aimhooman: malformed object ID in reference transaction; update stopped');
            return 30;
        }
        if (/^0+$/.test(newObjectId)) continue;
        updates.push({ oldObjectId, newObjectId, ref });
    }

    if (!repo) {
        // Git writes the initial HEAD inside a reference transaction and fires
        // this hook while the repository is still being built: GIT_DIR is
        // exported but nothing can be queried yet, so every rev-parse fails,
        // --is-bare-repository included. The bare carve-out below therefore
        // cannot speak for `git init` or `git init --bare`, and reading the
        // silence as "not a git repository" aborted the transaction and left a
        // half-built .git behind that a second `git init` could not repair.
        // That payload is `0000..0000 ref:refs/heads/<name> HEAD`, which the
        // symref filter above already dropped, so no policy-relevant update
        // survives and there is nothing to scan. The scope is "the payload
        // carries nothing", never "git failed to answer": a transaction holding
        // a real object still demands a repository, so no one can disable the
        // last veto by arranging for openRepo to fail.
        if (!updates.length) return 0;
        // Global hooks also run in bare repositories. Bare repositories have no
        // worktree/index policy boundary and are intentionally unsupported, so
        // a global dispatcher must remain transparent there instead of making
        // every receive-pack or update-ref fail merely because --show-toplevel
        // is unavailable.
        if (currentRepositoryIsBare()) return 0;
        console.error('aimhooman: not a git repository');
        return 30;
    }

    let commits;
    try {
        const contextsByCommit = new Map();
        for (const update of updates) {
            for (const revision of introducedCommits(repo, [update])) {
                const contexts = contextsByCommit.get(revision) || [];
                contexts.push({
                    head: update.newObjectId,
                    storedTransition: revision,
                    scanTransition: revision,
                });
                // A staged review is bound to the exact old tip. It can be
                // carried into the final full-snapshot scan only for the direct
                // proposed tip whose parent is that old tip, never for an
                // intermediate commit or a newly created branch ancestry.
                if (revision === update.newObjectId && !/^0+$/.test(update.oldObjectId)) {
                    const { parents } = commitParents(repo, revision);
                    if (parents.includes(update.oldObjectId)) {
                        contexts.push({
                            head: update.oldObjectId,
                            storedTransition: 'staged',
                            scanTransition: revision,
                        });
                    }
                }
                contextsByCommit.set(revision, contexts);
            }
        }
        commits = [...contextsByCommit];
    }
    catch (error) {
        console.error(`aimhooman: cannot resolve proposed commits: ${error.message}`);
        return 30;
    }
    const limits = scanLimits();
    for (const [revision, reviewContexts] of commits) {
        let scan;
        try {
            scan = scanGitTarget(repo, {
                kind: 'commit',
                revision,
                reviewContexts,
                policyMigrationContexts: reviewContexts,
                limits,
            });
        }
        catch (error) {
            console.error(`aimhooman: cannot scan proposed commit ${revision}: ${error.message}`);
            return expectedErrorCode(error);
        }
        emitDiagnostics(scan.diagnostics);
        const code = exitCode(scan.findings, scan.profile, scan.complete);
        if (code !== 0) {
            process.stderr.write(human(scan.findings, tone()));
            if (!scan.complete) process.stderr.write(incompleteMessage(scan));
            process.stderr.write(`aimhooman: proposed commit ${revision} was rejected before refs changed\n`);
            return code;
        }
    }
    // The reference-transaction hook is the last veto point. If its chained
    // predecessor removed any required dispatcher, every profile stops: there
    // is no downstream guard that can repair the lost boundary safely.
    if (dispatchHooksChanged(repo, 'clean')) return 20;
    return 0;
}

function cmdCheck(args) {
    const { options: o } = parseArguments(args, {
        options: {
            staged: { names: ['--staged'], type: 'boolean' },
            tracked: { names: ['--tracked'], type: 'boolean' },
            json: { names: ['--json'], type: 'boolean' },
            message: { names: ['--message', '-m'], type: 'string' },
            profile: { names: ['--profile'], type: 'string', choices: [...PROFILES] },
            commit: { names: ['--commit'], type: 'string' },
            range: { names: ['--range'], type: 'string' },
        },
        conflicts: [['staged', 'tracked', 'commit', 'range']],
        maxPositionals: 0,
    });
    if (o.message && (o.commit || o.range)) {
        throw new ArgumentError('--message cannot be combined with --commit or --range; Git object messages are scanned automatically');
    }
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    let messageText;
    if (o.message) {
        try { messageText = readFileSync(o.message, 'utf8'); }
        catch (e) {
            console.error(`aimhooman: cannot read message file: ${e.message}`);
            return 30;
        }
    }
    const limits = scanLimits();
    let scan;
    try {
        if (o.message && !o.staged && !o.tracked) {
            scan = scanMessage(repo, messageText, {
                target: 'worktree',
                explicitProfile: o.profile,
            });
        } else {
            scan = scanGitTarget(repo, {
                kind: o.tracked ? 'tracked' : o.commit ? 'commit' : o.range ? 'range' : 'staged',
                revision: o.commit,
                range: o.range,
                explicitProfile: o.profile,
                limits,
                ...(o.message ? { messageText } : {}),
            });
        }
    } catch (e) {
        console.error(`aimhooman: scan failed: ${e.message}`);
        return expectedErrorCode(e);
    }
    emitDiagnostics(scan.diagnostics);
    const { findings } = scan;
    if (o.json) {
        process.stdout.write(jsonReport(findings, {
            tool_version: VERSION,
            target: scan.target,
            profile: scan.profile,
            policy_source: scan.policy_source,
            policy_object_id: scan.policy_object_id,
            ...(scan.policy_enforced_object_ids ? {
                policy_enforced_object_ids: scan.policy_enforced_object_ids,
            } : {}),
            complete: scan.complete,
            stats: scan.stats,
            message_scanned: scan.message_scanned,
            ...(scan.commit ? { commit: scan.commit } : {}),
            ...(scan.range ? { range: scan.range } : {}),
        }) + '\n');
    }
    else {
        process.stderr.write(human(findings, tone()));
        if (!scan.complete) process.stderr.write(incompleteMessage(scan));
    }
    return exitCode(findings, scan.profile, scan.complete);
}

function cmdInit(args) {
    const { options } = parseArguments(args, {
        options: {
            profile: { names: ['--profile'], type: 'string', choices: [...PROFILES] },
            global: { names: ['--global'], type: 'boolean' },
            yes: { names: ['--yes'], type: 'boolean' },
        },
        conflicts: [['profile', 'global']],
        maxPositionals: 0,
    });
    if (rejectUnsupportedGit()) return 20;
    if (options.global) {
        if (!options.yes) {
            console.error('aimhooman: init --global changes inherited Git hook behavior; review the warning and rerun with --yes');
            return 20;
        }
        return withLock(join(globalHooksDir(), 'lifecycle.lock'), () => {
        const aimDir = globalHooksDir();
        let existing = '';
        try {
            existing = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
        } catch { /* unset */ }
        if (existing && existing !== aimDir) {
            console.error(
                `aimhooman: core.hooksPath is already set to '${existing}'; refusing to overwrite. ` +
                'Unset it (git config --global --unset core.hooksPath) or choose a different setup.'
            );
            return 20;
        }
        // A --system hooksPath would be shadowed by the --global write below and
        // could silently disable a system-wide hook manager, so refuse here too.
        let systemHooksPath = '';
        try {
            systemHooksPath = execFileSync('git', ['config', '--system', '--get', 'core.hooksPath'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
        } catch { /* unset or no system config */ }
        if (systemHooksPath) {
            console.error(
                `aimhooman: core.hooksPath is set at --system scope to '${systemHooksPath}'; ` +
                'a --global install would shadow it. Unset it or choose a different setup.'
            );
            return 20;
        }
        const localRepo = tryRepo();
        const localHooksPath = localRepo ? gitConfigAtScope(localRepo.root, '--local', 'core.hooksPath') : '';
        if (localHooksPath) {
            console.error(`aimhooman: warning: this repository has local core.hooksPath="${localHooksPath}", which overrides the global guard here`);
        }
        const hookSnapshots = REQUIRED_GIT_HOOKS
            .map((name) => snapshotFile(join(aimDir, name)));
        let rep;
        try {
            rep = installGlobalHooks(CLI_PATH);
            if (rep.skipped?.length) {
                for (const warning of rep.warnings || []) console.error(`aimhooman: ${warning}`);
                console.error('aimhooman: global hook installation aborted; core.hooksPath was not changed');
                return 20;
            }
            execFileSync('git', ['config', '--global', 'core.hooksPath', rep.dir], { timeout: GIT_TIMEOUT_MS });
        } catch (error) {
            const rollbackFailures = [];
            for (const snapshot of hookSnapshots.reverse()) {
                try { restoreSnapshot(snapshot); }
                catch (rollbackError) {
                    rollbackFailures.push(`${snapshot.path}: ${rollbackError.message}`);
                }
            }
            try {
                if (existing) execFileSync('git', ['config', '--global', 'core.hooksPath', existing], { timeout: GIT_TIMEOUT_MS });
                else execFileSync('git', ['config', '--global', '--unset', 'core.hooksPath'], { stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
            } catch (rollbackError) {
                rollbackFailures.push(`global core.hooksPath: ${rollbackError.message}`);
            }
            console.error(`aimhooman: global hook installation failed: ${error.message}`);
            if (rollbackFailures.length) {
                console.error(`aimhooman: rollback incomplete: ${rollbackFailures.join('; ')}`);
            }
            return 30;
        }
        console.log(`aimhooman: global hooks at ${rep.dir} (core.hooksPath set)`);
        for (const w of rep.warnings || []) console.log(`  warning: ${w}`);
        console.log('  note: this replaces the default .git/hooks directory in non-bare repositories that inherit the global setting; local/worktree core.hooksPath overrides it.');
        return 0;
        }, LIFECYCLE_LOCK_OPTIONS);
    }
    if (options.yes) throw new ArgumentError('--yes is only valid with --global');
    let profile = options.profile || 'clean';
    const profileExplicit = Boolean(options.profile);
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    return withLock(join(repo.commonDir, 'aimhooman-lifecycle.lock'), () => {
    let projectPolicy;
    try {
        projectPolicy = loadProjectPolicy(repo.root);
    } catch (e) {
        console.error(`aimhooman: cannot load project policy: ${e.message}`);
        return 20;
    }
    if (projectPolicy) {
        if (profileExplicit && profile !== projectPolicy.profile) {
            console.error(
                `aimhooman: project policy requires profile "${projectPolicy.profile}"; ` +
                'edit .aimhooman.json to change the team baseline'
            );
            return 20;
        }
        profile = projectPolicy.profile;
    }
    let eng;
    try {
        eng = configuredEngine(profile, repo);
    } catch (e) {
        console.error(`aimhooman: cannot initialise policy: ${e.message}`);
        return 20;
    }
    const hookState = hookDiagnostics(repo);
    const hookFiles = hookState.some((hook) => hook.shared)
        ? []
        : [...new Set(hookState.flatMap((hook) => [hook.path, hook.chainedPath]))];
    let snapshots = [];
    let rep;
    try {
        snapshots = [join(repo.stateDir, 'config.json'), repo.excludeFile, ...hookFiles]
            .map(snapshotFile);
        rep = installHooks(repo, CLI_PATH);
        const activeHooks = installedHooks(repo);
        if (!REQUIRED_GIT_HOOKS.every((name) => activeHooks.includes(name))) {
            // installHooks declines rather than throws when the hooks directory is
            // not ours, and its warnings are the only record of why. They are
            // printed on the success path only, so carry them into the failure or
            // the user is told nothing but "incomplete". The prefix is load-bearing:
            // the exit-code branch below matches on it.
            const cause = rep.shared && rep.warnings.length ? `${rep.warnings.join('; ')}; ` : '';
            throw new Error(`hook installation incomplete; ${cause}repository guard is not active`);
        }
        saveConfig(repo.stateDir, { profile });
        applyExclude(repo.excludeFile, patternsForRules(eng.rules));
        const saved = loadConfig(repo.stateDir);
        const excludes = inspectExclude(repo.excludeFile, patternsForRules(eng.rules));
        if (saved.profile !== profile || !excludes.current) {
            throw new Error('post-install state verification failed');
        }
    } catch (error) {
        const rollbackFailures = [];
        try {
            const uninstalled = uninstallHooks(repo);
            rollbackFailures.push(...(uninstalled.failures || []));
        } catch (rollbackError) {
            rollbackFailures.push(`hook uninstall: ${rollbackError.message}`);
        }
        const hookSet = new Set(hookFiles);
        const restoreHooks = Boolean(rep?.installed?.length || rep?.chained?.length);
        for (const snapshot of snapshots.reverse()) {
            if (!restoreHooks && hookSet.has(snapshot.path)) continue;
            try { restoreSnapshot(snapshot); }
            catch (rollbackError) {
                rollbackFailures.push(`${snapshot.path}: ${rollbackError.message}`);
            }
        }
        if (rollbackFailures.length) {
            console.error(`aimhooman: initialisation failed: ${error.message}`);
            console.error(`aimhooman: rollback incomplete: ${rollbackFailures.join('; ')}`);
            return 30;
        }
        console.error(`aimhooman: initialisation failed and prior files were restored: ${error.message}`);
        return /hook installation incomplete/.test(error.message) ? 20 : expectedErrorCode(error);
    }
    console.log(`aimhooman: initialised (profile: ${profile})`);
    console.log(`  state:    ${repo.stateDir}`);
    console.log(`  excludes: ${repo.excludeFile}`);
    if (rep.installed.length) console.log(`  hooks:    ${rep.installed.join(', ')}`);
    if (rep.chained.length) console.log(`  chained:  ${rep.chained.join(', ')} (existing hooks preserved)`);
    for (const warning of rep.warnings) console.log(`  warning:  ${warning}`);
    return 0;
    }, LIFECYCLE_LOCK_OPTIONS);
}

function cmdStatus(args) {
    parseNoArguments(args);
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    let policy;
    let overrides;
    try {
        policy = resolvePolicy(repo, { target: 'worktree' });
        overrides = loadOverrides(repo.stateDir);
    } catch (e) {
        console.error(`aimhooman: cannot load enforcement state: ${e.message}`);
        return 20;
    }
    const hooks = hookDiagnostics(repo);
    const installed = hooks.filter((hook) => hook.managed && hook.executable && hook.reachable)
        .map((hook) => hook.name);
    const hooksComplete = REQUIRED_GIT_HOOKS.every((name) => installed.includes(name));
    const { engine, errors } = newEngineWithDiagnostics('clean', repo.stateDir);
    const builtin = engine.rules.filter((rule) => rule.source === 'builtin').length;
    const local = engine.rules.filter((rule) => rule.source === 'local').length;
    let excludes;
    let excludeError = null;
    try {
        excludes = inspectExclude(repo.excludeFile, patternsForRules(engine.rules));
    } catch (e) {
        // A malformed managed-exclude marker must not crash status; degrade like
        // `doctor` and surface the problem instead of returning a raw stack trace.
        excludeError = e.message;
        excludes = { current: false, installed: false };
    }
    const policyLabel = policy.source === 'worktree-policy' ? 'project' : policy.source;
    console.log(`profile:  ${policy.profile}`);
    console.log(`policy:   ${policyLabel} (${policy.source}, object=${policy.policy_object_id || 'none'})`);
    console.log(`hooks:    ${hooksComplete ? installed.join(', ') : installed.length ? `${installed.join(', ')} (incomplete; run: aimhooman init)` : 'not installed (run: aimhooman init)'}`);
    for (const hook of hooks) {
        console.log(`hook ${hook.name}: ${hook.managed ? 'managed' : 'not managed'}, ${hook.executable ? 'executable' : 'not executable'}, ${hook.reachable ? 'reachable' : hook.reason}`);
    }
    console.log(`rules:    ${builtin} built-in${local ? ` + ${local} local` : ''}`);
    console.log(`overrides: ${overrides.allow.length} allow, ${overrides.deny.length} deny`);
    console.log(`excludes: ${excludeError ? `unknown (malformed markers: ${excludeError}; run: aimhooman init)` : excludes.current ? 'current' : excludes.installed ? 'out of date (run: aimhooman init)' : 'not installed (run: aimhooman init)'}`);
    for (const error of errors) console.log(`warning:  ${error.message}`);
    const localHooks = gitConfigAtScope(repo.root, '--local', 'core.hooksPath');
    const globalHooks = gitConfigAtScope(repo.root, '--global', 'core.hooksPath');
    console.log(`hooks path: local=${localHooks || 'unset'}, global=${globalHooks || 'unset'}`);
    console.log(`runtime:  Node ${process.versions.node}; ${gitVersion()}`);
    console.log(`state:    ${repo.stateDir}`);
    return 0;
}

function cmdExplain(args) {
    const { positionals } = parseArguments(args, { minPositionals: 1, maxPositionals: 1 });
    const id = positionals[0];
    const repo = tryRepo();
    let eng;
    try {
        eng = configuredEngine('clean', repo);
    } catch (e) {
        console.error(`aimhooman: cannot load policy rules: ${e.message}`);
        return 20;
    }
    const r = eng.lookup(id);
    if (!r) {
        console.error(`aimhooman: no rule with id "${id}"`);
        return 20;
    }
    const af = (p) => r.actions[p] || r.actions.clean || 'review';
    console.log(`Rule:        ${r.id} (v${r.version || 1})`);
    console.log(`Category:    ${r.category}`);
    console.log(`Provider:    ${r.provider}`);
    console.log(`Confidence:  ${r.confidence}`);
    console.log(`Actions:     clean=${af('clean')} strict=${af('strict')} compliance=${af('compliance')}`);
    console.log(`Reason:      ${r.reason}`);
    if (r.match?.paths) console.log(`Paths:       ${r.match.paths.join(', ')}`);
    if (r.match?.content) console.log(`Content:     ${r.match.content.join(', ')}`);
    if (r.remediation?.length) {
        console.log('Remediation:');
        for (const s of r.remediation) console.log(`  - ${s}`);
    }
    if (r.references?.length) console.log(`References:  ${r.references.join(', ')}`);
    return 0;
}

function cmdOverride(args, allow) {
    const verb = allow ? 'allow' : 'deny';
    const { options, positionals } = parseArguments(args, {
        options: {
            reason: { names: ['--reason'], type: 'string', nonEmpty: false },
            scope: { names: ['--scope'], type: 'string', choices: ['path', 'rule', 'secret-path'] },
        },
        minPositionals: 1,
        maxPositionals: 1,
    });
    const target = normalizeOverrideTarget(positionals[0]);
    if (!target) throw new ArgumentError('override target must not be empty');
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    const { engine } = newEngineWithDiagnostics('clean', repo.stateDir);
    const scope = options.scope || (engine.lookup(target) ? 'rule' : 'path');
    if (scope === 'rule' && !engine.lookup(target)) {
        throw new ArgumentError(`unknown rule ID "${target}"; use --scope path for a path with this spelling`);
    }
    if (allow && scope === 'rule' && engine.lookup(target)?.category === 'secret') {
        throw new ArgumentError(
            `secret rules cannot be allowed at --scope rule (that would suppress every matching secret path under every profile); use --scope secret-path <path> to allow a specific secret path`,
        );
    }
    // A path that matches a secret rule cannot be silenced by a path (or rule)
    // allow: only --scope secret-path suppresses secret findings, deliberately,
    // so a local override cannot hide a possible leaked key. Without this check
    // a bare `allow .env.minimal` would report success but leave the block in
    // place, which reads as a broken allow.
    if (allow && scope !== 'secret-path'
        && engine.checkPaths([target]).some((finding) => finding.category === 'secret')) {
        throw new ArgumentError(
            `"${target}" matches a secret rule, so a ${scope} allow cannot silence it `
            + '(a local override must not hide a possible leaked key); '
            + 'use --scope secret-path to explicitly allow this specific path',
        );
    }
    if (scope === 'secret-path' && !allow) {
        throw new ArgumentError('--scope secret-path is only valid with allow');
    }
    const entry = {
        target,
        scope,
        reason: options.reason || '',
        actor: gitConfig(repo.root, 'user.email'),
        at: new Date().toISOString(),
    };
    // Hold an advisory lock across load-modify-save so concurrent override
    // writes (e.g. two worktrees) cannot lose each other's entries.
    return withLock(join(repo.stateDir, 'overrides.json.lock'), () => {
        const ov = loadOverrides(repo.stateDir);
        if (allow) {
            ov.allow = upsert(ov.allow, entry, (candidate) => (
                candidate.target === target && effectiveOverrideScope(candidate, engine) === scope
            ));
            ov.deny = ov.deny.filter((candidate) => !(
                candidate.target === target && effectiveOverrideScope(candidate, engine) === scope
            ));
        } else {
            ov.deny = upsert(ov.deny, entry, (candidate) => (
                candidate.target === target && effectiveOverrideScope(candidate, engine) === scope
            ));
            ov.allow = ov.allow.filter((candidate) => !(
                candidate.target === target && effectiveOverrideScope(candidate, engine) === scope
            ));
        }
        saveOverrides(repo.stateDir, ov);
        console.log(`aimhooman: ${allow ? 'allowed' : 'denied'} "${target}"`);
        return 0;
    });
}

function cmdOverrideLifecycle(args) {
    const [action, ...rest] = args;
    if (!action) throw new ArgumentError('override requires list, remove, or reset');
    if (!['list', 'remove', 'reset'].includes(action)) {
        throw new ArgumentError(`unknown override action "${action}"`);
    }
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    if (action === 'list') {
        const overrides = loadOverrides(repo.stateDir);
        const { options } = parseArguments(rest, {
            options: { json: { names: ['--json'], type: 'boolean' } },
            maxPositionals: 0,
        });
        if (options.json) {
            process.stdout.write(JSON.stringify({ schema_version: 1, ...overrides }, null, 2) + '\n');
        } else if (!overrides.allow.length && !overrides.deny.length) {
            console.log('aimhooman: no overrides');
        } else {
            for (const kind of ['allow', 'deny']) {
                for (const entry of overrides[kind]) {
                    const binding = entry.head ? ` @ ${entry.head}` : '';
                    const reviewBinding = entry.transition
                        ? ` [${entry.transition} -> ${entry.newObjectId ? `${entry.newMode}:${entry.newObjectId}` : 'deletion'}]`
                        : '';
                    console.log(`${kind.padEnd(5)} ${entry.target}${binding}${reviewBinding}${entry.reason ? ` — ${entry.reason}` : ''}`);
                }
            }
        }
        return 0;
    }
    if (action === 'remove') {
        const { positionals } = parseArguments(rest, { minPositionals: 1, maxPositionals: 1 });
        const target = normalizeOverrideTarget(positionals[0]);
        return withLock(join(repo.stateDir, 'overrides.json.lock'), () => {
            const overrides = loadOverrides(repo.stateDir);
            const before = overrides.allow.length + overrides.deny.length;
            overrides.allow = overrides.allow.filter((entry) => entry.target !== target);
            overrides.deny = overrides.deny.filter((entry) => entry.target !== target);
            if (before === overrides.allow.length + overrides.deny.length) {
                console.error(`aimhooman: no override for "${target}"`);
                return 20;
            }
            saveOverrides(repo.stateDir, overrides);
            console.log(`aimhooman: removed override "${target}"`);
            return 0;
        });
    }
    if (action === 'reset') {
        const { options } = parseArguments(rest, {
            options: {
                allow: { names: ['--allow'], type: 'boolean' },
                deny: { names: ['--deny'], type: 'boolean' },
                all: { names: ['--all'], type: 'boolean' },
            },
            conflicts: [['allow', 'deny', 'all']],
            maxPositionals: 0,
        });
        return withLock(join(repo.stateDir, 'overrides.json.lock'), () => {
            const overrides = loadOverrides(repo.stateDir);
            if (options.allow) overrides.allow = [];
            else if (options.deny) overrides.deny = [];
            else overrides.allow = overrides.deny = [];
            saveOverrides(repo.stateDir, overrides);
            console.log(`aimhooman: reset ${options.allow ? 'allow' : options.deny ? 'deny' : 'all'} overrides`);
            return 0;
        });
    }
    throw new Error('unreachable override action');
}

function cmdReview(args) {
    const { options, positionals } = parseArguments(args, {
        options: {
            head: { names: ['--head'], type: 'string' },
            commit: { names: ['--commit'], type: 'string' },
            reason: { names: ['--reason'], type: 'string', nonEmpty: false },
        },
        minPositionals: 1,
        maxPositionals: 1,
    });
    if (!options.head) throw new ArgumentError('review requires --head <commit>');
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    const target = normalizeOverrideTarget(positionals[0]);
    if (!target) throw new ArgumentError('review target must not be empty');
    const head = resolveCommit(repo, options.head);
    const { engine } = newEngineWithDiagnostics('strict', repo.stateDir);
    const finding = engine.checkPaths([target])[0];
    const instruction = finding?.matchedRuleIds?.includes('generic.agent-instructions');
    const projectPolicy = finding?.matchedRuleIds?.includes('generic.project-policy');
    if (!instruction && !projectPolicy) {
        throw new ArgumentError('review accepts only a covered agent instruction or project policy path');
    }
    let reviewed;
    let transition;
    let tombstone = false;
    if (options.commit) {
        transition = resolveCommit(repo, options.commit);
        reviewed = readCommitPath(repo, transition, target);
        if (reviewed.status === 'missing') {
            const { parents } = commitParents(repo, transition);
            const existedInParent = parents.some((parent) => (
                readCommitPath(repo, parent, target).status === 'present'
            ));
            if (existedInParent) tombstone = true;
        }
    } else {
        transition = 'staged';
        reviewed = readStagedPath(repo, target);
        if (reviewed.status === 'missing') {
            const baseline = readCommitPath(repo, head, target);
            if (baseline.status === 'present') tombstone = true;
        }
    }
    if ((!tombstone && reviewed.status !== 'present') || (!tombstone && !reviewed.oid)) {
        throw new ArgumentError(`review target "${target}" is missing from the selected Git snapshot`);
    }
    if (!tombstone && !['100644', '100755'].includes(reviewed.mode)) {
        throw new ArgumentError(
            `review target "${target}" must be a regular Git file, not mode ${reviewed.mode || 'unknown'}`,
        );
    }
    const entry = {
        target,
        scope: instruction ? 'reviewed-instruction' : 'reviewed-policy-file',
        head,
        transition,
        newObjectId: tombstone ? null : reviewed.oid,
        newMode: tombstone ? null : reviewed.mode,
        reason: options.reason || '',
        actor: gitConfig(repo.root, 'user.email'),
        at: new Date().toISOString(),
    };
    return withLock(join(repo.stateDir, 'overrides.json.lock'), () => {
        const overrides = loadOverrides(repo.stateDir);
        overrides.allow = upsert(overrides.allow, entry, (candidate) => (
            candidate.target === target
            && candidate.scope === entry.scope
            && candidate.head === head
            && candidate.transition === transition
            && candidate.newObjectId === entry.newObjectId
            && candidate.newMode === entry.newMode
        ));
        saveOverrides(repo.stateDir, overrides);
        const object = entry.newObjectId ? `${entry.newMode} blob ${entry.newObjectId}` : 'deletion';
        console.log(`aimhooman: recorded review for "${target}" at ${head} (${object}, ${transition})`);
        return 0;
    });
}

function cmdPolicyReview(args) {
    const { options } = parseArguments(args, {
        options: {
            head: { names: ['--head'], type: 'string' },
            transition: { names: ['--transition'], type: 'string' },
            staged: { names: ['--staged'], type: 'boolean' },
            old: { names: ['--old'], type: 'string' },
            new: { names: ['--new'], type: 'string' },
            reason: { names: ['--reason'], type: 'string', nonEmpty: false },
        },
        conflicts: [['transition', 'staged']],
        maxPositionals: 0,
    });
    for (const name of ['head', 'old', 'new']) {
        if (!options[name]) throw new ArgumentError(`policy-review requires --${name}`);
    }
    if (!options.staged && !options.transition) {
        throw new ArgumentError('policy-review requires --staged or --transition <commit>');
    }
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    const head = resolveCommit(repo, options.head);
    const transition = options.staged ? 'staged' : resolveCommit(repo, options.transition);
    const expectedOld = normalizeObjectId(options.old, false);
    const expectedNew = normalizeObjectId(options.new, true);
    let oldPolicies;
    let newPolicy;
    if (options.staged) {
        oldPolicies = [resolvePolicy(repo, { target: 'commit', revision: head })];
        newPolicy = resolvePolicy(repo, { target: 'staged' });
    } else {
        const transitionInfo = commitParents(repo, transition);
        oldPolicies = transitionInfo.parents.map((parent) => (
            resolvePolicy(repo, { target: 'commit', revision: parent })
        ));
        newPolicy = resolvePolicy(repo, { target: 'commit', revision: transition });
    }
    const oldPolicy = oldPolicies.find((policy) => policy.policy_object_id === expectedOld);
    if (!oldPolicy || oldPolicy.profile !== 'strict') {
        throw new ArgumentError('--old must identify a strict policy object in the reviewed transition baseline');
    }
    if ((newPolicy.policy_object_id ?? null) !== expectedNew) {
        throw new ArgumentError('--new does not identify the policy object at the reviewed transition');
    }
    const newMode = newPolicy.policy_mode;
    if (newMode !== null && !['100644', '100755'].includes(newMode)) {
        throw new ArgumentError(
            `policy-review target must be a regular Git file, not mode ${newMode || 'unknown'}`,
        );
    }
    if (newPolicy.profile === 'strict' && newPolicy.policy_object_id) {
        throw new ArgumentError('policy-review is only for an intentional strict policy downgrade or removal');
    }
    const entry = {
        target: '.aimhooman.json',
        scope: 'policy-migration',
        head,
        transition,
        oldObjectId: expectedOld,
        newObjectId: expectedNew,
        newMode,
        reason: options.reason || '',
        actor: gitConfig(repo.root, 'user.email'),
        at: new Date().toISOString(),
    };
    return withLock(join(repo.stateDir, 'overrides.json.lock'), () => {
        const overrides = loadOverrides(repo.stateDir);
        overrides.allow = upsert(overrides.allow, entry, (candidate) => (
            candidate.scope === entry.scope
            && candidate.head === head
            && candidate.transition === transition
            && candidate.oldObjectId === expectedOld
            && (candidate.newObjectId ?? null) === expectedNew
            && (candidate.newMode ?? null) === newMode
        ));
        saveOverrides(repo.stateDir, overrides);
        console.log(`aimhooman: recorded policy review for ${transition} at ${head}`);
        return 0;
    });
}

function normalizeObjectId(value, allowMissing) {
    if (allowMissing && value === 'missing') return null;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value || '')) {
        throw new ArgumentError(`object ID must be a full SHA-1/SHA-256 value${allowMissing ? ' or "missing"' : ''}`);
    }
    return value.toLowerCase();
}

function upsert(list, entry, matches = (candidate) => candidate.target === entry.target) {
    const i = list.findIndex(matches);
    if (i >= 0) {
        list[i] = entry;
        return list;
    }
    return [...list, entry];
}

function cmdFix(args) {
    const { options } = parseArguments(args, {
        options: {
            message: { names: ['--message', '-m'], type: 'string' },
            apply: { names: ['--apply'], type: 'boolean' },
        },
        maxPositionals: 0,
    });
    if (!options.message) throw new ArgumentError('fix requires --message <file>');
    const file = options.message;
    let sourceBytes;
    try {
        sourceBytes = readFileSync(file);
    } catch (e) {
        console.error(`aimhooman: cannot read message file: ${e.message}`);
        return 30;
    }
    const data = sourceBytes.toString('utf8');
    const validUtf8 = Buffer.from(data, 'utf8').equals(sourceBytes);
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    let scan;
    try {
        scan = scanMessage(repo, data, { target: 'staged' });
    } catch (e) {
        console.error(`aimhooman: cannot inspect message: ${e.message}`);
        return expectedErrorCode(e);
    }
    emitDiagnostics(scan.diagnostics);
    if (!scan.complete) process.stderr.write(incompleteMessage(scan));
    if (scan.profile === 'compliance') {
        if (options.apply) throw new ArgumentError('--apply is only valid when the active profile is strict');
        if (scan.findings.length) process.stderr.write(human(scan.findings, tone()));
        console.log('aimhooman: compliance policy preserves attribution disclosures; no changes made');
        return exitCode(scan.findings, scan.profile, scan.complete);
    }
    let repair = scan.repair;
    if (scan.profile === 'strict') {
        const previewPolicy = {
            profile: 'clean',
            source: scan.policy_source,
            target: scan.target,
            policy_object_id: scan.policy_object_id,
        };
        try {
            repair = engineForPolicy(repo, previewPolicy).engine.fixMessage(data);
        } catch (error) {
            console.error(`aimhooman: cannot prepare safe repair: ${error.message}`);
            return expectedErrorCode(error);
        }
        if (!options.apply) {
            let remaining = scan.findings;
            let remainingComplete = scan.complete;
            if (repair.removed.length) {
                try {
                    const recheck = scanMessage(repo, repair.cleaned, { target: 'staged' });
                    remaining = recheck.findings;
                    remainingComplete = recheck.complete;
                } catch (error) {
                    console.error(`aimhooman: cannot verify repair preview: ${error.message}`);
                    return expectedErrorCode(error);
                }
            }
            if (remaining.length) process.stderr.write(human(remaining, tone()));
            console.error(
                repair.removed.length
                    ? `aimhooman: strict policy would remove ${repair.removed.length} exact attribution line(s); rerun with --apply to write the repair`
                    : 'aimhooman: strict policy found no automatically repairable attribution lines'
            );
            return remaining.some((finding) => finding.decision === 'block')
                ? 10
                : repair.removed.length ? 11 : exitCode(remaining, scan.profile, remainingComplete);
        }
    } else if (options.apply) {
        throw new ArgumentError('--apply is only needed when the active profile is strict');
    }
    const { cleaned, removed } = repair;
    if (!removed.length) {
        if (scan.findings.length) process.stderr.write(human(scan.findings, tone()));
        console.log('aimhooman: nothing to fix');
        return exitCode(scan.findings, scan.profile, scan.complete);
    }
    if (!validUtf8) {
        console.error('aimhooman: message is not valid UTF-8; no bytes were changed because a safe repair cannot be proved');
        if (scan.findings.length) process.stderr.write(human(scan.findings, tone()));
        return 10;
    }
    try {
        atomicWrite(file + '.aimhooman-bak', sourceBytes);
        atomicWrite(file, cleaned);
    } catch (e) {
        console.error(`aimhooman: cannot write fixed message: ${e.message}`);
        return 30;
    }
    console.log(`aimhooman: removed ${removed.length} attribution line(s); backup at ${file}.aimhooman-bak`);
    let verified;
    try {
        verified = scanMessage(repo, cleaned, { target: 'staged' });
    } catch (error) {
        console.error(`aimhooman: repair was written but verification failed: ${error.message}`);
        return expectedErrorCode(error);
    }
    emitDiagnostics(verified.diagnostics);
    if (verified.findings.length) process.stderr.write(human(verified.findings, tone()));
    return exitCode(verified.findings, verified.profile, verified.complete);
}

function cmdDoctor(args) {
    parseNoArguments(args);
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    let ok = true;
    try {
        const worktree = resolvePolicy(repo, { target: 'worktree' });
        const staged = resolvePolicy(repo, { target: 'staged' });
        let head = 'unborn';
        try {
            const committed = resolvePolicy(repo, { target: 'commit', revision: 'HEAD' });
            head = `${committed.profile}/${committed.source}`;
        } catch (error) {
            if (!(error instanceof GitRevisionError)) throw error;
        }
        console.log(`ok policy loads (worktree=${worktree.profile}/${worktree.source}, staged=${staged.profile}/${staged.source}, HEAD=${head})`);
    } catch (e) {
        console.log(`x project policy: ${e.message}`);
        ok = false;
    }
    try {
        const { engine, errors } = newEngineWithDiagnostics('clean', repo.stateDir);
        console.log(`ok rule pack loads (${engine.rules.length} rules)`);
        for (const error of errors) {
            console.log(`x local rule pack: ${error.message}`);
            ok = false;
        }
        const excludes = inspectExclude(repo.excludeFile, patternsForRules(engine.rules));
        if (excludes.current) console.log('ok managed excludes are current');
        else {
            console.log('x managed excludes missing or out of date (run: aimhooman init)');
            ok = false;
        }
    } catch (e) {
        console.log(`x rule pack: ${e.message}`);
        ok = false;
    }
    try {
        const overrides = loadOverrides(repo.stateDir);
        const overrideEngine = newEngineWithDiagnostics('clean', repo.stateDir).engine;
        const duplicate = duplicateOverride(overrides.allow, overrideEngine)
            || duplicateOverride(overrides.deny, overrideEngine);
        const allowTargets = new Set(overrides.allow
            .filter((entry) => !entry.head)
            .map((entry) => overrideIdentity(entry, overrideEngine)));
        const conflict = overrides.deny.find((entry) => (
            !entry.head && allowTargets.has(overrideIdentity(entry, overrideEngine))
        ));
        if (duplicate || conflict) {
            console.log(`x overrides contain ${duplicate ? `duplicate "${duplicate}"` : `allow/deny conflict "${conflict.target}"`}`);
            ok = false;
        } else {
            console.log(`ok overrides load (${overrides.allow.length} allow, ${overrides.deny.length} deny)`);
        }
    } catch (error) {
        console.log(`x overrides: ${error.message}`);
        ok = false;
    }
    const hooks = hookDiagnostics(repo);
    const incompleteHooks = hooks.filter((hook) => !hook.managed || !hook.executable || !hook.reachable);
    if (incompleteHooks.length) console.log(`x hooks incomplete (${incompleteHooks.map((hook) => hook.name).join(', ')}; run: aimhooman init)`);
    for (const hook of hooks) {
        if (!hook.managed || !hook.executable || !hook.reachable) {
            console.log(`x ${hook.name} hook: ${hook.reason || 'not active'} (${hook.path})`);
            ok = false;
        } else {
            console.log(`ok ${hook.name} hook v${hook.version} is fingerprint-valid and reachable`);
        }
    }
    const localHooks = gitConfigAtScope(repo.root, '--local', 'core.hooksPath');
    const globalHooks = gitConfigAtScope(repo.root, '--global', 'core.hooksPath');
    console.log(`ok hook paths inspected (local=${localHooks || 'unset'}, global=${globalHooks || 'unset'})`);
    const adapters = adapterStatus();
    if (adapters.missing.length) {
        console.log(`x host adapters missing: ${adapters.missing.join(', ')}`);
        ok = false;
    } else {
        console.log(`ok host adapters present (${adapters.present}/${adapters.total})`);
    }
    const gitRuntime = supportedGitVersion();
    if (gitRuntime.supported) {
        console.log(`ok runtime Node ${process.versions.node}; ${gitRuntime.display}`);
    } else {
        console.log(`x runtime Node ${process.versions.node}; ${gitRuntime.display} (Git 2.28.0+ required)`);
        ok = false;
    }
    console.log(`ok state directory ${repo.stateDir}`);
    if (!ok) return 20;
    console.log('aimhooman: healthy');
    return 0;
}

function duplicateOverride(entries, engine) {
    const seen = new Set();
    for (const entry of entries) {
        const key = [
            entry.target,
            effectiveOverrideScope(entry, engine),
            entry.head || '',
            entry.transition || '',
            entry.oldObjectId || '',
            entry.newObjectId ?? '',
        ].join('\0');
        if (seen.has(key)) return entry.target;
        seen.add(key);
    }
    return '';
}

function effectiveOverrideScope(entry, engine) {
    return entry.scope ?? (engine.lookup(entry.target) ? 'rule' : 'path');
}

function overrideIdentity(entry, engine) {
    return `${effectiveOverrideScope(entry, engine)}\0${entry.target}`;
}

function adapterStatus() {
    try {
        const registry = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'docs/hosts.json'), 'utf8'));
        const paths = [...new Set((registry.hosts || []).flatMap((host) => host.files || []))];
        const missing = [];
        for (const path of paths) {
            try { readFileSync(join(PACKAGE_ROOT, path)); }
            catch { missing.push(path); }
        }
        return { total: paths.length, present: paths.length - missing.length, missing };
    } catch (error) {
        return { total: 1, present: 0, missing: [`host registry unavailable: ${error.message}`] };
    }
}

function cmdUninstall(args) {
    const { options } = parseArguments(args, {
        options: {
            global: { names: ['--global'], type: 'boolean' },
            purgeState: { names: ['--purge-state'], type: 'boolean' },
        },
        conflicts: [['global', 'purgeState']],
        maxPositionals: 0,
    });
    if (options.global) {
        return withLock(join(globalHooksDir(), 'lifecycle.lock'), () => {
        const aimDir = globalHooksDir();
        const readGlobalHooksPath = () => {
            try {
                return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
            } catch { return ''; }
        };
        const current = readGlobalHooksPath();
        let unsetAttempted = false;
        if (current === aimDir) {
            unsetAttempted = true;
            try {
                execFileSync('git', ['config', '--global', '--unset', 'core.hooksPath'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: GIT_TIMEOUT_MS });
            } catch { /* may have failed; re-verify below */ }
            // A read-only or locked ~/.gitconfig can make --unset fail silently.
            // Do not remove the dispatchers while core.hooksPath still resolves to
            // them, or every repository inheriting this setting would run zero
            // hooks with no warning. Preserve the working dispatchers until the
            // config can be cleaned.
            if (readGlobalHooksPath() === aimDir) {
                console.error('aimhooman: could not unset global core.hooksPath (read-only or locked ~/.gitconfig); leaving dispatchers in place.');
                console.error('  Fix the config permissions and run `aimhooman uninstall --global` again.');
                return 30;
            }
        }
        const rep = uninstallGlobalHooks();
        console.log('aimhooman: global hooks uninstalled');
        if (current && current !== aimDir) {
            console.log(`  core.hooksPath kept at "${current}" (not owned by aimhooman)`);
        } else {
            console.log(`  core.hooksPath ${unsetAttempted ? 'unset' : 'was already unset'}`);
        }
        if (rep.removed.length) console.log(`  dispatchers removed: ${rep.removed.join(', ')}`);
        for (const w of rep.warnings || []) console.log(`  warning: ${w}`);
        console.log(`  dir kept at ${rep.dir}`);
        return 0;
        }, LIFECYCLE_LOCK_OPTIONS);
    }
    const purge = Boolean(options.purgeState);
    const repo = tryRepo();
    if (!repo) {
        console.error('aimhooman: not a git repository');
        return 30;
    }
    const lifecycleLock = join(repo.commonDir, 'aimhooman-lifecycle.lock');
    const exitStatus = withLock(lifecycleLock, () => {
    const rep = uninstallHooks(repo);
    // The irreversible work is already done above, and the report is still
    // below. A throw from here unwound past all of it, so a damaged marker was
    // the only thing the user heard while four dispatchers kept guarding every
    // commit. Report the failure beside the removal report instead of in place
    // of it. Nothing is swallowed: this is also where the symlink and permission
    // guards surface, and their messages still reach the user and still exit 30.
    let excludeFailure = '';
    try {
        removeExclude(repo.excludeFile);
    } catch (error) {
        excludeFailure = `exclude block left in ${repo.excludeFile}: ${error.message}`;
    }
    // Trust the directory, not the report. Every refusal below leaves a working
    // dispatcher behind, and one printed under "uninstalled" reads as done.
    const remaining = remainingDispatchers(repo);
    if (remaining.length) {
        console.error('aimhooman: NOT uninstalled; leaving dispatchers in place:');
        for (const path of remaining) console.error(`  ${path}`);
        console.error('  These still guard every commit. Remove them by hand to finish uninstalling.');
    } else {
        console.log('aimhooman: uninstalled');
    }
    if (rep.removed.length) console.log(`  hooks removed:  ${rep.removed.join(', ')}`);
    if (rep.restored.length) console.log(`  hooks restored: ${rep.restored.join(', ')}`);
    for (const w of rep.warnings || []) console.log(`  warning: ${w}`);
    for (const f of rep.failures || []) console.error(`  failure: ${f}`);
    if (excludeFailure) console.error(`  failure: ${excludeFailure}`);
    const unrestored = purge ? unrestoredChainedBackups(repo) : [];
    if (purge) {
        // Never wipe stateDir while a predecessor hook backup is still on disk:
        // a per-hook restore failure leaves the user's original hook existing
        // only in <stateDir>/chained, so purging would destroy it irrecoverably.
        if (unrestored.length || rep.failures?.length) {
            console.error(
                'aimhooman: state NOT purged — '
                + `${unrestored.length} chained hook backup(s) remain unrestored`
                + `${rep.failures?.length ? ` (failures: ${rep.failures.join('; ')})` : ''}; `
                + "re-run 'aimhooman uninstall' to retry restore before purging."
            );
        } else {
            rmSync(repo.stateDir, { recursive: true, force: true });
            console.log('  state purged');
        }
    } else {
        console.log(`  state kept at ${repo.stateDir} (use --purge-state to remove)`);
    }
    // Surface when a global core.hooksPath still enforces aimhooman, so a local
    // uninstall cannot be mistaken for full removal. Foreign hooksPath values
    // are left to the generic "not modified" warning emitted above.
    const aimDir = globalHooksDir();
    let globalHooksPath = '';
    try {
        globalHooksPath = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
        }).trim();
    } catch { /* unset */ }
    if (globalHooksPath === aimDir) {
        console.log('aimhooman: global Git guard is still active');
        console.log('  eligible non-bare repositories that inherit core.hooksPath are still guarded.');
        console.log('  run `aimhooman uninstall --global` to remove it.');
    }
    // The managed block is still in the exclude file and still ignoring paths, so
    // the uninstall is genuinely incomplete and 30 is the honest answer.
    return remaining.length || rep.failures?.length || unrestored.length || excludeFailure ? 30 : 0;
    }, LIFECYCLE_LOCK_OPTIONS);
    // Sweep the operational residue the guard authored in .git, so uninstall leaves
    // no aimhooman fingerprints behind — the same tooling residue this tool exists
    // to remove. rmdirSync deletes only an empty directory, so a live contender's
    // queue is never touched; the lifecycle queue becomes removable only now, after
    // its own lock above has released.
    for (const queue of [
        `${lifecycleLock}.queue`,
        `${repo.excludeFile}.aimhooman.lock.queue`,
        join(effectiveHooksDir(repo), '.aimhooman-hooks.lock.queue'),
    ]) {
        try { rmdirSync(queue); } catch { /* held by another aimhooman, or already gone */ }
    }
    // A one-commit-ago attribution backup that git's next COMMIT_EDITMSG makes
    // stale. It lands beside git's message file, which lives in the per-worktree
    // git directory — not the common one. Uninstall disarms every worktree at
    // once, so sweep the main git directory and each linked worktree, or
    // "state purged" stays a lie for whichever worktree last stripped a message.
    const messageDirs = [repo.commonDir];
    try {
        const linked = join(repo.commonDir, 'worktrees');
        for (const name of readdirSync(linked)) messageDirs.push(join(linked, name));
    } catch { /* no linked worktrees */ }
    for (const dir of messageDirs) {
        try { rmSync(join(dir, 'COMMIT_EDITMSG.aimhooman-bak'), { force: true }); }
        catch { /* nothing to remove */ }
    }
    return exitStatus;
}

function usage() {
    process.stdout.write(`aimhooman ${VERSION} - AI works. Hoomans ship.

Usage:
  aimhooman init [--profile clean|strict|compliance]
  aimhooman init --global --yes
  aimhooman check [--staged] [-m <file>|--message <file>] [--profile ...] [--json]
  aimhooman check --commit <rev> | --range <base>...<head> | --tracked
  aimhooman audit|scan [--json] [--profile ...]
  aimhooman status
  aimhooman explain <rule-id>
  aimhooman allow <path|rule-id> [--scope path|rule|secret-path] [--reason "..."]
  aimhooman deny <path|rule-id> [--scope path|rule] [--reason "..."]
  aimhooman override list [--json]
  aimhooman override remove <target>
  aimhooman override reset [--allow|--deny|--all]
  aimhooman review <instruction-path> --head <commit> [--commit <source>] [--reason "..."]
  aimhooman policy-review --head <commit> (--staged|--transition <commit>) --old <oid> --new <oid|missing> [--reason "..."]
  aimhooman fix [-m <file>|--message <file>] [--apply (strict only)]
  aimhooman doctor
  aimhooman uninstall [--purge-state]
  aimhooman uninstall --global
  aimhooman version

Exit codes: 0 clean, 10 blocked, 11 review required, 20 invalid input or policy,
30 Git or I/O failure, 31 incomplete scan.
`);
}

const argv = process.argv.slice(2);
if (argv[0] === 'hook') {
    const hookArgs = argv.slice(1);
    if (hookArgs.length !== 1 || !['session-start', 'pre-tool-use'].includes(hookArgs[0])) {
        console.error('aimhooman: hook requires exactly one supported event');
        process.exit(20);
    }
    // hook.mjs (the PreToolUse shell parser) is by far the largest module and is
    // only needed for the `hook` subcommand. Loading it lazily cuts the heaviest
    // parse cost from every other command's startup, so the lifecycle-lock
    // candidate is published earlier. This widens the margin under the queue-wait
    // budget rather than guaranteeing it: openRepo's git spawns still set the
    // floor on slow runners.
    import('../src/hook.mjs')
        .then(({ runHook }) => runHook(hookArgs))
        .then((code) => {
            // Drain the permission decision before exiting: on a piped stdout,
            // process.exit() can cut off the emit() write and drop a deny. The
            // callback fires once the buffer is flushed to the OS.
            process.stdout.write('', () => process.exit(code));
        })
        .catch((error) => {
            console.error(`aimhooman: hook failed: ${error.message}`);
            process.exit(20);
        });
} else {
    try {
        process.exitCode = main(argv);
    } catch (error) {
        if (error instanceof ArgumentError) {
            console.error(`aimhooman: ${error.message}`);
            process.exitCode = 20;
        } else {
            console.error(`aimhooman: ${error.message}`);
            process.exitCode = expectedErrorCode(error);
        }
    }
}
