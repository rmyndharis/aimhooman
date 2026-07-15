import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedReviewedPaths, pushReviewPlan } from '../scripts/acknowledge-reviewed-paths.mjs';
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

test('reviewed path discovery follows introduced commits and includes deletion-only ranges', () => {
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

        assert.deepEqual(changedReviewedPaths(base, head, root), ['AGENTS.md']);
        assert.deepEqual(changedReviewedPaths(added, head, root), ['AGENTS.md']);
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

test('only one root commit is classified as an initial push bootstrap', () => {
    const root = repository();
    try {
        const first = git(root, ['rev-parse', 'HEAD']);
        assert.equal(pushReviewPlan('0'.repeat(first.length), first, root).initialCommit, true);

        writeFileSync(join(root, 'AGENTS.md'), 'reviewed instructions\n');
        git(root, ['add', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'add instructions']);
        const second = git(root, ['rev-parse', 'HEAD']);
        assert.equal(pushReviewPlan('0'.repeat(second.length), second, root).initialCommit, false);
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

test('push and release workflows call the shared history scan entry point', () => {
    const root = join(import.meta.dirname, '..');
    const testsWorkflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(testsWorkflow, /CI_HISTORY_CONTEXT:\s*push/);
    assert.doesNotMatch(testsWorkflow, /event\.before != ['"]0{40}['"]/);
    assert.match(testsWorkflow, /GITHUB_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
    assert.match(testsWorkflow, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
    assert.match(releaseWorkflow, /CI_HISTORY_CONTEXT:\s*release/);
    assert.match(releaseWorkflow, /node scripts\/verify-release-environment\.mjs/);
    assert.match(releaseWorkflow, /permissions:\s*\n\s*actions:\s*read/);
    assert.match(
        releaseWorkflow,
        /PROTECTED_RELEASE_REVIEW:\s*\$\{\{ steps\.release_environment\.outputs\.protected \}\}/,
    );
    assert.doesNotMatch(releaseWorkflow, /PROTECTED_RELEASE_REVIEW:\s*['"]?true/);
    assert.match(releaseWorkflow, /AIMHOOMAN_ARTIFACT_DIR:/);
    assert.match(releaseWorkflow, /npm publish "\$TARBALL"/);
    assert.match(releaseWorkflow, /dist\.integrity/);
    assert.match(releaseWorkflow, /PUBLISHED_INTEGRITY.*EXPECTED_INTEGRITY/);
    assert.match(releaseWorkflow, /persist-credentials:\s*false/);
    assert.match(releaseWorkflow, /group:\s*aimhooman-npm-release/);
    assert.match(releaseWorkflow, /--registry "\$REGISTRY"/);
    assert.match(releaseWorkflow, /dist\.attestations\.provenance\.predicateType/);
    assert.match(releaseWorkflow, /ACTUAL_INTEGRITY=.*createHash\('sha512'\)/);
    assert.match(releaseWorkflow, /refusing to move it during a rerun/);
    assert.match(
        releaseWorkflow,
        /REGISTRY_STATE=\$\(node scripts\/npm-release-state\.mjs "\$NAME" "\$VERSION" "\$REGISTRY"\)/,
    );
    assert.match(releaseWorkflow, /test "\$ACTUAL_DRAFT" = true/);
    assert.doesNotMatch(
        releaseWorkflow,
        /if npm view "\$NAME@\$VERSION" version/,
    );
    assert.doesNotMatch(
        releaseWorkflow,
        /CURRENT_TAG=\$\(npm view/,
    );
    assert.match(
        releaseWorkflow,
        /node scripts\/release-channel\.mjs channel "\$VERSION"\)" == next/,
    );
    assert.doesNotMatch(releaseWorkflow, /"\$VERSION" == \*-\*/);
    assert.match(
        releaseWorkflow,
        /PUBLISHED_INTEGRITY=.*npm view.*2>\/dev\/null \|\| true/,
    );
    assert.doesNotMatch(releaseWorkflow, /for attempt in/);
    assert.doesNotMatch(releaseWorkflow, /npm dist-tag add/);
    assert.ok(
        releaseWorkflow.indexOf('ACTUAL_INTEGRITY=')
            < releaseWorkflow.indexOf('npm publish "$TARBALL"'),
        'the tarball must be rehashed before publish',
    );
    assert.match(testsWorkflow, /node:\s*['"]22\.8\.0['"]/);
    assert.match(testsWorkflow, /persist-credentials:\s*false/);
    assert.match(testsWorkflow, /npm ci --ignore-scripts/);
    assert.match(releaseWorkflow, /npm ci --ignore-scripts/);
    for (const [name, workflow] of [
        ['tests', testsWorkflow],
        ['release', releaseWorkflow],
    ]) {
        assert.match(
            workflow,
            /actions\/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6\.5\.0/,
            `${name} workflow must pin setup-go`,
        );
        assert.match(workflow, /go-version:\s*['"]1\.25\.x['"]/, `${name} Go version`);
        assert.match(workflow, /cache:\s*false/, `${name} setup-go cache setting`);
        assert.ok(
            workflow.indexOf('actions/setup-go@') < workflow.indexOf('npm run verify'),
            `${name} workflow must install Go before verify`,
        );
    }
    assert.ok(
        releaseWorkflow.indexOf('node scripts/verify-release-environment.mjs')
            < releaseWorkflow.indexOf('node scripts/scan-ci-history.mjs'),
        'release environment protection must be verified before recording review evidence',
    );
});

test('existing draft release state survives bash errexit parsing', () => {
    const root = join(import.meta.dirname, '..');
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    const assignments = releaseWorkflow.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^ACTUAL_(?:DRAFT|PRERELEASE)=/.test(line));
    assert.equal(assignments.length, 2);
    assert.doesNotMatch(assignments.join('\n'), /read\s+-r|<\s*</);
    const checked = spawnSync('bash', ['-euo', 'pipefail', '-c', [
        `RELEASE='{"isDraft":true,"isPrerelease":false}'`,
        ...assignments,
        'test "$ACTUAL_DRAFT" = true',
        'test "$ACTUAL_PRERELEASE" = false',
    ].join('\n')], {
        cwd: root,
        encoding: 'utf8',
    });
    assert.equal(checked.status, 0, checked.stderr);
});
