import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    authorizeProtectedPathPlan,
    changedProtectedPaths,
    protectedPathAuthorizationPlan,
} from '../scripts/authorize-owner-paths.mjs';
import { openRepo } from '../src/gitx.mjs';
import { loadOverrides } from '../src/state.mjs';

const CLI = join(import.meta.dirname, '..', 'bin', 'aimhooman.mjs');

test('owner authorization binds every transient policy result and migration', () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        const firstOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        git(root, ['rm', '-q', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'remove policy']);
        const removed = git(root, ['rev-parse', 'HEAD']);

        writePolicy(root, 'strict', true);
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'restore strict policy']);
        const secondOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        writePolicy(root, 'compliance');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'change policy']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const nextObject = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);
        const plan = protectedPathAuthorizationPlan(base, head, root);

        assert.deepEqual(plan.paths, ['.aimhooman.json']);
        assert.deepEqual(plan.migrations, [
            {
                head,
                transition: removed,
                oldObjectId: firstOld,
                newObjectId: null,
            },
            {
                head,
                transition: head,
                oldObjectId: secondOld,
                newObjectId: nextObject,
            },
        ]);

        authorize(plan, head, root);
        const overrides = loadOverrides(openRepo(root).stateDir).allow;
        assert.deepEqual(
            new Set(overrides
                .filter((entry) => entry.scope === 'reviewed-policy-file')
                .map((entry) => entry.newObjectId)),
            new Set([null, secondOld, nextObject]),
        );
        assert.deepEqual(
            overrides
                .filter((entry) => entry.scope === 'policy-migration')
                .map((entry) => ({
                    head: entry.head,
                    transition: entry.transition,
                    oldObjectId: entry.oldObjectId,
                    newObjectId: entry.newObjectId ?? null,
                })),
            plan.migrations,
        );
        assert.ok(overrides.every((entry) => (
            !entry.reason || /GitHub run 9001 attempt 2/.test(entry.reason)
        )));
        assert.equal(policyFinding(root, base, head), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('owner authorization binds instruction deletion, rename, and copy tombstones', () => {
    const root = instructionRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        git(root, ['rm', '-q', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'delete instructions']);
        const deleted = git(root, ['rev-parse', 'HEAD']);
        let plan = protectedPathAuthorizationPlan(base, deleted, root);
        assert.deepEqual(plan.snapshots, [{ commit: deleted, path: 'AGENTS.md' }]);
        authorize(plan, deleted, root);
        let reviewed = loadOverrides(openRepo(root).stateDir).allow
            .filter((entry) => entry.scope === 'reviewed-instruction');
        assert.deepEqual(reviewed.map((entry) => ({
            target: entry.target,
            transition: entry.transition,
            newObjectId: entry.newObjectId,
        })), [{ target: 'AGENTS.md', transition: deleted, newObjectId: null }]);
        assert.equal(instructionFinding(root, base, deleted), undefined);

        writeFileSync(join(root, 'AGENTS.md'), '# restored instructions\n');
        git(root, ['add', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'restore instructions']);
        const restored = git(root, ['rev-parse', 'HEAD']);
        mkdirSync(join(root, 'nested'));
        git(root, ['mv', 'AGENTS.md', 'nested/AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'rename instructions']);
        const renamed = git(root, ['rev-parse', 'HEAD']);
        plan = protectedPathAuthorizationPlan(restored, renamed, root);
        assert.deepEqual(plan.paths, ['AGENTS.md', 'nested/AGENTS.md']);
        authorize(plan, renamed, root);
        reviewed = loadOverrides(openRepo(root).stateDir).allow
            .filter((entry) => entry.scope === 'reviewed-instruction' && entry.head === renamed);
        assert.deepEqual(
            new Set(reviewed.map((entry) => `${entry.target}\0${entry.newObjectId ?? 'tombstone'}`)),
            new Set([
                'AGENTS.md\0tombstone',
                `nested/AGENTS.md\0${git(root, ['rev-parse', 'HEAD:nested/AGENTS.md'])}`,
            ]),
        );

        const copyBase = renamed;
        mkdirSync(join(root, 'copy'));
        writeFileSync(join(root, 'copy/AGENTS.md'), readFileSync(join(root, 'nested/AGENTS.md')));
        git(root, ['add', 'copy/AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'copy instructions']);
        const copied = git(root, ['rev-parse', 'HEAD']);
        plan = protectedPathAuthorizationPlan(copyBase, copied, root);
        assert.deepEqual(plan.paths, ['copy/AGENTS.md']);
        authorize(plan, copied, root);
        assert.equal(instructionFinding(root, copyBase, copied), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('merge migration plan binds every strict direct-parent object', () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        const firstOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);
        git(root, ['branch', '-m', 'main']);
        git(root, ['checkout', '-q', '-b', 'topic']);
        writeFileSync(join(root, 'topic.txt'), 'topic\n');
        git(root, ['add', 'topic.txt']);
        git(root, ['commit', '-q', '-m', 'topic work']);

        git(root, ['checkout', '-q', 'main']);
        writePolicy(root, 'strict', true);
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'rewrite strict policy']);
        const secondOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        git(root, ['checkout', '-q', 'topic']);
        git(root, ['merge', '--no-commit', '--no-ff', 'main']);
        writePolicy(root, 'clean');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'merge with policy change']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const nextObject = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);
        const plan = protectedPathAuthorizationPlan(base, head, root);

        assert.deepEqual(
            new Set(plan.migrations.map((migration) => migration.oldObjectId)),
            new Set([firstOld, secondOld]),
        );
        assert.ok(plan.migrations.every((migration) => (
            migration.head === head
            && migration.transition === head
            && migration.newObjectId === nextObject
        )));
        authorize(plan, head, root);
        assert.equal(
            loadOverrides(openRepo(root).stateDir).allow
                .filter((entry) => entry.scope === 'policy-migration').length,
            2,
        );
        assert.equal(policyFinding(root, base, head), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('authorization rejects incomplete or cross-attempt evidence before writing state', () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        writePolicy(root, 'clean');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'change policy']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const plan = protectedPathAuthorizationPlan(base, head, root);
        const state = join(root, '.git', 'aimhooman', 'overrides.json');

        for (const authority of [
            { ...ownerAuthority(head), headSha: base },
            { ...ownerAuthority(head), ownerId: 1 },
            { ...ownerAuthority(head), repositoryId: 1 },
            { ...ownerAuthority(head), runAttempt: 0 },
            { ...ownerAuthority(head), workflowPath: '.github/workflows/release.yml' },
        ]) {
            assert.throws(
                () => authorizeProtectedPathPlan(plan, authority, authorizationOptions(root)),
                /not bound|pinned repository|does not match/,
            );
            assert.equal(existsSync(state), false);
        }

        const invalidPlan = {
            ...plan,
            migrations: [{ ...plan.migrations[0], transition: base }],
        };
        assert.throws(
            () => authorizeProtectedPathPlan(
                invalidPlan,
                ownerAuthority(head),
                authorizationOptions(root),
            ),
            /not bound to an exact protected-path snapshot/,
        );
        assert.equal(existsSync(state), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('protected path discovery includes deletion-only ranges', () => {
    const root = instructionRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        git(root, ['rm', '-q', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'delete instructions']);
        const head = git(root, ['rev-parse', 'HEAD']);
        assert.deepEqual(changedProtectedPaths(base, head, root), ['AGENTS.md']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function authorize(plan, head, root) {
    return authorizeProtectedPathPlan(
        plan,
        ownerAuthority(head),
        authorizationOptions(root),
    );
}

function ownerAuthority(head) {
    return {
        ownerLogin: 'rmyndharis',
        ownerId: 2390382,
        repositoryId: 1301417609,
        runId: 9001,
        runAttempt: 2,
        event: 'push',
        headSha: head,
        refName: 'main',
        workflowPath: '.github/workflows/test.yml',
    };
}

function authorizationOptions(root) {
    return {
        context: 'push to main',
        event: 'push',
        refName: 'main',
        workflowPath: '.github/workflows/test.yml',
        cwd: root,
    };
}

function policyRepository() {
    const root = mkdtempSync(join(tmpdir(), 'aim-owner-policy-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Owner Authorization Test']);
    git(root, ['config', 'user.email', 'owner-authorization@example.com']);
    writePolicy(root, 'strict');
    git(root, ['add', '.aimhooman.json']);
    git(root, ['commit', '-q', '-m', 'strict policy']);
    return root;
}

function instructionRepository() {
    const root = mkdtempSync(join(tmpdir(), 'aim-owner-instruction-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Owner Authorization Test']);
    git(root, ['config', 'user.email', 'owner-authorization@example.com']);
    writeFileSync(join(root, 'AGENTS.md'), '# protected instructions\n');
    git(root, ['add', 'AGENTS.md']);
    git(root, ['commit', '-q', '-m', 'protected instructions']);
    return root;
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writePolicy(root, profile, pretty = false) {
    const policy = { schema_version: 1, profile };
    writeFileSync(
        join(root, '.aimhooman.json'),
        pretty ? `${JSON.stringify(policy, null, 2)}\n` : `${JSON.stringify(policy)}\n`,
    );
}

function instructionFinding(root, base, head) {
    const report = JSON.parse(execFileSync(process.execPath, [
        CLI, 'check', '--range', `${base}...${head}`, '--profile', 'strict', '--json',
    ], { cwd: root, encoding: 'utf8' }));
    return report.findings.find((finding) => (
        finding.matchedRuleIds?.includes('generic.agent-instructions')
    ));
}

function policyFinding(root, base, head) {
    const report = JSON.parse(execFileSync(process.execPath, [
        CLI, 'check', '--range', `${base}...${head}`, '--profile', 'strict', '--json',
    ], { cwd: root, encoding: 'utf8' }));
    return report.findings.find((finding) => (
        finding.ruleId === 'generic.project-policy' && finding.category === 'policy-config'
    ));
}
