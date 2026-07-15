#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRepo } from '../src/gitx.mjs';
import { resolvePolicy } from '../src/policy-resolver.mjs';
import { newEngine } from '../src/scan.mjs';
import { commitChanges, historyRange } from '../src/history-scan.mjs';
import {
    AIMHOOMAN_REPOSITORY_AUTHORITY,
    verifyOwnerWorkflowRun,
} from './github-owner-authority.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/aimhooman.mjs');

export function changedProtectedPaths(base, head, cwd = ROOT) {
    return protectedPathAuthorizationPlan(base, head, cwd).paths;
}

export function protectedPathAuthorizationPlan(base, head, cwd = ROOT) {
    const repo = openRepo(cwd);
    const history = historyRange(repo, `${base}...${head}`);
    const changes = protectedPathChanges(repo, history);
    return {
        head: history.head,
        paths: [...new Set(changes.map((change) => change.path))].sort(),
        snapshots: changes.map((change) => ({ ...change })),
        migrations: policyMigrations(repo, history),
    };
}

export function authorizeProtectedPathPlan(
    plan,
    authority,
    { context, event, refName, workflowPath, cwd = ROOT } = {},
) {
    assertAuthorizationPlan(plan, authority, { context, event, refName, workflowPath });
    const reason = ownerReason(authority, context);
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
    return {
        paths: [...plan.paths],
        migrations: plan.migrations.map((migration) => ({ ...migration })),
    };
}

export function authorizeProtectedPaths(
    base,
    head,
    authority,
    { context, event, refName, workflowPath, cwd = ROOT } = {},
) {
    const plan = protectedPathAuthorizationPlan(base, head, cwd);
    return authorizeProtectedPathPlan(plan, authority, {
        context, event, refName, workflowPath, cwd,
    });
}

function protectedPathChanges(repo, history) {
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

function assertAuthorizationPlan(plan, authority, expected) {
    const { context, event, refName, workflowPath } = expected || {};
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new Error('protected-path authorization plan must be an object');
    }
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
        throw new Error('owner workflow authority must be an object');
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(plan.head || '')) {
        throw new Error('protected-path authorization head must be a Git object ID');
    }
    if (authority.headSha !== plan.head) {
        throw new Error('owner workflow authority is not bound to the authorization head');
    }
    if (authority.ownerLogin !== AIMHOOMAN_REPOSITORY_AUTHORITY.ownerLogin
        || authority.ownerId !== AIMHOOMAN_REPOSITORY_AUTHORITY.ownerId
        || authority.repositoryId !== AIMHOOMAN_REPOSITORY_AUTHORITY.repositoryId
        || !Number.isSafeInteger(authority.runId) || authority.runId < 1
        || !Number.isSafeInteger(authority.runAttempt) || authority.runAttempt < 1) {
        throw new Error('owner workflow authority has no pinned repository, owner, and run identity');
    }
    if (authority.event !== event || authority.refName !== refName
        || authority.workflowPath !== workflowPath) {
        throw new Error('owner workflow authority does not match the authorization callsite');
    }
    if (typeof context !== 'string' || !context || context.length > 120 || /[\r\n]/.test(context)) {
        throw new Error('owner authorization context must be a short single line');
    }
    if (!Array.isArray(plan.paths) || !Array.isArray(plan.snapshots)
        || !Array.isArray(plan.migrations)) {
        throw new Error('protected-path authorization plan is incomplete');
    }
    const snapshots = new Set();
    for (const snapshot of plan.snapshots) {
        if (!snapshot || typeof snapshot.path !== 'string' || !snapshot.path
            || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot.commit || '')) {
            throw new Error('protected-path authorization contains an invalid snapshot');
        }
        snapshots.add(`${snapshot.commit}\0${snapshot.path}`);
    }
    for (const migration of plan.migrations) {
        if (migration?.head !== plan.head
            || !snapshots.has(`${migration?.transition}\0.aimhooman.json`)
            || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(migration?.oldObjectId || '')
            || (migration?.newObjectId !== null
                && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(migration?.newObjectId || ''))) {
            throw new Error('policy migration is not bound to an exact protected-path snapshot');
        }
    }
}

function ownerReason(authority, context) {
    return `owner @${authority.ownerLogin}#${authority.ownerId}; `
        + `GitHub run ${authority.runId} attempt ${authority.runAttempt}; ${context}`;
}

function runCli(args, cwd) {
    execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        stdio: 'inherit',
    });
}

async function main() {
    const base = requiredEnvironment('BASE_SHA');
    const head = requiredEnvironment('HEAD_SHA');
    const plan = protectedPathAuthorizationPlan(base, head);
    if (!plan.paths.length) return;
    const authority = await verifyOwnerWorkflowRun({
        expectedEvent: 'pull_request',
        expectedHead: head,
        expectedRef: requiredEnvironment('GITHUB_HEAD_REF'),
        expectedWorkflowPath: '.github/workflows/test.yml',
    });
    authorizeProtectedPathPlan(plan, authority, {
        context: `pull request #${requiredEnvironment('PR_NUMBER')} head ${head}`,
        event: 'pull_request',
        refName: requiredEnvironment('GITHUB_HEAD_REF'),
        workflowPath: '.github/workflows/test.yml',
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
        process.exitCode = 20;
    });
}
