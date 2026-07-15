#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRepo, readCommitPath } from '../src/gitx.mjs';
import { resolvePolicy } from '../src/policy-resolver.mjs';
import { globToRegExp } from '../src/rules.mjs';
import { newEngine } from '../src/scan.mjs';
import { commitChanges, historyRange, resolveCommit } from '../src/history-scan.mjs';
import { gitEnvironment } from '../src/git-environment.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/aimhooman.mjs');

export function changedReviewedPaths(base, head, cwd = ROOT) {
    const { repo, history } = reviewedRange(base, head, cwd);
    return reviewedPaths(repo, history);
}

export function pullRequestReviewPlan(base, head, cwd = ROOT) {
    const { repo, history } = reviewedRange(base, head, cwd);
    const changes = reviewedPathChanges(repo, history);
    return {
        head: history.head,
        paths: [...new Set(changes.map((change) => change.path))].sort(),
        snapshots: reviewSnapshots(changes),
        migrations: policyMigrations(repo, history),
    };
}

export function pushReviewPlan(base, head, cwd = ROOT) {
    const { repo, history } = reviewedRange(base, head, cwd);
    const changes = reviewedPathChanges(repo, history);
    return {
        head: history.head,
        initialCommit: history.bootstrap
            && history.commits.length === 1
            && history.commits[0].parents.length === 0
            && history.commits[0].commit === history.head,
        paths: [...new Set(changes.map((change) => change.path))].sort(),
        changes,
        snapshots: reviewSnapshots(changes),
        migrations: policyMigrations(repo, history),
    };
}

export function protectedReleaseReviewPlan(base, head, cwd = ROOT) {
    const { repo, history } = reviewedRange(base, head, cwd);
    const changes = reviewedPathChanges(repo, history);
    return {
        head: history.head,
        paths: [...new Set(changes.map((change) => change.path))].sort(),
        snapshots: reviewSnapshots(changes),
        migrations: policyMigrations(repo, history),
    };
}

function reviewedRange(base, head, cwd) {
    const repo = openRepo(cwd);
    const history = historyRange(repo, `${base}...${head}`);
    return { repo, history };
}

function reviewedPaths(repo, history) {
    return [...new Set(reviewedPathChanges(repo, history).map((change) => change.path))].sort();
}

function reviewSnapshots(changes) {
    // A reviewed transition may end in a blob or in a tombstone. The review
    // command resolves the exact commit/path result and rejects a missing path
    // unless at least one direct parent proves this transition deleted it.
    return changes.map((change) => ({ ...change }));
}

function reviewedPathChanges(repo, history) {
    const engine = newEngine('strict');
    const changes = new Map();
    for (const commit of history.commits) {
        const { entries } = commitChanges(repo, commit.commit, commit.commit, commit.parents);
        for (const entry of entries) {
            const candidates = new Set([
                entry.path,
                entry.status === 'R' ? entry.sourcePath : null,
            ].filter(Boolean));
            for (const path of candidates) {
                const finding = engine.checkPaths([path])[0];
                if (finding?.matchedRuleIds?.some((id) => (
                    id === 'generic.agent-instructions' || id === 'generic.project-policy'
                ))) {
                    const change = { commit: commit.commit, path };
                    changes.set(`${change.commit}\0${change.path}`, change);
                }
            }
        }
    }
    return [...changes.values()].sort((left, right) => (
        left.commit.localeCompare(right.commit) || left.path.localeCompare(right.path)
    ));
}

function policyMigrations(repo, history) {
    const policies = new Map();
    const strictLineage = new Map();
    const migrations = new Map();
    if (!history.bootstrap) {
        const base = commitPolicy(repo, history.scanBase, policies);
        strictLineage.set(
            history.scanBase,
            new Set(isVersionedStrict(base) ? [base.policy_object_id] : []),
        );
    }

    for (const commit of history.commits) {
        const next = commitPolicy(repo, commit.commit, policies);
        const inherited = new Set();
        const directStrict = new Map();
        for (const parent of commit.parents) {
            const parentPolicy = commitPolicy(repo, parent, policies);
            if (isVersionedStrict(parentPolicy)) {
                directStrict.set(parentPolicy.policy_object_id, parentPolicy);
            }
            const lineage = strictLineage.get(parent);
            if (lineage) {
                for (const objectId of lineage) inherited.add(objectId);
            } else if (isVersionedStrict(parentPolicy)) {
                inherited.add(parentPolicy.policy_object_id);
            }
        }

        if (isVersionedStrict(next)) {
            strictLineage.set(commit.commit, new Set([next.policy_object_id]));
            continue;
        }

        // Invariant assertion (currently unreachable): inherited ⊆ directStrict
        // because strictLineage only ever stores a commit's own policy_object_id.
        // Kept as a fail-closed release gate — if a future refactor breaks this,
        // aborting the release is safer than binding a migration loosely.
        for (const oldObjectId of inherited) {
            if (!directStrict.has(oldObjectId)) {
                throw new Error(
                    `cannot bind policy migration at ${commit.commit}: `
                    + `strict object ${oldObjectId} is not an exact direct-parent policy`,
                );
            }
            const migration = {
                head: history.head,
                transition: commit.commit,
                oldObjectId,
                newObjectId: next.policy_object_id ?? null,
            };
            migrations.set(migrationKey(migration), migration);
        }
        // Every inherited strict object now has a direct, object-bound review
        // entry in the plan, so the reviewed lineage ends at this transition.
        strictLineage.set(commit.commit, new Set());
    }
    return [...migrations.values()];
}

function commitPolicy(repo, commit, cache) {
    if (!cache.has(commit)) {
        cache.set(commit, resolvePolicy(repo, { target: 'commit', revision: commit }));
    }
    return cache.get(commit);
}

function isVersionedStrict(policy) {
    return policy.profile === 'strict'
        && policy.source === 'commit-policy'
        && Boolean(policy.policy_object_id);
}

function migrationKey(migration) {
    return [
        migration.transition,
        migration.oldObjectId,
        migration.newObjectId ?? 'missing',
    ].join('\0');
}

export function acknowledgeProtectedReleasePaths(base, head, tag, cwd = ROOT) {
    const plan = protectedReleaseReviewPlan(base, head, cwd);
    const reason = `approved by protected release environment for ${tag}`;
    for (const snapshot of plan.snapshots) {
        runCli([
            'review', snapshot.path,
            '--head', plan.head,
            '--commit', snapshot.commit,
            '--reason', reason,
        ], cwd);
    }
    for (const migration of plan.migrations) {
        runCli([
            'policy-review',
            '--head', migration.head,
            '--transition', migration.transition,
            '--old', migration.oldObjectId,
            '--new', migration.newObjectId ?? 'missing',
            '--reason', reason,
        ], cwd);
    }
    return plan.paths;
}

export function ownersForPath(codeowners, path) {
    // Only direct @user owners are honored: approvedOwners derives GitHub
    // logins from reviews, and email or bare-username CODEOWNERS entries have no
    // comparable handle. A rule with only non-@ owners therefore yields [] and
    // fails closed (treated as "no CODEOWNER") rather than silently approving.
    // Repository-scoped Actions tokens cannot prove organization-team membership,
    // so a team rule is rejected explicitly instead of claiming unenforceable support.
    let owners = [];
    for (const raw of String(codeowners).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const fields = line.split(/\s+/);
        const comment = fields.findIndex((field) => field.startsWith('#'));
        const active = comment < 0 ? fields : fields.slice(0, comment);
        if (active.length < 2) continue;
        if (codeownersMatch(active[0], path)) {
            owners = active.slice(1).filter((owner) => owner.startsWith('@'));
        }
    }
    return owners;
}

export function approvedOwners(reviews, head) {
    const latest = new Map();
    for (const review of reviews || []) {
        const login = review?.user?.login;
        if (!login || review.commit_id !== head) continue;
        const key = login.toLowerCase();
        const previous = latest.get(key);
        if (!previous || String(review.submitted_at) >= String(previous.submitted_at)) {
            latest.set(key, review);
        }
    }
    return new Set([...latest.values()]
        .filter((review) => review.state === 'APPROVED')
        .map((review) => `@${review.user.login}`));
}

export async function approvedCodeowner(owners, approved, options = {}) {
    const approvedHandles = new Map(
        [...approved].map((handle) => [String(handle).toLowerCase(), handle]),
    );
    const { repository, token, fetchImpl = fetch, cache = new Map() } = options;
    for (const owner of owners) {
        if (owner.includes('/')) continue;
        const reviewer = approvedHandles.get(owner.toLowerCase());
        if (!reviewer) continue;
        // Production CI always supplies repository+token. Keep the pure helper
        // usable for local parsing tests, but never accept remote review
        // evidence until GitHub confirms write-equivalent repository access.
        if (repository || token) {
            githubRepositoryPath(repository);
            if (!token) throw new Error('GITHUB_TOKEN is required to verify CODEOWNER authority');
            const login = reviewer.slice(1);
            const permission = await cached(cache, `permission:${login.toLowerCase()}`, () => (
                fetchGitHubObject(
                    `https://api.github.com/repos/${githubRepositoryPath(repository)}`
                    + `/collaborators/${encodeURIComponent(login)}/permission`,
                    token,
                    fetchImpl,
                    `repository permission for CODEOWNER ${reviewer}`,
                )
            ));
            if (!writePermission(permission)) continue;
        }
        return { owner, reviewer };
    }

    if (owners.some((owner) => owner.includes('/'))) {
        throw new Error(
            'team CODEOWNERS are not supported by the repository-scoped GitHub Actions token; use a direct @user owner',
        );
    }
    return null;
}

function reviewerEvidence(match) {
    return match.owner.toLowerCase() === match.reviewer.toLowerCase()
        ? match.reviewer
        : `${match.reviewer} for ${match.owner}`;
}

export async function acknowledgePushReviewPlan(plan, options) {
    const {
        repository,
        token,
        refName,
        defaultBranch,
        cwd = ROOT,
        fetchImpl = fetch,
    } = options || {};
    const repositoryPath = githubRepositoryPath(repository);
    if (!token) throw new Error('GITHUB_TOKEN is required to verify merged pull-request reviews');
    if (typeof refName !== 'string' || !refName) {
        throw new Error('REF_NAME is required to verify the pull-request base branch');
    }
    if (typeof defaultBranch !== 'string' || !defaultBranch) {
        throw new Error('DEFAULT_BRANCH is required to verify pull-request state');
    }

    if (plan.initialCommit === true && refName === defaultBranch) {
        if (plan.migrations.length || plan.changes.some((change) => change.commit !== plan.head)) {
            throw new Error('initial-commit review plan is not bound to one root commit');
        }
        const reason = `initial commit bootstrap on default branch ${defaultBranch}`;
        for (const snapshot of plan.snapshots) {
            runCli([
                'review', snapshot.path,
                '--head', plan.head,
                '--commit', snapshot.commit,
                '--reason', reason,
            ], cwd);
        }
        return { paths: [...plan.paths], migrations: [] };
    }

    const pullRequests = new Map();
    const files = new Map();
    const reviews = new Map();
    const codeowners = new Map();
    const permissionCache = new Map();
    const approvedTrees = new Map();
    const evidence = new Map();
    const repo = openRepo(cwd);

    // Resolve all remote evidence before writing any local approval. Every
    // changed commit/path pair needs its own merged pull request.
    for (const change of plan.changes) {
        const key = changeKey(change.commit, change.path);
        const candidates = await cached(pullRequests, change.commit, () => fetchGitHubArray(
            `https://api.github.com/repos/${repositoryPath}/commits/${change.commit}/pulls?per_page=100`,
            token,
            fetchImpl,
            `pull requests associated with commit ${change.commit}`,
        ));
        const proof = await approvedPullRequestForChange({
            candidates,
            change,
            repository,
            repositoryPath,
            refName,
            defaultBranch,
            pushHead: plan.head,
            token,
            cwd,
            fetchImpl,
            files,
            reviews,
            codeowners,
            permissionCache,
            approvedTrees,
            repo,
        });
        if (!proof) {
            const requiredState = refName === defaultBranch ? 'merged' : 'current open';
            throw new Error(
                `review-required change ${change.path} at ${change.commit} `
                + `has no ${requiredState} pull request with an exact-head CODEOWNER approval`,
            );
        }
        evidence.set(key, proof);
    }

    // Invariant assertion (currently unreachable): the change loop above sets
    // evidence for every (commit,'.aimhooman.json') pair, and every migration's
    // transition produced such a change. Fail-closed if that ever stops holding.
    for (const migration of plan.migrations) {
        if (!evidence.has(changeKey(migration.transition, '.aimhooman.json'))) {
            throw new Error(`policy migration at ${migration.transition} has no approved pull-request evidence`);
        }
    }

    for (const snapshot of plan.snapshots) {
        const proof = evidence.get(changeKey(snapshot.commit, snapshot.path));
        runCli([
            'review', snapshot.path,
            '--head', plan.head,
            '--commit', snapshot.commit,
            '--reason', proofReason([proof]),
        ], cwd);
    }
    for (const migration of plan.migrations) {
        const proof = evidence.get(changeKey(migration.transition, '.aimhooman.json'));
        runCli([
            'policy-review',
            '--head', migration.head,
            '--transition', migration.transition,
            '--old', migration.oldObjectId,
            '--new', migration.newObjectId ?? 'missing',
            '--reason', proofReason([proof]),
        ], cwd);
    }

    return {
        paths: [...plan.paths],
        migrations: plan.migrations.map((migration) => ({ ...migration })),
    };
}

async function approvedPullRequestForChange(context) {
    const candidates = [...context.candidates]
        .filter((candidate) => validPullRequestForPush(candidate, context))
        .sort((left, right) => left.number - right.number);
    for (const pullRequest of candidates) {
        const changedFiles = await cached(context.files, pullRequest.number, () => fetchGitHubArray(
            `https://api.github.com/repos/${context.repositoryPath}/pulls/${pullRequest.number}/files?per_page=100`,
            context.token,
            context.fetchImpl,
            `files for pull request #${pullRequest.number}`,
        ));
        const proposed = commitPathSnapshot(
            context.repo,
            context.change.commit,
            context.change.path,
        );
        if (!changedFiles.some((file) => (
            pullRequestFileCovers(file, context.change.path, proposed)
        ))) continue;
        if (!commitIsAncestor(context.change.commit, pullRequest.head.sha, context.cwd)) {
            const reviewed = await approvedHeadPathSnapshot(context, pullRequest, context.change.path);
            if (!samePathSnapshot(proposed, reviewed)) continue;
        }

        let rules;
        try {
            rules = await cached(context.codeowners, pullRequest.base.sha, () => (
                codeownersAt(pullRequest.base.sha, context.cwd)
            ));
        } catch {
            continue;
        }
        const owners = ownersForPath(rules, context.change.path);
        if (!owners.length) continue;
        const pullRequestReviews = await cached(context.reviews, pullRequest.number, () => fetchGitHubArray(
            `https://api.github.com/repos/${context.repositoryPath}/pulls/${pullRequest.number}/reviews?per_page=100`,
            context.token,
            context.fetchImpl,
            `reviews for pull request #${pullRequest.number}`,
        ));
        const approved = approvedOwners(pullRequestReviews, pullRequest.head.sha);
        const match = await approvedCodeowner(owners, approved, {
            repository: context.repository,
            token: context.token,
            fetchImpl: context.fetchImpl,
            cache: context.permissionCache,
        });
        if (match) {
            return {
                pullRequest: pullRequest.number,
                reviewer: reviewerEvidence(match),
                state: pullRequest.merged_at ? 'merged' : 'open',
            };
        }
    }
    return null;
}

function validPullRequestForPush(pullRequest, context) {
    const common = Number.isInteger(pullRequest?.number)
        && pullRequest.number > 0
        && objectId(pullRequest?.head?.sha)
        && objectId(pullRequest?.base?.sha)
        && pullRequest?.base?.repo?.full_name === context.repository;
    if (!common) return false;
    if (context.refName === context.defaultBranch) {
        return typeof pullRequest.merged_at === 'string'
            && pullRequest.merged_at.length > 0
            && pullRequest.base.ref === context.defaultBranch;
    }
    return pullRequest.state === 'open'
        && !pullRequest.merged_at
        && pullRequest.head.sha === context.pushHead
        && pullRequest.head.ref === context.refName
        && pullRequest?.head?.repo?.full_name === context.repository
        && pullRequest.base.ref === context.defaultBranch;
}

function pullRequestFileCovers(file, path, snapshot) {
    if (snapshot.oid === null) {
        return (file?.filename === path && file?.status === 'removed')
            || (file?.previous_filename === path && file?.status === 'renamed');
    }
    return file?.filename === path
        && ['added', 'modified', 'renamed', 'copied', 'changed'].includes(file?.status);
}

function objectId(value) {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value || '');
}

function commitIsAncestor(ancestor, descendant, cwd) {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
            cwd,
            env: gitEnvironment(),
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        return true;
    } catch (error) {
        // Status 1 means "not an ancestor". Status 128 commonly means the PR
        // head is not present in this checkout (for example, a squash merge),
        // so the GitHub tree proof below must be used instead.
        if (error?.status === 1 || error?.status === 128) return false;
        throw error;
    }
}

function commitPathSnapshot(repo, commit, path) {
    const result = readCommitPath(repo, commit, path);
    return result.status === 'missing'
        ? { oid: null, mode: null }
        : { oid: result.oid.toLowerCase(), mode: result.mode };
}

function samePathSnapshot(left, right) {
    return left.oid === right.oid && left.mode === right.mode;
}

async function approvedHeadPathSnapshot(context, pullRequest, path) {
    const head = pullRequest.head.sha.toLowerCase();
    const repository = pullRequest?.head?.repo?.full_name || context.repository;
    const repositoryPath = githubRepositoryPath(repository);
    const key = `${repositoryPath}\0${head}`;
    const tree = await cached(context.approvedTrees, key, async () => {
        const commit = await fetchGitHubObject(
            `https://api.github.com/repos/${repositoryPath}/git/commits/${head}`,
            context.token,
            context.fetchImpl,
            `Git commit for approved pull-request head ${head}`,
        );
        if (!objectId(commit.sha) || commit.sha.toLowerCase() !== head || !objectId(commit?.tree?.sha)) {
            throw new Error(`approved pull-request head ${head} returned invalid Git commit metadata`);
        }
        const treeId = commit.tree.sha.toLowerCase();
        const value = await fetchGitHubObject(
            `https://api.github.com/repos/${repositoryPath}/git/trees/${treeId}?recursive=1`,
            context.token,
            context.fetchImpl,
            `Git tree for approved pull-request head ${head}`,
        );
        if (!objectId(value.sha) || value.sha.toLowerCase() !== treeId
            || value.truncated !== false || !Array.isArray(value.tree)) {
            throw new Error(`approved pull-request head ${head} returned an incomplete Git tree`);
        }
        const entries = new Map();
        for (const entry of value.tree) {
            if (!entry || typeof entry.path !== 'string' || typeof entry.mode !== 'string'
                || typeof entry.type !== 'string' || !objectId(entry.sha)) {
                throw new Error(`approved pull-request head ${head} returned a malformed Git tree entry`);
            }
            if (entries.has(entry.path)) {
                throw new Error(`approved pull-request head ${head} returned a duplicate Git tree path`);
            }
            entries.set(entry.path, {
                oid: entry.sha.toLowerCase(),
                mode: entry.mode,
                type: entry.type,
            });
        }
        return entries;
    });
    const entry = tree.get(path);
    if (!entry) return { oid: null, mode: null };
    return { oid: entry.oid, mode: entry.mode };
}

function githubRepositoryPath(repository) {
    const fields = typeof repository === 'string' ? repository.split('/') : [];
    if (fields.length !== 2 || fields.some((field) => !field || field === '.' || field === '..')) {
        throw new Error('GITHUB_REPOSITORY must be an owner/name pair');
    }
    return fields.map(encodeURIComponent).join('/');
}

function changeKey(commit, path) {
    return `${commit}\0${path}`;
}

async function cached(cache, key, load) {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(load));
    return cache.get(key);
}

function proofReason(proofs) {
    const shown = proofs.slice(0, 8);
    return 'approved in ' + shown
        .map((proof) => `${proof.state} PR #${proof.pullRequest} by ${proof.reviewer}`)
        .join(', ')
        + (proofs.length > shown.length ? `, and ${proofs.length - shown.length} more` : '');
}

export async function acknowledgePullRequestPlan(
    plan,
    codeowners,
    reviews,
    cwd = ROOT,
    options = {},
) {
    const approved = approvedOwners(reviews, plan.head);
    const reviewers = new Map();
    const cache = new Map();
    const repo = openRepo(cwd);

    // One PR-head approval can authorize a transition only when the protected
    // path ends in the exact blob/tombstone and Git mode seen at that approved
    // head. This prevents a transient intermediate policy or instruction file
    // from borrowing approval for different final bytes.
    for (const snapshot of plan.snapshots) {
        const transition = commitPathSnapshot(repo, snapshot.commit, snapshot.path);
        const reviewedHead = commitPathSnapshot(repo, plan.head, snapshot.path);
        if (!samePathSnapshot(transition, reviewedHead)) {
            throw new Error(
                `${snapshot.path} at ${snapshot.commit} does not match the exact approved PR head ${plan.head}`,
            );
        }
    }

    // Check every path before writing local state. A missing owner or stale
    // review must not leave a partly approved plan behind.
    for (const path of plan.paths) {
        const owners = ownersForPath(codeowners, path);
        if (!owners.length) throw new Error(`review-required path has no CODEOWNER: ${path}`);
        const match = await approvedCodeowner(owners, approved, { ...options, cache });
        if (!match) {
            throw new Error(`${path} needs a CODEOWNER approval recorded on head ${plan.head}`);
        }
        reviewers.set(path, reviewerEvidence(match));
    }

    for (const snapshot of plan.snapshots) {
        const reviewer = reviewers.get(snapshot.path);
        runCli([
            'review', snapshot.path,
            '--head', plan.head,
            '--commit', snapshot.commit,
            '--reason', `approved by ${reviewer}`,
        ], cwd);
    }

    for (const migration of plan.migrations) {
        const reviewer = reviewers.get('.aimhooman.json');
        if (!reviewer) {
            throw new Error('policy migration needs an approved review for .aimhooman.json');
        }
        runCli([
            'policy-review',
            '--head', migration.head,
            '--transition', migration.transition,
            '--old', migration.oldObjectId,
            '--new', migration.newObjectId ?? 'missing',
            '--reason', `approved by ${reviewer}`,
        ], cwd);
    }

    return {
        paths: [...plan.paths],
        migrations: plan.migrations.map((migration) => ({ ...migration })),
    };
}

function runCli(args, cwd) {
    execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        stdio: 'inherit',
    });
}

export async function fetchPullRequestReviews(url, token, fetchImpl = fetch) {
    return fetchGitHubArray(url, token, fetchImpl, 'pull-request reviews');
}

async function fetchGitHubArray(url, token, fetchImpl, label) {
    const records = [];
    const visited = new Set();
    const origin = new URL(url).origin;
    let next = url;
    while (next) {
        if (visited.has(next)) throw new Error('GitHub pagination repeated a page');
        visited.add(next);
        const response = await fetchImpl(next, {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (!response.ok) throw new Error(`cannot read ${label}: GitHub returned ${response.status}`);
        const page = await response.json();
        if (!Array.isArray(page)) throw new Error(`cannot read ${label}: GitHub returned a non-array response`);
        records.push(...page);
        next = nextPage(response.headers?.get?.('link'));
        if (next && new URL(next).origin !== origin) {
            throw new Error(`cannot read ${label}: GitHub pagination changed origin`);
        }
    }
    return records;
}

async function fetchGitHubObject(url, token, fetchImpl, label) {
    const response = await fetchImpl(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!response.ok) throw new Error(`cannot read ${label}: GitHub returned ${response.status}`);
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`cannot read ${label}: GitHub returned a non-object response`);
    }
    return value;
}

function writePermission(value) {
    if (value?.permissions?.admin || value?.permissions?.maintain || value?.permissions?.push) {
        return true;
    }
    return ['admin', 'maintain', 'write', 'push'].includes(value?.permission);
}

function nextPage(link) {
    for (const part of String(link || '').split(',')) {
        const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
        if (match && match[2].split(/\s+/).includes('next')) return match[1];
    }
    return '';
}

export function codeownersAt(base, cwd = ROOT) {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        env: gitEnvironment(),
        encoding: 'utf8',
    }).trim();
    const commit = resolveCommit({ root }, base);
    for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        try {
            execFileSync('git', ['cat-file', '-e', `${commit}:${path}`], {
                cwd: root,
                env: gitEnvironment(),
                stdio: 'ignore',
            });
            return execFileSync('git', ['show', `${commit}:${path}`], {
                cwd: root,
                env: gitEnvironment(),
                encoding: 'utf8',
            });
        } catch {
            // GitHub uses the first CODEOWNERS file found in this order.
        }
    }
    throw new Error(`commit ${commit} has no CODEOWNERS in .github/, repository root, or docs/`);
}

function codeownersMatch(pattern, path) {
    // GitHub CODEOWNERS does not support .gitignore-style negation, bracket
    // ranges, or escaping a leading '#'. Treat those rules as invalid instead
    // of interpreting them with our more capable generic glob parser.
    if (pattern.startsWith('!') || pattern.startsWith('\\#') || /[\[\]]/.test(pattern)) {
        return false;
    }
    const rooted = pattern.startsWith('/');
    let normalized = pattern.replace(/^\//, '');
    if (normalized.endsWith('/')) normalized += '**';
    if (!rooted && !normalized.includes('/')) normalized = `**/${normalized}`;
    try { return globToRegExp(normalized).test(path); }
    catch { return false; }
}

async function main() {
    const base = requiredEnvironment('BASE_SHA');
    const head = requiredEnvironment('HEAD_SHA');
    const repository = requiredEnvironment('GITHUB_REPOSITORY');
    const pullRequest = requiredEnvironment('PR_NUMBER');
    const token = requiredEnvironment('GITHUB_TOKEN');
    const plan = pullRequestReviewPlan(base, head);
    if (!plan.paths.length) return;

    const reviewUrl = `https://api.github.com/repos/${repository}/pulls/${pullRequest}/reviews?per_page=100`;
    const reviews = await fetchPullRequestReviews(reviewUrl, token);
    const codeowners = codeownersAt(base);
    await acknowledgePullRequestPlan(plan, codeowners, reviews, ROOT, {
        repository,
        token,
    });
}

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`aimhooman: ${error.message}`);
        process.exit(20);
    });
}
