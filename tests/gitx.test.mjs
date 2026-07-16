import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, readdirSync, rmSync, writeFileSync, mkdirSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    GitRevisionError,
    GitTargetReadError,
    introducedCommits,
    openRepo,
    readCommitPath,
    readStagedPath,
    stagedEntries,
    stagedPaths,
    trackedEntries,
    unmergedPaths,
    unstagePaths,
} from '../src/gitx.mjs';
import { loadConfig, loadOverrides, saveConfig, saveOverrides } from '../src/state.mjs';
import { newEngine } from '../src/scan.mjs';
import { scanEntries } from '../src/scan-session.mjs';

function freshRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'aim-gitx-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'x');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    return dir;
}

function commit(dir, message) {
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function addWorktree(dir, name) {
    const linked = join(dir, name);
    execFileSync('git', ['worktree', 'add', '-q', '-b', name, linked], { cwd: dir });
    return linked;
}

function absoluteGitDir(dir) {
    return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: dir,
        encoding: 'utf8',
    }).trim();
}

test('main and linked worktrees share per-clone state', () => {
    const dir = freshRepo();
    try {
        const linked = addWorktree(dir, 'linked');
        const mainRepo = openRepo(dir);
        saveConfig(mainRepo.stateDir, { profile: 'strict' });
        saveOverrides(mainRepo.stateDir, {
            allow: [{ target: './README.md' }],
            deny: [{ target: '.env' }],
        });

        const linkedRepo = openRepo(linked);
        assert.equal(linkedRepo.stateDir, mainRepo.stateDir);
        assert.equal(linkedRepo.stateDir, join(mainRepo.commonDir, 'aimhooman'));
        assert.equal(loadConfig(linkedRepo.stateDir).profile, 'strict');
        assert.deepEqual(loadOverrides(linkedRepo.stateDir).allow.map((entry) => entry.target), ['README.md']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('bare repositories are outside the worktree enforcement boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-gitx-bare-'));
    try {
        execFileSync('git', ['init', '--bare', '-q'], { cwd: dir });
        assert.throws(() => openRepo(dir));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a submodule has independent state from its superproject', () => {
    const source = freshRepo();
    const parent = freshRepo();
    try {
        writeFileSync(join(source, 'source.txt'), 'submodule source\n');
        execFileSync('git', ['add', 'source.txt'], { cwd: source });
        execFileSync('git', ['commit', '-q', '-m', 'submodule source'], { cwd: source });
        execFileSync('git', [
            '-c', 'protocol.file.allow=always',
            'submodule', 'add', '-q', source, 'vendor/sub',
        ], { cwd: parent });
        const submodule = join(parent, 'vendor', 'sub');
        const parentRepo = openRepo(parent);
        const submoduleRepo = openRepo(submodule);

        assert.notEqual(submoduleRepo.commonDir, parentRepo.commonDir);
        assert.notEqual(submoduleRepo.stateDir, parentRepo.stateDir);
        saveConfig(parentRepo.stateDir, { profile: 'clean' });
        saveConfig(submoduleRepo.stateDir, { profile: 'strict' });
        assert.equal(loadConfig(parentRepo.stateDir).profile, 'clean');
        assert.equal(loadConfig(submoduleRepo.stateDir).profile, 'strict');
    } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
    }
});

test('unstagePaths removes paths from the index', () => {
    const dir = freshRepo();
    const realCwd = process.cwd();
    process.chdir(dir);
    try {
        mkdirSync(join(dir, '.playwright-mcp'));
        writeFileSync(join(dir, '.playwright-mcp/trace.json'), '{}');
        writeFileSync(join(dir, 'README.md'), 'xx');
        execFileSync('git', ['add', '.playwright-mcp/trace.json', 'README.md'], { cwd: dir });
        const repo = openRepo();
        assert.equal(stagedPaths(repo).length, 2);
        unstagePaths(repo, ['.playwright-mcp/trace.json']);
        assert.equal(stagedPaths(repo).length, 1);
    } finally {
        process.chdir(realCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('unstagePaths works on the initial commit (no HEAD)', () => {
    // Reproduces the no-HEAD bug: `git restore --staged` fails when HEAD
    // does not exist yet. freshRepo() cannot be used — it creates a commit.
    const dir = mkdtempSync(join(tmpdir(), 'aim-gitx-nohead-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    mkdirSync(join(dir, '.playwright-mcp'));
    writeFileSync(join(dir, '.playwright-mcp/trace.json'), '{}');
    writeFileSync(join(dir, 'README.md'), 'x');
    execFileSync('git', ['add', '.playwright-mcp/trace.json', 'README.md'], { cwd: dir });
    const realCwd = process.cwd();
    process.chdir(dir);
    try {
        const repo = openRepo();
        assert.equal(stagedPaths(repo).length, 2);
        unstagePaths(repo, ['.playwright-mcp/trace.json']);
        assert.equal(stagedPaths(repo).length, 1);
    } finally {
        process.chdir(realCwd);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('stagedPaths returns the destination of a staged rename', () => {
    const dir = freshRepo();
    try {
        execFileSync('git', ['config', 'diff.renames', 'false'], { cwd: dir });
        execFileSync('git', ['mv', 'README.md', '.env'], { cwd: dir });
        const repo = openRepo(dir);
        assert.deepEqual(stagedPaths(repo), ['.env']);
        const [entry] = stagedEntries(repo);
        assert.equal(entry.path, '.env');
        assert.equal(entry.sourcePath, 'README.md');
        assert.equal(entry.mode, '100644');
        assert.equal(entry.type, 'blob');
        assert.equal(entry.size, 1);
        assert.match(entry.oid, /^[0-9a-f]{40,64}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('stagedPaths includes staged type changes', () => {
    const dir = freshRepo();
    try {
        rmSync(join(dir, 'README.md'));
        symlinkSync('target', join(dir, 'README.md'));
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        assert.deepEqual(stagedPaths(openRepo(dir)), ['README.md']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('trackedEntries retains every blob candidate for an unresolved conflict', () => {
    const dir = freshRepo();
    try {
        const main = execFileSync(
            'git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' },
        ).trim();
        writeFileSync(join(dir, 'conflict.txt'), 'base\n');
        execFileSync('git', ['add', 'conflict.txt'], { cwd: dir });
        commit(dir, 'conflict base');

        execFileSync('git', ['checkout', '-q', '-b', 'secret-side'], { cwd: dir });
        writeFileSync(
            join(dir, 'conflict.txt'),
            '-----BEGIN ' + 'PRIVATE KEY-----\nsecret\n',
        );
        execFileSync('git', ['add', 'conflict.txt'], { cwd: dir });
        commit(dir, 'secret side');

        execFileSync('git', ['checkout', '-q', main], { cwd: dir });
        writeFileSync(join(dir, 'conflict.txt'), 'safe side\n');
        execFileSync('git', ['add', 'conflict.txt'], { cwd: dir });
        commit(dir, 'safe side');
        assert.throws(() => execFileSync('git', ['merge', 'secret-side'], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
        }));

        const entries = trackedEntries(openRepo(dir))
            .filter((entry) => entry.path === 'conflict.txt');
        assert.deepEqual(entries.map((entry) => entry.stage), [1, 2, 3]);
        assert.deepEqual(unmergedPaths(openRepo(dir)), ['conflict.txt']);
        const scan = scanEntries(openRepo(dir), newEngine('strict'), entries);
        assert.ok(scan.findings.some((finding) => finding.ruleId === 'secret.private-key-content'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('target path reads separate missing paths, invalid revisions, and object failures', () => {
    const dir = freshRepo();
    try {
        const repo = openRepo(dir);
        const missingStaged = readStagedPath(repo, '.aimhooman.json');
        const missingCommit = readCommitPath(repo, 'HEAD', '.aimhooman.json');
        assert.equal(missingStaged.status, 'missing');
        assert.equal(missingCommit.status, 'missing');
        assert.match(missingCommit.target, /^commit:[0-9a-f]{40,64}$/);
        assert.throws(
            () => readCommitPath(repo, 'does-not-exist', '.aimhooman.json'),
            GitRevisionError,
        );

        execFileSync('git', [
            'update-index', '--add', '--info-only', '--cacheinfo',
            '100644,1111111111111111111111111111111111111111,.aimhooman.json',
        ], { cwd: dir });
        assert.throws(
            () => readStagedPath(repo, '.aimhooman.json'),
            GitTargetReadError,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('staged and committed path reads return pinned policy object IDs', () => {
    const dir = freshRepo();
    try {
        const policy = '{"schema_version":1,"profile":"strict"}\n';
        writeFileSync(join(dir, '.aimhooman.json'), policy);
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        const repo = openRepo(dir);
        const staged = readStagedPath(repo, '.aimhooman.json');
        assert.equal(staged.status, 'present');
        assert.equal(staged.content.toString(), policy);
        assert.match(staged.oid, /^[0-9a-f]{40,64}$/);

        commit(dir, 'add policy');
        const committed = readCommitPath(repo, 'HEAD', '.aimhooman.json');
        assert.equal(committed.status, 'present');
        assert.equal(committed.oid, staged.oid);
        assert.equal(committed.content.toString(), policy);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('staged deletions retain metadata', () => {
    const dir = freshRepo();
    try {
        execFileSync('git', ['rm', '-q', 'README.md'], { cwd: dir });
        const repo = openRepo(dir);
        assert.deepEqual(stagedEntries(repo), [{
            path: 'README.md',
            oid: null,
            mode: null,
            type: 'deleted',
            status: 'D',
            size: null,
        }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('tracked entries read the current index', () => {
    const dir = freshRepo();
    try {
        // Windows rejects control characters in index paths before ls-files can
        // expose them. History-level NUL parsing covers that case separately;
        // this index test keeps a legal but non-trivial Windows path.
        const oddPath = process.platform === 'win32'
            ? 'tracked unicode å and spaces.txt'
            : 'tracked\nname.txt';
        const indexContent = '// ponytail: deferred cleanup\n';
        const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: dir,
            encoding: 'utf8',
            input: indexContent,
        }).trim();
        execFileSync('git', ['update-index', '-z', '--index-info'], {
            cwd: dir,
            input: Buffer.from(`100644 ${oid}\t${oddPath}\0`),
        });

        const repo = openRepo(dir);
        const entry = trackedEntries(repo).find((candidate) => candidate.path === oddPath);
        assert.equal(entry.stage, 0);
        assert.equal(entry.type, 'blob');
        assert.equal(entry.size, Buffer.byteLength(indexContent));
        const scan = scanEntries(repo, newEngine('strict'), [entry]);
        assert.ok(scan.findings.some((finding) => finding.ruleId === 'marker.corner-cut'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('unstagePaths streams a path collection larger than the Windows command-line limit', () => {
    const dir = freshRepo();
    try {
        const paths = [];
        for (let i = 0; i < 500; i++) {
            const path = `batch-${String(i).padStart(3, '0')}-${'x'.repeat(128)}`;
            paths.push(path);
            writeFileSync(join(dir, path), 'x');
        }
        const pathspecs = Buffer.from(paths.join('\0') + '\0');
        execFileSync('git', [
            '--literal-pathspecs', 'add',
            '--pathspec-from-file=-', '--pathspec-file-nul',
        ], { cwd: dir, input: pathspecs });

        const repo = openRepo(dir);
        assert.equal(stagedPaths(repo).length, paths.length);
        assert.deepEqual(unstagePaths(repo, paths), paths);
        assert.deepEqual(stagedPaths(repo), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('snapshot entries preserve gitlinks without reading them as blobs', () => {
    const dir = freshRepo();
    try {
        const gitlinkOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        execFileSync('git', [
            'update-index', '--add', '--cacheinfo', `160000,${gitlinkOid},vendor/submodule`,
        ], { cwd: dir });

        const repo = openRepo(dir);
        const staged = stagedEntries(repo).find((entry) => entry.path === 'vendor/submodule');
        assert.equal(staged.oid, gitlinkOid);
        assert.equal(staged.mode, '160000');
        assert.equal(staged.type, 'commit');
        assert.equal(typeof staged.size, 'number');

        const tracked = trackedEntries(repo).find((entry) => entry.path === 'vendor/submodule');
        assert.equal(tracked.oid, gitlinkOid);
        assert.equal(tracked.mode, '160000');
        assert.equal(tracked.type, 'commit');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('staged entry metadata reports oversized blobs without reading their content', () => {
    const dir = freshRepo();
    try {
        const size = 65 * 1024 * 1024;
        writeFileSync(join(dir, 'large.bin'), '');
        truncateSync(join(dir, 'large.bin'), size);
        execFileSync('git', ['add', 'large.bin'], { cwd: dir });

        const entry = stagedEntries(openRepo(dir)).find((candidate) => candidate.path === 'large.bin');
        assert.equal(entry.type, 'blob');
        assert.equal(entry.size, size);
        assert.match(entry.oid, /^[0-9a-f]{40,64}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const ZERO = '0'.repeat(40);

function git(dir, args) {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

test('creating a branch from an already-gated tip introduces no commits', () => {
    // Every commit reachable from refs/heads/* was gated when that ref was
    // written, so branching off one re-scans nothing. Before this, a new branch
    // had an all-zero old tip and rescanned the entire ancestry on every
    // `git checkout -b`.
    const dir = freshRepo();
    try {
        writeFileSync(join(dir, 'a.txt'), 'a');
        git(dir, ['add', 'a.txt']);
        commit(dir, 'second');
        const tip = git(dir, ['rev-parse', 'HEAD']);

        const introduced = introducedCommits(openRepo(dir), [
            { oldObjectId: ZERO, newObjectId: tip, ref: 'refs/heads/feature' },
        ]);
        assert.deepEqual(introduced, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('creating a branch still scans commits that no local branch reaches', () => {
    const dir = freshRepo();
    try {
        const base = git(dir, ['rev-parse', 'HEAD']);
        const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
        const orphan = git(dir, ['commit-tree', tree, '-p', base, '-m', 'not on any branch']);

        const introduced = introducedCommits(openRepo(dir), [
            { oldObjectId: ZERO, newObjectId: orphan, ref: 'refs/heads/feature' },
        ]);
        assert.deepEqual(introduced, [orphan], 'an unreached commit must still be scanned');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a tag reaching the proposed tip does not suppress the scan', () => {
    // Tags and remote refs are not gated by aimhooman, so they must never count
    // as proof that a commit was already checked. Only refs/heads/* may.
    const dir = freshRepo();
    try {
        const base = git(dir, ['rev-parse', 'HEAD']);
        const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
        const smuggled = git(dir, ['commit-tree', tree, '-p', base, '-m', 'smuggled']);
        git(dir, ['tag', 'poison', smuggled]);
        git(dir, ['update-ref', 'refs/remotes/origin/poison', smuggled]);

        const introduced = introducedCommits(openRepo(dir), [
            { oldObjectId: ZERO, newObjectId: smuggled, ref: 'refs/heads/feature' },
        ]);
        assert.deepEqual(introduced, [smuggled], 'an ungated tag must not pre-poison reachability');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a branch update that is already visible cannot exclude itself from its own scan', () => {
    // The reference-transaction hook can observe the ref it is being asked about
    // (Git shows it at the `committed` phase, and ref backends differ), so the
    // ref under review must never be used as its own negative.
    const dir = freshRepo();
    try {
        const base = git(dir, ['rev-parse', 'HEAD']);
        const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
        const proposed = git(dir, ['commit-tree', tree, '-p', base, '-m', 'proposed']);
        git(dir, ['update-ref', 'refs/heads/feature', proposed]);

        const introduced = introducedCommits(openRepo(dir), [
            { oldObjectId: ZERO, newObjectId: proposed, ref: 'refs/heads/feature' },
        ]);
        assert.deepEqual(introduced, [proposed], 'the ref under review must not gate itself');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
