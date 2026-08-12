// The Git-boundary guard engine shared by the hook-facing commands
// (precommit, commitmsg, refcheck, pushcheck). These pieces decide, repair,
// and deduplicate; argument parsing, stderr summaries, and exit-code plumbing
// stay with the CLI surface in bin/aimhooman.mjs, so this logic can be
// exercised without spawning it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_TIMEOUT_MS } from './git-environment.mjs';
import {
    introducedCommits,
    stagedPaths,
    stagedRenameSources,
    stagedTreeSha,
    unstagePaths,
} from './gitx.mjs';
import { installedHooks } from './githooks.mjs';
import { commitParents } from './history-scan.mjs';
import { scanGitTarget } from './scan-target.mjs';
import {
    emitDiagnostics,
    exitCode,
    expectedErrorCode,
    human,
    incompleteMessage,
    tone,
} from './report.mjs';

export const REQUIRED_GIT_HOOKS = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'reference-transaction'];

export function dispatchHooksChanged(repo, profile) {
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

// One oversized file trips the same non-blocking "scan incomplete" warning in
// up to three hooks of a single commit (pre-commit, commit-msg, the final ref
// guard) and again in pre-push. Print it once per tree and gap: the first
// guard to warn records the tree plus the skip signature, later guards stay
// silent for the identical gap. State failures degrade to printing — a
// duplicate warning is noise, a swallowed one is a miss.
const INCOMPLETE_NOTICE_VERSION = 1;
export function warnIncompleteOnce(repo, treeSha, scan) {
    const signature = createHash('sha256')
        .update(JSON.stringify([scan.stats?.skipped || {}, scan.stats?.skippedPaths || {}]))
        .digest('hex');
    if (treeSha) {
        try {
            const statePath = join(repo.stateDir, 'incomplete-notice.json');
            let previous = null;
            try { previous = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run or corrupt state */ }
            if (previous?.version === INCOMPLETE_NOTICE_VERSION
                && previous.tree === treeSha
                && previous.signature === signature) return;
            writeFileSync(statePath, JSON.stringify({ version: INCOMPLETE_NOTICE_VERSION, tree: treeSha, signature }));
        } catch { /* fall through to printing */ }
    }
    process.stderr.write(incompleteMessage(scan, { blocking: false }));
}

// W5 pre-commit/commit-msg marker dedup. pre-commit writes a marker after a
// clean, complete scan of the staged tree; commit-msg reads it and skips its
// duplicate ~170ms tree scan when the staged tree sha, profile, and
// completeness all match. The marker lives in stateDir (gitignored plumbing).
// It is self-invalidating: any index mutation between the two hooks changes the
// tree sha, so a stale marker never matches. A missing/corrupt/mismatched
// marker makes commit-msg fall back to the full scan, so this is purely an
// optimization and never weakens the guard.
const PRECOMMIT_CLEAN_VERSION = 1;
function precommitCleanPath(repo) {
    return join(repo.stateDir, 'precommit-clean.json');
}
export function recordPrecommitClean(repo, profile) {
    let treeSha;
    try {
        treeSha = stagedTreeSha(repo);
    } catch {
        return; // cannot compute the sha → do not record; commit-msg will scan
    }
    try {
        writeFileSync(precommitCleanPath(repo), JSON.stringify({
            version: PRECOMMIT_CLEAN_VERSION,
            tree: treeSha,
            profile,
            complete: true,
        }));
    } catch {
        // best effort; a missing marker just means commit-msg scans normally
    }
}
export function precommitCleanMatches(repo, treeSha, profile) {
    let marker;
    try {
        marker = JSON.parse(readFileSync(precommitCleanPath(repo), 'utf8'));
    } catch {
        return false; // missing/corrupt → fall back to full scan
    }
    return marker?.version === PRECOMMIT_CLEAN_VERSION
        && marker.complete === true
        && marker.tree === treeSha
        && marker.profile === profile;
}

// repairStagedBlocks unstages every blocked path plus the rename sources that
// would re-materialize one, retries under load, and reports whether the repair
// emptied the index. Throws when the unstage itself fails; the caller decides
// what that means for the commit.
export function repairStagedBlocks(repo, blocks, paths) {
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
    // collateral is what the repair took beyond the blocked paths themselves:
    // staged deletions kept as possible rename sources. The caller has to name
    // them, or the developer commits a message describing a removal the commit
    // no longer carries.
    const blocked = new Set(paths);
    return {
        emptied: stagedBefore !== null && stagedBefore.every((path) => unstageTargets.has(path)),
        collateral: [...unstageTargets].filter((path) => !blocked.has(path)),
    };
}

// resolveIntroduced maps each proposed update to the commits it introduces,
// with the review contexts and local-authorship flags the scan needs. Shared
// by refcheck (local ref updates) and pushcheck (about-to-be-pushed refs).
// includeStagedContexts carries a staged review into the direct tip's scan;
// pushcheck leaves it off because a pushed commit is judged as an object, not
// against the live index it may never have passed through.
export function resolveIntroduced(repo, updates, { includeStagedContexts = true } = {}) {
    const contextsByCommit = new Map();
    // A commit's message belongs to whoever wrote it. Attribution and marker
    // rules police the text a local developer can edit, so they are scoped
    // to commits authored here: an update that introduces exactly one new
    // commit on top of a non-zero old tip (a plain commit, an --amend, or a
    // local --no-ff merge of an already-gated branch). Anything else — a new
    // branch pulled in by `gh pr checkout` or `git fetch`, a merge of fetched
    // history — imports other people's commit text the developer cannot
    // change, and scanning it only blocks the review.
    const localAuthorTips = new Set();
    for (const update of updates) {
        const introduced = introducedCommits(repo, [update]);
        if (!/^0+$/.test(update.oldObjectId)
            && introduced.length === 1
            && introduced[0] === update.newObjectId) {
            localAuthorTips.add(update.newObjectId);
        }
        for (const revision of introduced) {
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
            if (includeStagedContexts && revision === update.newObjectId && !/^0+$/.test(update.oldObjectId)) {
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
    return [...contextsByCommit].map(([revision, reviewContexts]) => [
        revision,
        reviewContexts,
        localAuthorTips.has(revision),
    ]);
}

// scanProposedCommits scans each introduced commit and returns the first
// non-zero verdict. rejectNote(revision) supplies the caller-specific veto
// line(s) printed after the findings; callers without a note pass null. The
// scan budget comes from the caller: it is CLI environment input, parsed and
// validated at the surface.
export function scanProposedCommits(repo, commits, { rejectNote, limits = {} }) {
    for (const [revision, reviewContexts, authoredLocally] of commits) {
        let scan;
        try {
            scan = scanGitTarget(repo, {
                kind: 'commit',
                revision,
                reviewContexts,
                policyMigrationContexts: reviewContexts,
                limits,
                messageScope: authoredLocally ? 'commit' : 'changes-only',
                // This guard runs over history the developer is receiving, not
                // writing. A policy it cannot parse must not wedge every pull,
                // merge and reset with no way forward.
                tolerateUnreadablePolicy: true,
            });
        }
        catch (error) {
            console.error(`aimhooman: cannot scan proposed commit ${revision}: ${error.message}`);
            return expectedErrorCode(error);
        }
        emitDiagnostics(scan.diagnostics);
        // The reference transaction is the final boundary --no-verify cannot
        // skip, so an incomplete scan vetoes the update on every profile, even
        // though earlier guards let frictionless profiles through with a
        // warning. The single carve-out (a size-limit-only gap, see exitCode)
        // warns here instead of vetoing.
        const code = exitCode(scan.findings, scan.profile, scan.complete, {
            failClosedIncomplete: true,
            incompleteReasons: scan.incomplete_reasons,
        });
        if (code !== 0) {
            process.stderr.write(human(scan.findings, tone()));
            if (!scan.complete) process.stderr.write(incompleteMessage(scan));
            if (rejectNote) process.stderr.write(rejectNote(revision));
            return code;
        }
        if (!scan.complete) {
            // The commit's tree is the staged tree pre-commit already warned
            // about, so this is usually the duplicate the once-guard swallows.
            // rev-parse runs only on this rare path.
            let treeSha = null;
            try {
                treeSha = execFileSync('git', ['rev-parse', `${revision}^{tree}`], {
                    cwd: repo.root,
                    encoding: 'utf8',
                    timeout: GIT_TIMEOUT_MS,
                }).trim();
            } catch { /* warn without dedup */ }
            warnIncompleteOnce(repo, treeSha, scan);
        }
    }
    return 0;
}
