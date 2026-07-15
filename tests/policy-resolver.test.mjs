import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRevisionError, openRepo } from '../src/gitx.mjs';
import {
    applyExplicitProfile,
    applyStrictFloor,
    PolicyProfileError,
    resolvePolicy,
} from '../src/policy-resolver.mjs';
import { loadProjectPolicy, ProjectPolicyError, saveConfig } from '../src/state.mjs';

function freshRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'aim-policy-target-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'x');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    return dir;
}

function policy(profile) {
    return JSON.stringify({ schema_version: 1, profile }) + '\n';
}

test('commit policy resolution does not depend on either worktree checkout', () => {
    const dir = freshRepo();
    try {
        writeFileSync(join(dir, '.aimhooman.json'), policy('strict'));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '-q', '-m', 'strict policy'], { cwd: dir });
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        const linked = join(dir, 'linked-policy');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked-policy', linked], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), policy('clean'));
        writeFileSync(join(linked, '.aimhooman.json'), policy('compliance'));

        const fromMain = resolvePolicy(openRepo(dir), {
            target: { kind: 'commit', revision },
        });
        const fromLinked = resolvePolicy(openRepo(linked), { target: `commit:${revision}` });
        assert.deepEqual(fromLinked, fromMain);
        assert.equal(fromMain.profile, 'strict');
        assert.equal(fromMain.source, 'commit-policy');
        assert.equal(fromMain.target, `commit:${revision}`);
        assert.match(fromMain.policy_object_id, /^[0-9a-f]{40,64}$/);
        assert.equal(resolvePolicy(openRepo(dir)).profile, 'clean');
        assert.equal(resolvePolicy(openRepo(linked)).profile, 'compliance');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('staged policy bytes and object ID stay fixed after a worktree edit', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        saveConfig(repo.stateDir, { profile: 'clean' });
        writeFileSync(join(dir, '.aimhooman.json'), policy('strict'));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        const staged = resolvePolicy(repo, { target: 'staged' });
        writeFileSync(join(dir, '.aimhooman.json'), policy('compliance'));

        assert.deepEqual(resolvePolicy(repo, { target: 'staged' }), staged);
        assert.equal(staged.profile, 'strict');
        assert.equal(staged.source, 'staged-policy');
        assert.equal(staged.target, 'staged');
        assert.match(staged.policy_object_id, /^[0-9a-f]{40,64}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('missing target policy falls back locally and explicit profiles cannot lower it', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        saveConfig(repo.stateDir, { profile: 'compliance' });
        const resolved = resolvePolicy(repo, { target: { kind: 'commit', revision: 'HEAD' } });
        assert.equal(resolved.profile, 'compliance');
        assert.equal(resolved.source, 'local');
        assert.match(resolved.target, /^commit:[0-9a-f]{40,64}$/);
        assert.equal(resolved.policy_object_id, null);
        assert.strictEqual(applyExplicitProfile(resolved, 'compliance'), resolved);
        assert.equal(applyExplicitProfile(resolved, 'strict').profile, 'strict');
        assert.throws(() => applyExplicitProfile(resolved, 'clean'), PolicyProfileError);

        const floored = applyStrictFloor(resolved, 'range-base-strict');
        assert.equal(floored.profile, 'strict');
        assert.equal(floored.source, 'range-base-strict');
        const viaResolver = resolvePolicy(repo, {
            target: 'staged',
            strictFloor: true,
            strictFloorSource: 'head-policy-strict',
        });
        assert.equal(viaResolver.profile, 'strict');
        assert.equal(viaResolver.source, 'head-policy-strict');
        const defaultFloor = resolvePolicy(repo, { target: 'staged', strictFloor: true });
        assert.equal(defaultFloor.profile, 'strict');
        assert.equal(defaultFloor.source, 'strict-floor');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a staged policy deletion remains distinct from the strict HEAD policy', () => {
    const dir = freshRepo();
    try {
        writeFileSync(join(dir, '.aimhooman.json'), policy('strict'));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '-q', '-m', 'strict policy'], { cwd: dir });
        const repo = openRepo(dir);
        saveConfig(repo.stateDir, { profile: 'clean' });
        execFileSync('git', ['rm', '--cached', '-q', '.aimhooman.json'], { cwd: dir });

        const staged = resolvePolicy(repo, { target: 'staged' });
        const head = resolvePolicy(repo, { target: { kind: 'commit', revision: 'HEAD' } });
        assert.equal(staged.profile, 'clean');
        assert.equal(staged.policy_object_id, null);
        assert.equal(head.profile, 'strict');
        assert.match(head.policy_object_id, /^[0-9a-f]{40,64}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('invalid target policy and invalid revisions fail instead of falling back', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        writeFileSync(join(dir, '.aimhooman.json'), '{bad');
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        assert.throws(() => resolvePolicy(repo, { target: 'staged' }), ProjectPolicyError);
        assert.throws(
            () => resolvePolicy(repo, { target: { kind: 'commit', revision: 'missing' } }),
            GitRevisionError,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('Git policy snapshots reject symlink mode even when the blob is valid policy JSON', {
    skip: process.platform === 'win32',
}, () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        const content = policy('compliance');
        const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: dir,
            input: content,
            encoding: 'utf8',
        }).trim();
        execFileSync('git', [
            'update-index', '--add', '--cacheinfo', '120000', oid, '.aimhooman.json',
        ], { cwd: dir });

        assert.throws(
            () => resolvePolicy(repo, { target: 'staged' }),
            /must be a regular Git file, not mode 120000/,
        );
        execFileSync('git', ['commit', '-q', '-m', 'symlink policy'], { cwd: dir });
        assert.throws(
            () => resolvePolicy(repo, { target: 'commit', revision: 'HEAD' }),
            /must be a regular Git file, not mode 120000/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('worktree policy resolution rejects valid and dangling symlinks', {
    skip: process.platform === 'win32',
}, () => {
    const dir = freshRepo();
    try {
        const target = join(dir, 'policy-target.json');
        writeFileSync(target, policy('strict'));
        symlinkSync('policy-target.json', join(dir, '.aimhooman.json'));
        const repo = openRepo(dir);

        assert.throws(() => resolvePolicy(repo), /must be a regular file/);
        assert.throws(() => loadProjectPolicy(dir), /must be a regular file/);
        rmSync(target);
        assert.throws(() => resolvePolicy(repo), /must be a regular file/);
        assert.throws(() => loadProjectPolicy(dir), /must be a regular file/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
