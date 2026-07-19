import { Engine, newEngineWithDiagnostics } from './scan.mjs';
import { loadOverrides } from './state.mjs';
import { applyExplicitProfile, applyStrictFloor, resolvePolicy } from './policy-resolver.mjs';
import {
    GitRevisionError,
    stagedEntries,
    trackedEntries,
    unmergedPaths,
} from './gitx.mjs';
import { commitChanges, commitMessage, commitSnapshot, historyRange } from './history-scan.mjs';
import { DEFAULT_SCAN_LIMITS, scanEntries } from './scan-session.mjs';
import { loadRulesWithDiagnostics } from './rules.mjs';

// A tiebreak for the one profile a range report has to name, not a strength
// lattice. Clean and compliance are not ordered against each other: compliance
// allows the six attribution rules clean blocks or reviews, no shipped rule runs
// the other way, and applyExplicitProfile refuses to move between them in either
// direction. No single profile is truthful for a mixed range, so this only
// settles which policy object gets reported — clean outranks compliance because
// a value read as the strongest must not name the profile that allows what the
// other blocks. Enforcement never reads this: each commit is scanned under its
// own policy and the exit code uses each finding's own scanProfile.
const PROFILE_RANK = { compliance: 0, clean: 1, strict: 2 };
const REVIEW_REQUIRED_PATH_RULES = new Set([
    'generic.agent-instructions',
    'generic.project-policy',
]);

class PolicyRulesError extends Error {
    constructor(errors) {
        super(errors.map((error) => error.message).join('; '));
        this.name = 'PolicyRulesError';
        this.errors = errors;
    }
}

export function scanGitTarget(repo, options = {}) {
    const kind = options.kind || 'staged';
    if (kind === 'range') return scanRange(repo, options);
    if (kind === 'commit') return scanCommit(repo, options);
    if (kind === 'staged' || kind === 'tracked') return scanIndex(repo, options);
    throw new TypeError(`unsupported scan target "${kind}"`);
}

export function scanMessage(repo, text, options = {}) {
    const protectHead = (options.target === 'staged' || options.target?.kind === 'staged')
        && options.protectHead !== false;
    const resolved = protectHead
        ? resolveStagedPolicy(repo, options.explicitProfile)
        : {
            policy: effectivePolicy(
                resolvePolicy(repo, { target: options.target || 'worktree' }),
                options.explicitProfile,
                null,
            ),
            head: null,
        };
    const { policy, head } = resolved;
    const loaded = engineForPolicy(repo, policy, options.overrideHead || head);
    const accumulator = createAccumulator(options.limits);
    accumulator.addSkipped(loaded.skipped);
    accumulator.add(loaded.engine.checkMessage(text).map((finding) => decorate(finding, null, policy)));
    accumulator.addSkipped(loaded.engine.takeSkipped());
    return {
        ...result({
        target: 'message',
        policy,
        accumulator,
        diagnostics: loaded.diagnostics,
        messageScanned: true,
        }),
        repair: loaded.engine.fixMessage(text),
    };
}

function scanIndex(repo, options) {
    const kind = options.kind || 'staged';
    const { rawPolicy, floor, policy, head, acknowledged } = resolveStagedPolicy(repo, options.explicitProfile);
    const loaded = engineForPolicy(repo, policy, options.overrideHead || head);
    const accumulator = createAccumulator(options.limits);
    accumulator.addSkipped(loaded.skipped);
    let entries = kind === 'tracked' ? trackedEntries(repo) : stagedEntries(repo);
    const conflicts = unmergedPaths(repo);
    const diagnostics = [...loaded.diagnostics];

    if (conflicts.length) {
        if (kind === 'staged') {
            const conflictPaths = new Set(conflicts);
            entries = entries.concat(trackedEntries(repo).filter((entry) => (
                entry.stage > 0 && conflictPaths.has(entry.path)
            )));
        }
        diagnostics.push({
            level: 'warning',
            message: `index contains ${conflicts.length} unresolved path(s); all conflict stages were scanned, but no single staged snapshot exists`,
        });
        // A reviewed-path override can suppress a matching path rule, but it
        // cannot turn an unresolved index into a complete commit snapshot.
        accumulator.markIncomplete();
    }

    if (floor && !isVersionedStrict(rawPolicy)) {
        accumulator.add([protectedPolicyFinding(rawPolicy, policy, null)]);
    }
    scanEntryGroup(repo, loaded.engine, entries, policy, accumulator, {
        allowMissingPolicy: acknowledged && !rawPolicy.policy_object_id,
        transition: 'staged',
    });
    if (options.messageText !== undefined) {
        accumulator.add(loaded.engine.checkMessage(options.messageText)
            .map((finding) => decorate(finding, null, policy)));
        accumulator.addSkipped(loaded.engine.takeSkipped());
    }
    return result({
        target: kind,
        policy,
        accumulator,
        diagnostics,
        messageScanned: options.messageText !== undefined,
    });
}

export function resolveStagedPolicy(repo, explicitProfile) {
    const rawPolicy = resolvePolicy(repo, { target: 'staged' });
    const baseline = headPolicy(repo);
    const baselineStrict = isVersionedStrict(baseline);
    const head = baseline?.target?.startsWith('commit:') ? baseline.target.slice('commit:'.length) : null;
    const acknowledged = baselineStrict && policyMigrationAllowed(repo, {
        head,
        transition: 'staged',
        oldObjectIds: [baseline.policy_object_id],
        newObjectId: rawPolicy.policy_object_id,
        newMode: rawPolicy.policy_mode,
    });
    const floor = baselineStrict && !acknowledged && !isVersionedStrict(rawPolicy)
        ? 'head-strict-floor'
        : null;
    return {
        rawPolicy,
        floor,
        head,
        acknowledged,
        policy: effectivePolicy(
            rawPolicy,
            explicitProfile,
            floor,
            baselineStrict ? [baseline.policy_object_id] : [],
        ),
    };
}

function scanCommit(repo, options) {
    if (!options.revision) throw new TypeError('commit scan needs a revision');
    const snapshot = commitSnapshot(repo, options.revision);
    const rawPolicy = resolvePolicy(repo, { target: 'commit', revision: snapshot.commit });
    // Bind policy-migration acks to the repository's current HEAD — the state an
    // ack is recorded against (policy-review --head <repo HEAD> --transition X) —
    // matching scanRange and resolveStagedPolicy. Probing with snapshot.commit
    // almost never matched a real ack, so `check --commit X` spuriously blocked
    // transitions that `check --range` honored. Exact-match security on every
    // ack field is unchanged; a null head simply fails closed (no ack honored).
    const headBaseline = headPolicy(repo);
    const head = headBaseline?.target?.startsWith('commit:')
        ? headBaseline.target.slice('commit:'.length) : null;
    const strictParentPolicies = snapshot.parents
        .map((parent) => resolvePolicy(repo, { target: 'commit', revision: parent }))
        .filter(isVersionedStrict);
    const policyMigrationContexts = options.policyMigrationContexts ?? (head ? [{
        head,
        transition: snapshot.commit,
    }] : []);
    const acknowledged = strictParentPolicies.length > 0 && policyMigrationContexts.some((context) => (
        policyMigrationAllowed(repo, {
            head: context?.head,
            transition: context?.storedTransition ?? context?.transition,
            oldObjectIds: strictParentPolicies.map((policy) => policy.policy_object_id),
            newObjectId: rawPolicy.policy_object_id,
            newMode: rawPolicy.policy_mode,
        })
    ));
    const floor = strictParentPolicies.length > 0 && !acknowledged && !isVersionedStrict(rawPolicy)
        ? 'parent-strict-floor'
        : null;
    const policy = effectivePolicy(
        rawPolicy,
        options.explicitProfile,
        floor,
        strictParentPolicies.map((candidate) => candidate.policy_object_id),
    );
    const reviewContexts = options.reviewContexts ?? (head ? [{
        head,
        transition: snapshot.commit,
    }] : []);
    const loaded = engineForPolicy(
        repo,
        policy,
        head,
        undefined,
        undefined,
        reviewContexts,
    );
    const accumulator = createAccumulator(options.limits);
    accumulator.addSkipped(loaded.skipped);
    const diagnostics = [...loaded.diagnostics];

    if (snapshot.shallowBoundary) {
        const message = 'shallow repository: commit scan cannot prove parent policy; fetch full history (e.g. fetch-depth: 0)';
        if (options.explicitProfile === 'strict' || rawPolicy.profile === 'strict') {
            throw new GitRevisionError(options.revision, message);
        }
        diagnostics.push({ level: 'warning', message });
        accumulator.markIncomplete();
    }

    if (floor && !isVersionedStrict(rawPolicy)) {
        accumulator.add([protectedPolicyFinding(rawPolicy, policy, snapshot)]);
    }
    // A commit is judged by what it changes, not by the whole tree it inherits.
    // Scanning snapshot.entries (a full `ls-tree`) re-applied path rules to
    // every file the commit merely carried forward from its parent, so a path
    // allowed into history once (under an override that was later removed, or
    // before the guard existed) blocked every later commit on the branch. The
    // change set already drives content scanning; routing path rules through it
    // too means a newly added `.env` still fires while an inherited one stays
    // silent, matching how scanRange has always judged history.
    scanEntryGroup(repo, loaded.engine, snapshot.changes, policy, accumulator, {
        reviewPathEntries: snapshot.changes,
        contentEntries: snapshot.changes,
        allowMissingPolicy: acknowledged && !rawPolicy.policy_object_id,
        transition: snapshot.commit,
    });
    // The message is the author's words, so it is scanned for attribution and
    // markers only when the commit was written here. Fetched history (a PR
    // checked out for review, a branch pulled from a remote) carries other
    // people's commit text that a local developer cannot edit, so flagging it
    // only blocks the review. cmdRefcheck passes messageScope='changes-only'
    // for commits that were imported rather than authored; a direct `aimhooman
    // check --commit` still defaults to scanning the message.
    const scanMessageText = options.messageScope !== 'changes-only';
    if (scanMessageText) {
        accumulator.add(loaded.engine.checkMessage(snapshot.message)
            .map((finding) => decorate(finding, snapshot, policy)));
        accumulator.addSkipped(loaded.engine.takeSkipped());
    }
    return result({
        target: `commit:${snapshot.commit}`,
        policy,
        accumulator,
        diagnostics,
        messageScanned: scanMessageText,
        commit: snapshot.commit,
    });
}

function scanRange(repo, options) {
    if (!options.range) throw new TypeError('range scan needs a range');
    const history = historyRange(repo, options.range);
    const basePolicy = history.bootstrap
        ? null
        : resolvePolicy(repo, { target: 'commit', revision: history.scanBase });
    const baseStrict = isVersionedStrict(basePolicy);
    const strictLineage = new Map();
    const rawPolicies = new Map();
    if (!history.bootstrap) {
        strictLineage.set(history.scanBase, new Set(baseStrict ? [basePolicy.policy_object_id] : []));
        rawPolicies.set(history.scanBase, basePolicy);
    }
    const accumulator = createAccumulator(options.limits);
    const diagnostics = [];
    if (history.reversed) {
        diagnostics.push({
            level: 'warning',
            message: 'range selected zero commits because the head is an ancestor of the base; the range endpoints may be reversed',
        });
    }
    if (history.shallow) {
        // A shallow clone (e.g. CI fetch-depth: 1) may omit commits in the range,
        // so completeness cannot be proven. Fail closed under strict; under
        // clean/compliance proceed but mark the scan incomplete so the report's
        // `complete` flag and exit code (31) signal the gap machine-readably,
        // matching the documented CI guidance (fetch-depth: 0).
        const message = 'shallow repository: range scan cannot prove completeness; fetch full history (e.g. fetch-depth: 0)';
        if (options.explicitProfile === 'strict' || baseStrict) {
            throw new GitRevisionError(options.range, message);
        }
        diagnostics.push({ level: 'warning', message });
        accumulator.markIncomplete();
    }
    const policies = [];
    let usedStrictFloor = false;
    // Rule packs are read and compiled once for the whole range; per-commit work
    // only constructs an Engine and applies overrides (see engineForPolicy).
    const preloaded = loadRulesWithDiagnostics(repo.stateDir);
    const preloadedOverrides = loadOverrides(repo.stateDir);
    // Counted once for the range, not once per commit: the same packs back every
    // commit's engine, so the per-commit loaded.skipped would inflate the tally.
    accumulator.addSkipped(packSkipped(preloaded.errors));

    for (const commit of history.commits) {
        const changes = commitChanges(repo, commit.commit, commit.commit, commit.parents);
        const { message } = commitMessage(repo, commit.commit, commit.commit);
        const rawPolicy = resolvePolicy(repo, { target: 'commit', revision: commit.commit });
        rawPolicies.set(commit.commit, rawPolicy);
        const parentStrictObjects = new Set();
        for (const parent of commit.parents) {
            if (strictLineage.has(parent)) {
                for (const objectId of strictLineage.get(parent)) parentStrictObjects.add(objectId);
                continue;
            }
            let parentPolicy = rawPolicies.get(parent);
            if (!parentPolicy) {
                parentPolicy = resolvePolicy(repo, { target: 'commit', revision: parent });
                rawPolicies.set(parent, parentPolicy);
            }
            if (isVersionedStrict(parentPolicy)) parentStrictObjects.add(parentPolicy.policy_object_id);
        }
        const acknowledged = parentStrictObjects.size > 0 && policyMigrationAllowed(repo, {
            head: history.head,
            transition: commit.commit,
            oldObjectIds: [...parentStrictObjects],
            newObjectId: rawPolicy.policy_object_id,
            newMode: rawPolicy.policy_mode,
        }, preloadedOverrides);
        const floor = parentStrictObjects.size > 0 && !acknowledged && !isVersionedStrict(rawPolicy)
            ? 'parent-strict-floor'
            : null;
        usedStrictFloor ||= Boolean(floor);
        const policy = effectivePolicy(rawPolicy, options.explicitProfile, floor, [...parentStrictObjects]);
        policies.push(policy);
        strictLineage.set(commit.commit, new Set(
            isVersionedStrict(rawPolicy)
                ? [rawPolicy.policy_object_id]
                : acknowledged ? [] : parentStrictObjects
        ));
        const loaded = engineForPolicy(repo, policy, history.head, preloaded, preloadedOverrides);
        diagnostics.push(...loaded.diagnostics);

        if (floor && !isVersionedStrict(rawPolicy)) {
            accumulator.add([protectedPolicyFinding(rawPolicy, policy, commit)]);
        }
        scanEntryGroup(repo, loaded.engine, changes.entries, policy, accumulator, {
            allowMissingPolicy: acknowledged && !rawPolicy.policy_object_id,
            transition: commit.commit,
        });
        accumulator.add(loaded.engine.checkMessage(message)
            .map((finding) => decorate(finding, commit, policy)));
        accumulator.addSkipped(loaded.engine.takeSkipped());
    }

    const policy = rangeReportPolicy(basePolicy, policies, usedStrictFloor, options.explicitProfile);
    return result({
        target: `range:${options.range}`,
        policy,
        accumulator,
        diagnostics,
        messageScanned: true,
        commit: history.head,
        range: {
            base: history.base,
            scan_base: history.scanBase,
            head: history.head,
            commits_scanned: history.commits.length,
        },
    });
}

function scanEntryGroup(repo, engine, entries, policy, accumulator, options = {}) {
    const reviewPathEntries = options.reviewPathEntries ?? entries;
    scanReviewPathChanges(engine, reviewPathEntries, policy, accumulator, options);
    const reviewPaths = new Set(reviewPathEntries
        .filter((entry) => entry.status !== 'D' && entry.type !== 'deleted')
        .map((entry) => entry.path));
    const scannable = entries.filter((entry) => entry.status !== 'D' && entry.type !== 'deleted');
    const checkedPathObjects = new Set();
    for (const entry of scannable) {
        const pathObject = `${entry.path}\0${entry.oid || ''}\0${entry.mode || ''}`;
        if (checkedPathObjects.has(pathObject)) continue;
        checkedPathObjects.add(pathObject);
        accumulator.add(engine.checkPaths([entry.path], {
            objectId: entry.oid,
            mode: entry.mode,
            transition: options.transition ?? entry.commit,
            ...(!reviewPaths.has(entry.path) ? {
                excludedRuleIds: REVIEW_REQUIRED_PATH_RULES,
            } : {}),
        })
            .map((finding) => decorate(finding, entry, policy)));
    }
    // Content scanning can target a narrower set than the path check. When
    // contentEntries is provided (e.g. only changed files in a commit), read
    // blobs only for those entries instead of the full snapshot. Path-based
    // rules already ran on the full tree above, so a path-only finding still
    // fires even when its blob isn't re-read.
    const contentScannable = (options.contentEntries ?? entries)
        .filter((entry) => entry.status !== 'D' && entry.type !== 'deleted');
    const remaining = accumulator.remaining();
    const scanned = scanEntries(repo, engine, contentScannable, {
        maxFileBytes: accumulator.limits.maxFileBytes,
        maxTotalBytes: accumulator.remainingBytes(),
        maxFindings: remaining,
    });
    accumulator.addScan(scanned, policy);
}

function scanReviewPathChanges(engine, entries, policy, accumulator, options = {}) {
    for (const entry of entries) {
        // A deleted path is gone, so only structural policy rules (agent
        // instructions, project policy) can still matter: deleting a flagged
        // file is hygiene, not a violation. A renamed-away path is different —
        // its content survives under a new name, so a path-only secret-category
        // rule from a local pack must still fire or a `git mv` to a neutral
        // name would slip past the destination scan, which only catches
        // content-shaped matches. That finding is reported on the destination
        // path (where the bytes now live) so clean-profile repair unstages the
        // blob that carries the match rather than the old name.
        const deleted = entry.status === 'D' || entry.type === 'deleted';
        const renamed = entry.status === 'R' && entry.sourcePath && entry.sourcePath !== entry.path;
        if (!deleted && !renamed) continue;
        const sourcePath = deleted ? entry.path : entry.sourcePath;
        const context = {
            objectId: null,
            mode: null,
            transition: options.transition ?? entry.commit,
            ...(options.allowMissingPolicy && sourcePath === '.aimhooman.json'
                ? { transientAllowRules: new Set(['generic.project-policy']) }
                : {}),
        };
        const findings = engine.checkPaths([sourcePath], context).filter((finding) => {
            if (finding.matchedRuleIds?.some((ruleId) => (
                ruleId === 'generic.agent-instructions' || ruleId === 'generic.project-policy'
            ))) return true;
            return renamed && finding.category === 'secret';
        });
        accumulator.add(findings.map((finding) => decorate(
            renamed && finding.category === 'secret' ? { ...finding, path: entry.path } : finding,
            entry,
            policy,
        )));
    }
}

export function engineForPolicy(
    repo,
    policy,
    overrideHead,
    preloaded,
    preloadedOverrides,
    reviewContexts,
) {
    const loaded = preloaded
        ? { engine: new Engine(policy.profile, preloaded.rules), errors: preloaded.errors }
        : newEngineWithDiagnostics(policy.profile, repo.stateDir);
    if (loaded.errors.length && policy.profile === 'strict') {
        throw new PolicyRulesError(loaded.errors);
    }
    // Overrides can grant exceptions, so malformed state is never equivalent
    // to an empty set. Every profile fails closed rather than silently changing
    // the repository's effective policy.
    const overrides = preloadedOverrides ?? loadOverrides(repo.stateDir);
    const active = (entries) => entries.filter((entry) => (
        !entry.head || entry.head === overrideHead
    ));
    const activeAllow = active(overrides.allow);
    const ordinaryAllow = activeAllow.filter((entry) => (
        !['reviewed-instruction', 'reviewed-policy-file', 'policy-migration'].includes(entry.scope)
    ));
    const normalizedReviewContexts = reviewContexts === undefined
        ? null
        : reviewContexts.flatMap((context) => {
            const storedTransition = context?.storedTransition ?? context?.transition;
            const scanTransition = context?.scanTransition ?? context?.transition;
            if (typeof context?.head !== 'string'
                || typeof storedTransition !== 'string'
                || typeof scanTransition !== 'string') return [];
            return [{ head: context.head, storedTransition, scanTransition }];
        });
    const reviewed = (scope, ruleId) => {
        const candidates = overrides.allow.filter((entry) => entry.scope === scope);
        if (normalizedReviewContexts === null) {
            return active(candidates).map((entry) => reviewedEngineEntry(entry, ruleId, entry.transition));
        }
        return candidates.flatMap((entry) => normalizedReviewContexts
            .filter((context) => (
                context.head === entry.head && context.storedTransition === entry.transition
            ))
            .map((context) => reviewedEngineEntry(entry, ruleId, context.scanTransition)));
    };
    const reviewedInstructions = reviewed('reviewed-instruction', 'generic.agent-instructions');
    const reviewedPolicies = reviewed('reviewed-policy-file', 'generic.project-policy');
    loaded.engine.setOverrides(
        ordinaryAllow,
        active(overrides.deny),
        [...reviewedInstructions, ...reviewedPolicies],
    );
    const diagnostics = loaded.errors.map((error) => ({ level: 'warning', message: `${error.message}; pack skipped` }));
    return { engine: loaded.engine, diagnostics, skipped: packSkipped(loaded.errors) };
}

// packSkipped turns rule-pack load failures into a counted skip reason. A pack
// that never loaded is a hole in coverage, not an empty result: strict throws
// above, and clean/compliance proceed but must not report a complete scan.
function packSkipped(errors) {
    return errors.length ? { 'local-pack-error': errors.length } : {};
}

function reviewedEngineEntry(entry, ruleId, transition) {
    return {
        target: entry.target,
        ruleId,
        transition,
        newObjectId: entry.newObjectId,
        newMode: entry.newMode,
    };
}

function policyMigrationAllowed(repo, expected, preloadedOverrides) {
    if (!expected.head || !expected.oldObjectIds.length) return false;
    const overrides = preloadedOverrides ?? loadOverrides(repo.stateDir);
    const migrations = overrides.allow.filter((entry) => entry.scope === 'policy-migration');
    return expected.oldObjectIds.every((oldObjectId) => migrations.some((entry) => (
        entry.target === '.aimhooman.json'
        && entry.head === expected.head
        && entry.transition === expected.transition
        && entry.oldObjectId === oldObjectId
        && (entry.newObjectId ?? null) === (expected.newObjectId ?? null)
        && (entry.newMode ?? null) === (expected.newMode ?? null)
    )));
}

function effectivePolicy(raw, explicitProfile, floorSource, enforcedObjectIds = []) {
    const objectIds = [...new Set(enforcedObjectIds.filter(Boolean))].sort();
    const floored = floorSource
        ? {
            ...applyStrictFloor(raw, floorSource),
            ...(objectIds.length ? {
                policy_object_id: objectIds[0],
                enforced_policy_object_ids: objectIds,
            } : {}),
        }
        : raw;
    return applyExplicitProfile(floored, explicitProfile);
}

function headPolicy(repo) {
    try {
        return resolvePolicy(repo, { target: 'commit', revision: 'HEAD' });
    } catch (error) {
        if (error instanceof GitRevisionError) return null;
        throw error;
    }
}

function isVersionedStrict(policy) {
    return Boolean(policy?.policy_object_id && policy.profile === 'strict' && (
        policy.source === 'commit-policy' || policy.source === 'staged-policy' || policy.source === 'worktree-policy'
    ));
}

function protectedPolicyFinding(rawPolicy, policy, entry) {
    const removed = !rawPolicy.policy_object_id;
    const reason = removed
        ? 'A versioned strict project policy cannot be deleted or renamed away without a bound review acknowledgment.'
        : 'A versioned strict project policy cannot be downgraded without a bound review acknowledgment.';
    const remediation = ['Restore the strict policy or use the reviewed migration command bound to this target.'];
    return decorate({
        ruleId: 'generic.project-policy',
        ruleVersion: 1,
        matchedRuleIds: ['generic.project-policy'],
        matchedRules: [{
            ruleId: 'generic.project-policy',
            ruleVersion: 1,
            kind: 'path',
            category: 'policy-config',
            provider: 'aimhooman',
            confidence: 'high',
            decision: 'block',
            reason,
            remediation,
            source: 'builtin',
        }],
        provider: 'aimhooman',
        category: 'policy-config',
        kind: 'path',
        confidence: 'high',
        source: 'builtin',
        decision: 'block',
        path: '.aimhooman.json',
        reason,
        remediation,
    }, entry, policy);
}

function decorate(finding, entry, policy) {
    const commit = entry?.commit;
    const parents = entry?.parents;
    const objectId = entry?.objectId || entry?.oid;
    return {
        ...finding,
        ...(commit ? { commit } : {}),
        ...(parents?.length ? { parents } : {}),
        ...(objectId ? { objectId } : {}),
        ...(entry?.sourcePath ? { sourcePath: entry.sourcePath } : {}),
        ...(entry?.status ? { status: entry.status } : {}),
        scanProfile: policy.profile,
        policySource: policy.source,
        policyObjectId: policy.policy_object_id,
        ...(policy.enforced_policy_object_ids?.length ? {
            policyEnforcedObjectIds: policy.enforced_policy_object_ids,
        } : {}),
    };
}

function rangeReportPolicy(basePolicy, policies, usedStrictFloor, explicitProfile) {
    if (!policies.length) {
        if (!basePolicy) throw new Error('bootstrap range did not contain a commit');
        // An empty range yields no findings, so the exit code is unaffected, but
        // the reported profile should still honor an explicit --profile request.
        // Apply it only here, after the isVersionedStrict check on the raw base.
        const base = isVersionedStrict(basePolicy) ? applyStrictFloor(basePolicy, 'range-base-strict') : basePolicy;
        return explicitProfile ? applyExplicitProfile(base, explicitProfile) : base;
    }
    const strongest = policies.reduce((selected, policy) => (
        PROFILE_RANK[policy.profile] > PROFILE_RANK[selected.profile] ? policy : selected
    ));
    if (!usedStrictFloor) return { ...strongest, source: policies.length === 1 ? strongest.source : 'per-commit' };
    const enforced = [...new Set(
        policies.flatMap((policy) => policy.enforced_policy_object_ids || [])
    )].sort();
    return {
        ...strongest,
        profile: 'strict',
        source: 'parent-strict-floor',
        ...(enforced.length ? {
            policy_object_id: enforced[0],
            enforced_policy_object_ids: enforced,
        } : {}),
    };
}

// Skip reasons that mean a rule never ran, as opposed to a rule running and
// matching nothing. Either way the scan cannot claim to have covered its input.
const INCOMPLETE_SKIP_REASONS = new Set(['local-input-limit', 'local-pack-error']);

function createAccumulator(limits = {}) {
    const effectiveLimits = { ...DEFAULT_SCAN_LIMITS, ...limits };
    const findings = [];
    const findingKeys = new Map();
    const stats = {
        entries: 0,
        blob_files: 0,
        objects_read: 0,
        files_scanned: 0,
        bytes_scanned: 0,
        findings_total: 0,
        findings_returned: 0,
        skipped: {},
        skippedPaths: {},
    };
    let complete = true;

    function add(values, total = values.length) {
        stats.findings_total += total;
        for (const finding of values) {
            const key = findingKey(finding);
            if (findingKeys.has(key)) {
                mergeFindingEvidence(findings[findingKeys.get(key)], finding);
                continue;
            }
            if (findings.length >= effectiveLimits.maxFindings) {
                complete = false;
                increment(stats.skipped, 'finding-limit');
                continue;
            }
            findingKeys.set(key, findings.length);
            findings.push(finding);
        }
        stats.findings_returned = findings.length;
        if (total > values.length) complete = false;
    }

    return {
        limits: effectiveLimits,
        findings,
        stats,
        add,
        addScan(scanned, policy) {
            const decorated = scanned.findings.map((finding) => decorate(finding, finding, policy));
            add(decorated, scanned.stats.findings_total);
            for (const key of ['entries', 'blob_files', 'objects_read', 'files_scanned', 'bytes_scanned']) {
                stats[key] += scanned.stats[key] || 0;
            }
            for (const [reason, count] of Object.entries(scanned.stats.skipped || {})) {
                stats.skipped[reason] = (stats.skipped[reason] || 0) + count;
            }
            for (const [reason, paths] of Object.entries(scanned.stats.skippedPaths || {})) {
                if (!stats.skippedPaths[reason]) stats.skippedPaths[reason] = [];
                for (const entry of paths) {
                    if (stats.skippedPaths[reason].length < 10) stats.skippedPaths[reason].push(entry);
                }
            }
            if (!scanned.complete) complete = false;
        },
        addSkipped(skipped = {}) {
            for (const [reason, count] of Object.entries(skipped)) {
                stats.skipped[reason] = (stats.skipped[reason] || 0) + count;
                if (INCOMPLETE_SKIP_REASONS.has(reason)) complete = false;
            }
        },
        markIncomplete() {
            complete = false;
        },
        remaining() {
            return Math.max(0, effectiveLimits.maxFindings - findings.length);
        },
        remainingBytes() {
            return Math.max(0, effectiveLimits.maxTotalBytes - stats.bytes_scanned);
        },
        isComplete() {
            return complete;
        },
    };
}

function result({ target, policy, accumulator, diagnostics, messageScanned, commit, range }) {
    return {
        target,
        profile: policy.profile,
        policy_source: policy.source,
        policy_object_id: policy.policy_object_id,
        ...(policy.enforced_policy_object_ids?.length ? {
            policy_enforced_object_ids: policy.enforced_policy_object_ids,
        } : {}),
        complete: accumulator.isComplete(),
        stats: accumulator.stats,
        findings: accumulator.findings,
        diagnostics,
        message_scanned: messageScanned,
        ...(commit ? { commit } : {}),
        ...(range ? { range } : {}),
    };
}

function findingKey(finding) {
    return [
        finding.commit || '', finding.path || '', finding.objectId || '', finding.line || '', finding.ruleId,
        finding.decision, finding.text || '',
    ].join('\0');
}

function mergeFindingEvidence(target, source) {
    const parents = [...new Set([...(target.parents || []), ...(source.parents || [])])].sort();
    if (parents.length) target.parents = parents;
    const statuses = [...new Set([
        ...(target.statuses || (target.status ? [target.status] : [])),
        ...(source.statuses || (source.status ? [source.status] : [])),
    ])].sort();
    if (statuses.length > 1) target.statuses = statuses;
    const sourcePaths = [...new Set([
        ...(target.sourcePaths || (target.sourcePath ? [target.sourcePath] : [])),
        ...(source.sourcePaths || (source.sourcePath ? [source.sourcePath] : [])),
    ])].sort();
    if (sourcePaths.length > 1) target.sourcePaths = sourcePaths;
}

function increment(record, key) {
    record[key] = (record[key] || 0) + 1;
}
