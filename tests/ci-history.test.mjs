import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedProtectedPaths } from '../scripts/authorize-owner-paths.mjs';
import { selectPushBase, selectReleaseBase } from '../scripts/scan-ci-history.mjs';

function repository() {
    const root = mkdtempSync(join(tmpdir(), 'aim-ci-history-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'CI History Test']);
    git(root, ['config', 'user.email', 'ci-history@example.com']);
    writeFileSync(join(root, 'README.md'), 'root\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-q', '-m', 'root']);
    return root;
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('protected path discovery follows introduced commits and includes deletion-only ranges', () => {
    const root = repository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        writeFileSync(join(root, 'AGENTS.md'), 'reviewed instructions\n');
        git(root, ['add', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'add instructions']);
        const added = git(root, ['rev-parse', 'HEAD']);
        git(root, ['rm', '-q', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'remove instructions']);
        const head = git(root, ['rev-parse', 'HEAD']);

        assert.deepEqual(changedProtectedPaths(base, head, root), ['AGENTS.md']);
        assert.deepEqual(changedProtectedPaths(added, head, root), ['AGENTS.md']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('new branch push selection uses the default-branch merge base or root bootstrap', () => {
    const root = repository();
    try {
        const main = git(root, ['rev-parse', 'HEAD']);
        git(root, ['update-ref', 'refs/remotes/origin/main', main]);
        assert.equal(selectPushBase({
            before: '0'.repeat(40), head: main, refName: 'topic', defaultBranch: 'main', cwd: root,
        }), null);

        git(root, ['checkout', '-q', '-b', 'topic']);
        writeFileSync(join(root, 'topic.txt'), 'topic\n');
        git(root, ['add', 'topic.txt']);
        git(root, ['commit', '-q', '-m', 'topic']);
        const topic = git(root, ['rev-parse', 'HEAD']);
        assert.equal(selectPushBase({
            before: '0'.repeat(40), head: topic, refName: 'topic', defaultBranch: 'main', cwd: root,
        }), main);
        assert.equal(selectPushBase({
            before: main, head: topic, refName: 'topic', defaultBranch: 'main', cwd: root,
        }), main);

        git(root, ['checkout', '-q', '--orphan', 'orphan']);
        git(root, ['rm', '-q', '-rf', '.']);
        writeFileSync(join(root, 'orphan.txt'), 'orphan\n');
        git(root, ['add', 'orphan.txt']);
        git(root, ['commit', '-q', '-m', 'orphan']);
        const orphan = git(root, ['rev-parse', 'HEAD']);
        assert.equal(selectPushBase({
            before: '0'.repeat(40), head: orphan, refName: 'orphan', defaultBranch: 'main', cwd: root,
        }), '0'.repeat(40));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('force push with an unreachable before object scans all reachable history', () => {
    const root = repository();
    try {
        const head = git(root, ['rev-parse', 'HEAD']);
        const unavailable = 'f'.repeat(head.length);
        assert.equal(selectPushBase({
            before: unavailable, head, refName: 'main', defaultBranch: 'main', cwd: root,
        }), '0'.repeat(head.length));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('untrusted reachable version tags never shorten the release scan', () => {
    const root = repository();
    try {
        const first = git(root, ['rev-parse', 'HEAD']);
        git(root, ['tag', 'v0.0.1', first]);
        writeFileSync(join(root, 'next.txt'), 'next\n');
        git(root, ['add', 'next.txt']);
        git(root, ['commit', '-q', '-m', 'next']);
        const head = git(root, ['rev-parse', 'HEAD']);
        git(root, ['tag', 'v0.1.0', head]);

        assert.equal(selectReleaseBase({ head, currentTag: 'v0.1.0', cwd: root }), '0'.repeat(40));
        git(root, ['tag', '-d', 'v0.0.1']);
        assert.equal(selectReleaseBase({ head, currentTag: 'v0.1.0', cwd: root }), '0'.repeat(40));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('push workflow scans history; release workflow cuts a tag into a direct npm publish', () => {
    const root = join(import.meta.dirname, '..');
    const testsWorkflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

    // The test workflow scans pushed/pulled history through the shared entry point.
    assert.match(testsWorkflow, /CI_HISTORY_CONTEXT:\s*push/);
    assert.match(testsWorkflow, /permissions:\s*\n\s*actions:\s*read/);
    assert.doesNotMatch(testsWorkflow, /event\.before != ['"]0{40}['"]/);
    assert.match(testsWorkflow, /GITHUB_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
    assert.match(testsWorkflow, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
    assert.match(testsWorkflow, /node scripts\/authorize-owner-paths\.mjs/);
    assert.doesNotMatch(testsWorkflow, /pull-requests:\s*read|CODEOWNERS|approval/);
    assert.match(testsWorkflow, /node:\s*['"]22\.8\.0['"]/);
    assert.match(testsWorkflow, /persist-credentials:\s*false/);
    assert.match(testsWorkflow, /npm ci --ignore-scripts/);

    // The release workflow cuts a version tag into a direct npm publish with
    // provenance, gated by the same verification the push workflow runs.
    assert.match(releaseWorkflow, /tags:\s*\["v\*"\]/);
    assert.match(releaseWorkflow, /id-token:\s*write/);
    assert.match(releaseWorkflow, /node-version:\s*24/);
    assert.match(releaseWorkflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
    assert.match(releaseWorkflow, /npm ci --ignore-scripts/);
    assert.match(releaseWorkflow, /run:\s*npm run verify/);
    assert.match(releaseWorkflow, /npm publish --access public --provenance/);
    assert.match(releaseWorkflow, /NODE_AUTH_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/);
});
