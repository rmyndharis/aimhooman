import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedPathAuthorizationPlan } from '../scripts/authorize-owner-paths.mjs';
import { selectPushBase } from '../src/history-scan.mjs';

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

        assert.deepEqual(protectedPathAuthorizationPlan(base, head, root).paths, ['AGENTS.md']);
        assert.deepEqual(protectedPathAuthorizationPlan(added, head, root).paths, ['AGENTS.md']);
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

// The action's own step, run the way a runner runs it, with the final check
// echoed: each push shape gets the scan base the docs promise.
test('the action step picks a scan base for each push shape', (t) => {
    if (process.platform === 'win32') {
        t.skip('runs the step under bash');
        return;
    }
    const root = join(import.meta.dirname, '..');
    const action = readFileSync(join(root, 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
    const block = action.split('- name: Check the introduced commits\n')[1].split('\n      shell: bash')[0];
    const step = block.split('\n').slice(1).map((line) => line.replace(/^ {8}/, '')).join('\n')
        .replace('aimhooman check --range', 'echo RANGE');
    const dir = repository();
    try {
        const script = join(dir, '.git', 'step.sh');
        writeFileSync(script, step);
        const run = (base, head, refName) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_ACTION_PATH: root, BASE: base, HEAD: head, PROFILE: 'strict', REF_NAME: refName, DEFAULT_BRANCH: 'main' },
        });
        const zero = '0'.repeat(40);
        git(dir, ['commit', '-q', '--allow-empty', '-m', 'base']);
        const main = git(dir, ['rev-parse', 'HEAD']);
        git(dir, ['update-ref', 'refs/remotes/origin/main', main]);
        git(dir, ['checkout', '-q', '-b', 'feature']);
        git(dir, ['commit', '-q', '--allow-empty', '-m', 'feature']);
        const feature = git(dir, ['rev-parse', 'HEAD']);

        assert.match(run(zero, feature, 'feature').stdout, new RegExp(`RANGE ${main}\\.\\.\\.${feature}`));
        const empty = run(zero, main, 'empty');
        assert.equal(empty.status, 0);
        assert.match(empty.stdout, /adds no commits outside main/);
        assert.match(run('1'.repeat(40), feature, 'feature').stdout, new RegExp(`RANGE ${zero}\\.\\.\\.${feature}`));
        const missing = run(zero, '2'.repeat(40), 'feature');
        assert.equal(missing.status, 20);
        assert.match(missing.stderr, /^aimhooman: Git revision/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('push workflow scans history; release workflow cuts a tag into a direct npm publish', () => {
    const root = join(import.meta.dirname, '..');
    const testsWorkflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    // Windows checkouts convert the workflow to CRLF; the job split below reads lines.
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
        .replace(/\r\n/g, '\n');

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
    assert.match(releaseWorkflow, /node-version:\s*24/);
    assert.match(releaseWorkflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
    // Verify runs the dev packages with read access only. Publish alone may
    // write, publishes the tarball verify tested, and refuses a tag that is
    // not on main or does not name the package version.
    const [top, verifyJob, publishJob] = releaseWorkflow.split(/\n {2}(?:verify|publish):\n/);
    assert.ok(publishJob, 'release workflow has a verify job and then a publish job');
    assert.doesNotMatch(top + verifyJob, /:\s*write/);
    assert.match(verifyJob, /npm ci --ignore-scripts/);
    assert.match(verifyJob, /AIMHOOMAN_ARTIFACT_DIR:[^\n]*\n\s*run:\s*npm run verify/);
    assert.match(verifyJob, /actions\/upload-artifact@[0-9a-f]{40} /);
    assert.match(publishJob, /needs:\s*verify\n/);
    assert.match(publishJob, /contents:\s*write/);
    assert.match(publishJob, /id-token:\s*write/);
    assert.match(publishJob, /git fetch [^\n]*origin \+refs\/heads\/main:refs\/remotes\/origin\/main\n/);
    assert.match(publishJob, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main \|\|/);
    assert.match(publishJob, /\[ "\$TAG" = "v\$VERSION" \] \|\|/);
    assert.match(publishJob, /actions\/download-artifact@[0-9a-f]{40} /);
    assert.match(publishJob, /npm publish "\$RUNNER_TEMP\/package\/[^"]+\.tgz" --provenance/);
    assert.doesNotMatch(publishJob, /npm (?:ci|install|pack|run)\b/);
    // Trusted publishing, so no npm credential may reappear in the workflow:
    // the OIDC exchange is what authenticates, and a token added back beside it
    // would be a long-lived secret doing nothing but waiting to leak. This
    // matches the usage forms, not the words — the step comment explains the
    // scheme and naming it there is not a credential.
    assert.doesNotMatch(releaseWorkflow, /NODE_AUTH_TOKEN\s*:/);
    assert.doesNotMatch(releaseWorkflow, /\$\{\{\s*secrets\./);
});
