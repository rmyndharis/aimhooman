import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepo, stagedPaths, stagedTreeSha } from '../src/gitx.mjs';
import {
    dispatchHooksChanged,
    precommitCleanMatches,
    recordPrecommitClean,
    repairStagedBlocks,
    resolveIntroduced,
    scanProposedCommits,
    warnIncompleteOnce,
} from '../src/guard.mjs';

function freshRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'aim-guard-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    return dir;
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Capture process.stderr for the duration of fn; guard helpers report through
// stderr directly, and asserting on the text is the point of these tests.
function captureStderr(fn) {
    const writes = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
        fn();
    } finally {
        process.stderr.write = original;
    }
    return writes.join('');
}

test('the precommit-clean marker matches only the exact tree, profile, and completeness', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        mkdirSync(repo.stateDir, { recursive: true });
        writeFileSync(join(dir, 'work.txt'), 'work\n');
        git(dir, ['add', 'work.txt']);
        const treeSha = stagedTreeSha(repo);

        assert.equal(precommitCleanMatches(repo, treeSha, 'clean'), false, 'no marker yet');
        recordPrecommitClean(repo, 'clean');
        assert.equal(precommitCleanMatches(repo, treeSha, 'clean'), true);
        assert.equal(precommitCleanMatches(repo, treeSha, 'strict'), false, 'profile is part of the key');
        assert.equal(precommitCleanMatches(repo, 'f'.repeat(40), 'clean'), false, 'tree is part of the key');

        writeFileSync(join(repo.stateDir, 'precommit-clean.json'), '{corrupt');
        assert.equal(precommitCleanMatches(repo, treeSha, 'clean'), false, 'corrupt marker falls back to scanning');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('recordPrecommitClean degrades silently when the tree sha cannot be computed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-guard-norepo-'));
    try {
        const state = join(dir, 'state');
        mkdirSync(state);
        // Not a git repository: stagedTreeSha throws, the marker must not be
        // written, and the caller must not see an error.
        recordPrecommitClean({ root: dir, stateDir: state }, 'clean');
        assert.equal(existsSync(join(state, 'precommit-clean.json')), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('dispatchHooksChanged reports missing dispatchers only on the dispatcher path', () => {
    const dir = freshRepo();
    const previous = process.env.AIMHOOMAN_ACTIVE_HOOK;
    try {
        const repo = openRepo(dir);
        delete process.env.AIMHOOMAN_ACTIVE_HOOK;
        assert.equal(dispatchHooksChanged(repo, 'clean'), false, 'no-op outside a dispatcher');

        // No aimhooman hooks are installed, so every required guard is missing.
        process.env.AIMHOOMAN_ACTIVE_HOOK = 'reference-transaction';
        const finalOut = captureStderr(() => {
            assert.equal(dispatchHooksChanged(repo, 'clean'), true);
        });
        assert.match(finalOut, /final Git guards changed/);

        process.env.AIMHOOMAN_ACTIVE_HOOK = 'pre-commit';
        const strictOut = captureStderr(() => {
            assert.equal(dispatchHooksChanged(repo, 'strict'), true);
        });
        assert.match(strictOut, /strict Git guards changed/);
        const requiredOut = captureStderr(() => {
            assert.equal(dispatchHooksChanged(repo, 'clean'), true);
        });
        assert.match(requiredOut, /required Git guards changed/);
    } finally {
        if (previous === undefined) delete process.env.AIMHOOMAN_ACTIVE_HOOK;
        else process.env.AIMHOOMAN_ACTIVE_HOOK = previous;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('warnIncompleteOnce prints once per tree and gap, and every time without a tree', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        mkdirSync(repo.stateDir, { recursive: true });
        const scan = { stats: { skipped: { 'size-limit': 1 }, skippedPaths: {} } };
        const first = captureStderr(() => warnIncompleteOnce(repo, 'a'.repeat(40), scan));
        assert.match(first, /scan incomplete/);
        const repeat = captureStderr(() => warnIncompleteOnce(repo, 'a'.repeat(40), scan));
        assert.equal(repeat, '', 'the identical gap stays silent');

        const widened = { stats: { skipped: { 'size-limit': 2 }, skippedPaths: {} } };
        const changed = captureStderr(() => warnIncompleteOnce(repo, 'a'.repeat(40), widened));
        assert.match(changed, /scan incomplete/, 'a different gap prints again');

        const untracked = captureStderr(() => warnIncompleteOnce(repo, null, widened));
        assert.match(untracked, /scan incomplete/, 'no tree sha means no dedup');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('repairStagedBlocks unstages the blocked paths and reports an emptied index', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        writeFileSync(join(dir, '.claude.json'), '{"session":1}\n');
        writeFileSync(join(dir, 'keep.txt'), 'keep\n');
        git(dir, ['add', '-f', '.claude.json', 'keep.txt']);
        const partial = repairStagedBlocks(repo, [{ path: '.claude.json' }], ['.claude.json']);
        assert.equal(partial, false, 'other work stays staged, so the commit may proceed');
        assert.deepEqual(stagedPaths(repo), ['keep.txt']);
        assert.ok(existsSync(join(dir, '.claude.json')), 'the worktree file survives');

        git(dir, ['restore', '--staged', 'keep.txt']);
        git(dir, ['add', '-f', '.claude.json']);
        const emptied = repairStagedBlocks(repo, [{ path: '.claude.json' }], ['.claude.json']);
        assert.equal(emptied, true, 'the repair removed everything that was staged');
        assert.deepEqual(stagedPaths(repo), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('resolveIntroduced separates locally authored tips from imported history', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        const branch = git(dir, ['symbolic-ref', 'HEAD']);
        const parent = git(dir, ['rev-parse', 'HEAD']);
        writeFileSync(join(dir, 'work.txt'), 'work\n');
        git(dir, ['add', 'work.txt']);
        git(dir, ['commit', '-q', '-m', 'work']);
        const head = git(dir, ['rev-parse', 'HEAD']);

        const ordinary = resolveIntroduced(repo, [
            { oldObjectId: parent, newObjectId: head, ref: branch },
        ]);
        assert.equal(ordinary.length, 1);
        const [revision, contexts, authoredLocally] = ordinary[0];
        assert.equal(revision, head);
        assert.equal(authoredLocally, true, 'one new commit on a non-zero tip is locally authored');
        assert.ok(
            contexts.some((context) => context.storedTransition === 'staged'),
            'the direct tip carries the staged review context',
        );

        // A created ref is measured against the gated tips; the ref under
        // review must not vouch for itself, so the whole ancestry is new here.
        const creation = resolveIntroduced(repo, [
            { oldObjectId: '0'.repeat(40), newObjectId: head, ref: branch },
        ], { includeStagedContexts: false });
        assert.deepEqual(creation.map(([oid]) => oid).sort(), [parent, head].sort());
        assert.equal(creation.every(([, , local]) => local === false), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('scanProposedCommits vetoes residue with the caller note and warns on a size-limit gap', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        mkdirSync(repo.stateDir, { recursive: true });
        writeFileSync(join(dir, '.claude.json'), '{"session":1}\n');
        git(dir, ['add', '-f', '.claude.json']);
        git(dir, ['commit', '-q', '-m', 'residue']);
        const residue = git(dir, ['rev-parse', 'HEAD']);
        const context = (oid) => [{ head: oid, storedTransition: oid, scanTransition: oid }];

        let code;
        const vetoed = captureStderr(() => {
            code = scanProposedCommits(repo, [[residue, context(residue), true]], {
                limits: {},
                rejectNote: (revision) => `stopped ${revision}\n`,
            });
        });
        assert.equal(code, 10);
        assert.match(vetoed, /claude\.session-state/);
        assert.ok(vetoed.includes(`stopped ${residue}`), 'the caller note prints after the findings');

        git(dir, ['reset', '--hard', '-q', 'HEAD~1']);
        writeFileSync(join(dir, 'big.txt'), 'x'.repeat(4096));
        git(dir, ['add', 'big.txt']);
        git(dir, ['commit', '-q', '-m', 'big clean file']);
        const oversized = git(dir, ['rev-parse', 'HEAD']);
        let warnedCode;
        const warned = captureStderr(() => {
            warnedCode = scanProposedCommits(repo, [[oversized, context(oversized), true]], {
                limits: { maxFileBytes: 16 },
                rejectNote: null,
            });
        });
        assert.equal(warnedCode, 0, 'a size-limit-only gap warns and continues on clean');
        assert.match(warned, /scan incomplete/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
