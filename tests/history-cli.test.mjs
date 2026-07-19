import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const CLI = fileURLToPath(new URL('../bin/aimhooman.mjs', import.meta.url));
const POLICY = (profile) => JSON.stringify({ schema_version: 1, profile }) + '\n';

function isolatedEnvironment(root) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_') || key.startsWith('AIMHOOMAN_')) delete env[key];
    }
    return {
        ...env,
        CI: '1',
        HOME: join(root, '.home'),
        XDG_CONFIG_HOME: join(root, '.xdg'),
        GIT_CONFIG_GLOBAL: join(root, '.isolated-gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C',
    };
}

function repository(options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'aim-history-cli-'));
    const repo = { root, env: isolatedEnvironment(root) };
    const init = options.objectFormat
        ? ['init', '-q', `--object-format=${options.objectFormat}`]
        : ['init', '-q'];
    const result = command(repo, 'git', init);
    if (result.status !== 0) {
        rmSync(root, { recursive: true, force: true });
        return { unsupported: true, result };
    }
    git(repo, ['config', 'user.name', 'History Test']);
    git(repo, ['config', 'user.email', 'history@example.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    return repo;
}

function command(repo, executable, args, options = {}) {
    return spawnSync(executable, args, {
        cwd: repo.root,
        env: repo.env,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        ...options,
    });
}

function git(repo, args, options = {}) {
    const result = command(repo, 'git', args, options);
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    return result.stdout.trim();
}

function cli(repo, args, options = {}) {
    return command(repo, process.execPath, [CLI, ...args], options);
}

function initialize(repo, profile) {
    const args = ['init'];
    if (profile) args.push('--profile', profile);
    const result = cli(repo, args);
    assert.equal(result.status, 0, result.stderr);
}

function addCommit(repo, paths, message, options = {}) {
    git(repo, ['add', ...(options.force ? ['-f'] : []), '--', ...paths]);
    // History fixtures deliberately contain violations. --no-verify skips the
    // ordinary commit hooks, while the reference-transaction guard must be
    // bypassed explicitly so the scanner can inspect already-committed input.
    git(repo, [
        '-c', 'core.hooksPath=/dev/null',
        'commit', '--no-verify', '--no-gpg-sign', '-q', '-m', message,
    ]);
    return git(repo, ['rev-parse', 'HEAD']);
}

function write(repo, path, content) {
    mkdirSync(dirname(join(repo.root, path)), { recursive: true });
    writeFileSync(join(repo.root, path), content);
}

function jsonScan(repo, args, expectedStatus) {
    const result = cli(repo, ['check', ...args, '--json']);
    if (expectedStatus !== undefined) assert.equal(result.status, expectedStatus, result.stderr);
    assert.notEqual(result.stdout.trim(), '', result.stderr);
    return { result, report: JSON.parse(result.stdout) };
}

function cleanup(repo) {
    if (repo?.root) rmSync(repo.root, { recursive: true, force: true });
}

test('machine JSON is fully flushed before the CLI exits', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');
        const paths = [];
        for (let index = 0; index < 30; index += 1) {
            const path = `.claude/session-${String(index).padStart(2, '0')}.json`;
            paths.push(path);
            write(repo, path, '{}\n');
        }
        git(repo, ['add', '-f', '--', ...paths]);

        const { result, report } = jsonScan(repo, ['--staged'], 10);
        assert.ok(result.stdout.length > 8192, `expected more than 8192 bytes, got ${result.stdout.length}`);
        assert.equal(report.findings.length, paths.length);
    } finally {
        cleanup(repo);
    }
});

test('range scans retain forbidden paths and code markers that later disappear', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        const base = addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');

        write(repo, '.claude.json', 'TOKEN=temporary\n');
        const addedConfig = addCommit(repo, ['.claude.json'], 'temporarily add environment', { force: true });
        git(repo, ['rm', '-q', '--', '.claude.json']);
        git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'remove environment']);

        write(repo, '.codex/sessions/state.json', '{}\n');
        const addedSession = addCommit(
            repo,
            ['.codex/sessions/state.json'],
            'temporarily add session state',
            { force: true },
        );
        git(repo, ['rm', '-q', '--', '.codex/sessions/state.json']);
        git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'remove session state']);

        write(repo, 'src/app.js', '// ponytail: temporary shortcut\nexport const value = 1;\n');
        const introducedMarker = addCommit(repo, ['src/app.js'], 'add implementation');
        write(repo, 'src/app.js', 'export const value = 1;\n');
        const removedMarker = addCommit(repo, ['src/app.js'], 'finish implementation');

        const { report } = jsonScan(repo, ['--range', `${base}..HEAD`], 10);
        assert.ok(report.findings.some((finding) => (
            finding.path === '.claude.json' && finding.commit === addedConfig
        )));
        assert.ok(report.findings.some((finding) => (
            finding.path === '.codex/sessions/state.json' && finding.commit === addedSession
        )));
        assert.ok(report.findings.some((finding) => (
            finding.ruleId === 'marker.corner-cut' && finding.commit === introducedMarker
        )));
        assert.ok(!report.findings.some((finding) => (
            finding.ruleId === 'marker.corner-cut' && finding.commit === removedMarker
        )));
    } finally {
        cleanup(repo);
    }
});

test('invalid commit and range revisions are rejected without raw Git diagnostics', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');

        for (const args of [
            ['check', '--commit', 'missing-commit'],
            ['check', '--range', 'HEAD..missing-commit'],
            ['check', '--range', 'missing-base..HEAD'],
        ]) {
            const result = cli(repo, args);
            assert.equal(result.status, 20, result.stderr);
            assert.match(result.stderr, /Git revision .*does not resolve to a commit/);
            assert.doesNotMatch(result.stderr, /fatal:|Command failed|usage:/i);
        }
    } finally {
        cleanup(repo);
    }
});

test('strict CLI reports an incomplete scan when a local regex input is capped', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');
        const rulesDir = join(repo.root, '.git', 'aimhooman', 'rules');
        mkdirSync(rulesDir, { recursive: true });
        writeFileSync(join(rulesDir, 'local.json'), JSON.stringify([{
            id: 'local.long-code',
            version: 1,
            provider: 'local',
            category: 'custom',
            confidence: 'medium',
            kind: 'code',
            match: { content: ['TAIL$'], paths: ['src/**'] },
            actions: { clean: 'block', strict: 'block', compliance: 'block' },
            reason: 'local convention',
        }]));
        write(repo, 'src/long.js', `${'a'.repeat(20_000)}TAIL\n`);
        const commit = addCommit(repo, ['src/long.js'], 'add long source line');

        const { report } = jsonScan(repo, ['--commit', commit], 31);
        assert.equal(report.complete, false);
        assert.equal(report.stats.skipped['local-input-limit'], 1);
        assert.deepEqual(report.findings, []);
    } finally {
        cleanup(repo);
    }
});

test('deleting an ordinary forbidden path does not report its old path or content', () => {
    const repo = repository();
    try {
        write(repo, '.claude.json', 'TOKEN=old\n');
        write(repo, 'src/app.js', '// ponytail: old shortcut\n');
        const base = addCommit(repo, ['.claude.json', 'src/app.js'], 'historical files', { force: true });
        initialize(repo, 'strict');

        git(repo, ['rm', '-q', '--', '.claude.json', 'src/app.js']);
        const deletion = git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'remove old files']);
        const deletedCommit = git(repo, ['rev-parse', 'HEAD']);

        assert.equal(deletion, '');
        const ranged = jsonScan(repo, ['--range', `${base}..${deletedCommit}`], 0).report;
        const committed = jsonScan(repo, ['--commit', deletedCommit], 0).report;
        assert.deepEqual(ranged.findings, []);
        assert.deepEqual(committed.findings, []);
    } finally {
        cleanup(repo);
    }
});

test('an all-zero base scans root history and keeps an add that is later deleted', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'root\n');
        addCommit(repo, ['README.md'], 'root');
        initialize(repo, 'strict');
        write(repo, '.claude.json', 'TOKEN=temporary\n');
        const introduced = addCommit(repo, ['.claude.json'], 'add temporary file', { force: true });
        git(repo, ['rm', '-q', '--', '.claude.json']);
        git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'remove temporary file']);

        const zero = '0'.repeat(40);
        const { report } = jsonScan(repo, ['--range', `${zero}...HEAD`], 10);
        assert.equal(report.range.base, zero);
        assert.equal(report.range.scan_base, zero);
        assert.equal(report.range.commits_scanned, 3);
        assert.ok(report.findings.some((finding) => (
            finding.path === '.claude.json' && finding.commit === introduced
        )));
        assert.ok(!report.findings.some((finding) => (
            finding.path === '.claude.json' && finding.commit !== introduced
        )));
        assert.ok(report.range.head);
    } finally {
        cleanup(repo);
    }
});

test('root-history bootstrap preserves a strict policy deletion finding', () => {
    const repo = repository();
    try {
        write(repo, '.aimhooman.json', POLICY('strict'));
        const root = addCommit(repo, ['.aimhooman.json'], 'strict root policy');
        git(repo, ['rm', '-q', '--', '.aimhooman.json']);
        git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'remove strict policy']);
        const deletion = git(repo, ['rev-parse', 'HEAD']);
        initialize(repo);

        const zero = '0'.repeat(40);
        const { report } = jsonScan(repo, ['--range', `${zero}...${deletion}`], 10);
        assert.ok(report.findings.some((finding) => (
            finding.ruleId === 'generic.project-policy'
            && finding.commit === deletion
            && /deleted/.test(finding.reason)
        )));
        assert.equal(report.policy_source, 'parent-strict-floor');
        assert.equal(report.policy_object_id, git(repo, ['rev-parse', `${root}:.aimhooman.json`]));
    } finally {
        cleanup(repo);
    }
});

test('range scans inspect attribution in the first, middle, and last commit messages', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        const base = addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');

        write(repo, 'one.txt', 'one\n');
        const first = addCommit(repo, ['one.txt'], 'Generated with Codex');
        write(repo, 'two.txt', 'two\n');
        const middle = addCommit(
            repo,
            ['two.txt'],
            'middle\n\nCo-authored-by: Claude <noreply@anthropic.com>',
        );
        write(repo, 'three.txt', 'three\n');
        const last = addCommit(
            repo,
            ['three.txt'],
            'last\n\nCo-authored-by: GitHub Copilot <copilot@github.com>',
        );

        const { report } = jsonScan(repo, ['--range', `${base}..HEAD`], 10);
        const messageCommits = new Set(report.findings
            .filter((finding) => finding.category === 'ai-attribution')
            .map((finding) => finding.commit));
        assert.deepEqual(messageCommits, new Set([first, middle, last]));
        assert.equal(report.message_scanned, true);
    } finally {
        cleanup(repo);
    }
});

test('--commit scans its own message, snapshot, and historical project policy', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        addCommit(repo, ['README.md'], 'base');
        write(repo, '.aimhooman.json', POLICY('strict'));
        write(repo, 'src/app.js', '// ponytail: temporary shortcut\nexport const value = 1;\n');
        const historical = addCommit(
            repo,
            ['.aimhooman.json', 'src/app.js'],
            'feature\n\nGenerated with Codex',
        );
        const historicalPolicy = git(repo, ['rev-parse', `${historical}:.aimhooman.json`]);

        write(repo, '.aimhooman.json', POLICY('clean'));
        write(repo, 'src/app.js', 'export const value = 1;\n');
        addCommit(repo, ['.aimhooman.json', 'src/app.js'], 'change current policy');
        initialize(repo);

        const { report } = jsonScan(repo, ['--commit', historical], 10);
        assert.equal(report.commit, historical);
        assert.equal(report.target, `commit:${historical}`);
        assert.equal(report.profile, 'strict');
        assert.equal(report.policy_source, 'commit-policy');
        assert.equal(report.policy_object_id, historicalPolicy);
        assert.equal(report.message_scanned, true);
        assert.ok(report.findings.some((finding) => finding.ruleId === 'marker.corner-cut'));
        assert.ok(report.findings.some((finding) => finding.category === 'ai-attribution'));
        assert.ok(report.findings.every((finding) => finding.commit === historical));
    } finally {
        cleanup(repo);
    }
});

test('a temporary strict-policy downgrade or deletion remains visible after restoration', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        addCommit(repo, ['README.md'], 'base');
        write(repo, '.aimhooman.json', POLICY('strict'));
        const strictBase = addCommit(repo, ['.aimhooman.json'], 'set strict policy');

        write(repo, '.aimhooman.json', POLICY('clean'));
        const downgrade = addCommit(repo, ['.aimhooman.json'], 'temporarily lower policy');
        write(repo, '.aimhooman.json', POLICY('strict'));
        addCommit(repo, ['.aimhooman.json'], 'restore strict policy');
        git(repo, ['rm', '-q', '--', '.aimhooman.json']);
        git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'temporarily remove policy']);
        const deletion = git(repo, ['rev-parse', 'HEAD']);
        write(repo, '.aimhooman.json', POLICY('strict'));
        addCommit(repo, ['.aimhooman.json'], 'restore strict policy again');
        initialize(repo);

        const { report } = jsonScan(repo, ['--range', `${strictBase}..HEAD`], 10);
        const protectedFindings = report.findings.filter((finding) => (
            finding.ruleId === 'generic.project-policy'
            && (finding.commit === downgrade || finding.commit === deletion)
        ));
        assert.ok(protectedFindings.some((finding) => (
            finding.commit === downgrade && /downgraded/.test(finding.reason)
        )));
        assert.ok(protectedFindings.some((finding) => (
            finding.commit === deletion && /deleted/.test(finding.reason)
        )));
        assert.equal(report.policy_source, 'parent-strict-floor');
    } finally {
        cleanup(repo);
    }
});

test('check --commit honors a policy-migration ack bound to the repo HEAD', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        addCommit(repo, ['README.md'], 'base');
        write(repo, '.aimhooman.json', POLICY('strict'));
        const strictBase = addCommit(repo, ['.aimhooman.json'], 'set strict policy');
        const strictOid = git(repo, ['rev-parse', `${strictBase}:.aimhooman.json`]);

        write(repo, '.aimhooman.json', POLICY('clean'));
        const downgrade = addCommit(repo, ['.aimhooman.json'], 'downgrade to clean');
        const downgradeOid = git(repo, ['rev-parse', `${downgrade}:.aimhooman.json`]);
        // Advance HEAD past the downgrade so the ack binds to repo HEAD, which
        // differs from the scanned commit (this is what distinguishes the fix:
        // the old code probed with head=snapshot.commit and never matched).
        write(repo, 'src/app.js', 'export const value = 1;\n');
        addCommit(repo, ['src/app.js'], 'later work');
        const head = git(repo, ['rev-parse', 'HEAD']);
        initialize(repo);

        // Without an ack, check --commit flags the downgrade under the strict floor.
        const blocked = jsonScan(repo, ['--commit', downgrade], 10).report;
        assert.ok(blocked.findings.some((f) => (
            f.commit === downgrade && /downgraded/.test(f.reason)
        )), 'expected a strict-floor finding before the ack');
        assert.equal(blocked.policy_source, 'parent-strict-floor');

        // Record the ack the way `policy-review` does, bound to the repo HEAD.
        const ack = cli(repo, [
            'policy-review',
            '--head', head,
            '--transition', downgrade,
            '--old', strictOid,
            '--new', downgradeOid,
            '--reason', 'reviewed downgrade',
        ]);
        assert.equal(ack.status, 0, ack.stderr);

        // With the ack, check --commit honors it: the strict-floor finding
        // (reason "downgraded") is lifted and the policy source is no longer the
        // parent-strict-floor. The .aimhooman.json path-rule review may still
        // appear (that is a separate rule), so the assertion targets the floor.
        const honored = jsonScan(repo, ['--commit', downgrade], 0).report;
        assert.ok(!honored.findings.some((f) => (
            f.commit === downgrade && /downgraded/.test(f.reason)
        )), 'the strict-floor finding must be lifted after the ack');
        assert.notEqual(honored.policy_source, 'parent-strict-floor');
    } finally {
        cleanup(repo);
    }
});

test('two-dot and three-dot ranges report their distinct scan bases', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        const common = addCommit(repo, ['README.md'], 'base');
        git(repo, ['checkout', '-q', '-b', 'side']);
        write(repo, 'side.txt', 'side\n');
        const side = addCommit(repo, ['side.txt'], 'side change');
        git(repo, ['checkout', '-q', '-b', 'feature', common]);
        write(repo, 'src/app.js', '// ponytail: feature shortcut\n');
        const feature = addCommit(repo, ['src/app.js'], 'feature change');
        initialize(repo, 'strict');

        const two = jsonScan(repo, ['--range', `${side}..${feature}`], 10).report;
        const three = jsonScan(repo, ['--range', `${side}...${feature}`], 10).report;
        assert.equal(two.range.base, side);
        assert.equal(two.range.scan_base, side);
        assert.equal(three.range.base, side);
        assert.equal(three.range.scan_base, common);
        for (const report of [two, three]) {
            assert.equal(report.range.head, feature);
            assert.ok(report.findings.some((finding) => finding.commit === feature));
            assert.ok(!report.findings.some((finding) => finding.commit === side));
        }
    } finally {
        cleanup(repo);
    }
});

test('--commit scans a root commit without requiring a parent', () => {
    const repo = repository();
    try {
        write(repo, '.claude.json', 'TOKEN=root\n');
        const root = addCommit(repo, ['.claude.json'], 'Generated with Codex', { force: true });
        initialize(repo, 'strict');

        const { report } = jsonScan(repo, ['--commit', root], 10);
        assert.equal(report.commit, root);
        assert.ok(report.findings.some((finding) => finding.path === '.claude.json'));
        assert.ok(report.findings.some((finding) => finding.category === 'ai-attribution'));
    } finally {
        cleanup(repo);
    }
});

test('merge history output is deterministic and retains per-parent findings', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        const base = addCommit(repo, ['README.md'], 'base');
        git(repo, ['checkout', '-q', '-b', 'left']);
        write(repo, '.claude.json', 'TOKEN=left\n');
        const left = addCommit(repo, ['.claude.json'], 'left change', { force: true });
        git(repo, ['checkout', '-q', '-b', 'right', base]);
        write(repo, '.codex/sessions/state.json', '{}\n');
        const right = addCommit(repo, ['.codex/sessions/state.json'], 'right change');
        git(repo, ['checkout', '-q', 'left']);
        git(repo, ['merge', '--no-ff', '--no-commit', 'right']);
        write(repo, '.playwright-mcp/merge.json', '{}\n');
        git(repo, ['add', '--', '.playwright-mcp/merge.json']);
        git(repo, ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', 'merge branches']);
        const merge = git(repo, ['rev-parse', 'HEAD']);
        initialize(repo, 'strict');

        const first = jsonScan(repo, ['--range', `${base}..${merge}`], 10).report;
        const second = jsonScan(repo, ['--range', `${base}..${merge}`], 10).report;
        assert.deepEqual(second, first);
        assert.ok(first.findings.some((finding) => finding.commit === left && finding.path === '.claude.json'));
        assert.ok(first.findings.some((finding) => (
            finding.commit === right && finding.path === '.codex/sessions/state.json'
        )));
        const mergeResult = first.findings.filter((finding) => (
            finding.commit === merge && finding.path === '.playwright-mcp/merge.json'
        ));
        assert.equal(mergeResult.length, 1);
        assert.deepEqual(new Set(mergeResult[0].parents), new Set([left, right]));
    } finally {
        cleanup(repo);
    }
});

test('range scans preserve unusual Git path bytes represented by valid UTF-8', () => {
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        const base = addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');
        const unusual = process.platform === 'win32'
            ? 'odd unicode å and spaces/.claude.json'
            : 'odd å\tline\nbreak/.claude.json';
        write(repo, unusual, 'TOKEN=unusual\n');
        const commit = addCommit(repo, [unusual], 'add unusual path', { force: true });

        const { report } = jsonScan(repo, ['--range', `${base}..${commit}`], 10);
        assert.ok(report.findings.some((finding) => (
            finding.path === unusual && finding.commit === commit
        )));
    } finally {
        cleanup(repo);
    }
});

test('POSIX history keeps literal backslashes distinct from path separators', (t) => {
    if (process.platform === 'win32') {
        t.skip('Windows treats backslash as a path separator');
        return;
    }
    const repo = repository();
    try {
        write(repo, 'README.md', 'base\n');
        const base = addCommit(repo, ['README.md'], 'base');
        initialize(repo, 'strict');
        const sessionNearMiss = '.codex\\sessions/state.js';
        const blockedPath = 'odd\\segment/.claude.json';
        write(repo, sessionNearMiss, '// ponytail: verify literal backslash\n');
        write(repo, blockedPath, 'TOKEN=literal-backslash\n');
        const commit = addCommit(
            repo,
            [sessionNearMiss, blockedPath],
            'add literal backslash paths',
            { force: true },
        );

        const { report } = jsonScan(repo, ['--range', `${base}..${commit}`], 10);
        const marker = report.findings.find((finding) => (
            finding.path === sessionNearMiss && finding.ruleId === 'marker.corner-cut'
        ));
        assert.ok(marker);
        assert.ok(!marker.matchedRuleIds.includes('codex.session-state'));
        assert.ok(!report.findings.some((finding) => finding.path === '.codex/sessions/state.js'));
        assert.ok(report.findings.some((finding) => (
            finding.path === blockedPath && finding.commit === commit
        )));
    } finally {
        cleanup(repo);
    }
});

test('a shared blob is read once while each path is scanned', () => {
    const repo = repository();
    try {
        const content = '// ponytail: shared shortcut\nexport const value = 1;\n';
        write(repo, 'src/one.js', content);
        write(repo, 'src/two.js', content);
        const commit = addCommit(repo, ['src/one.js', 'src/two.js'], 'shared blob');
        initialize(repo, 'strict');

        const { report } = jsonScan(repo, ['--commit', commit], 10);
        const markers = report.findings.filter((finding) => finding.ruleId === 'marker.corner-cut');
        assert.equal(report.stats.entries, 2);
        assert.equal(report.stats.blob_files, 2);
        assert.equal(report.stats.objects_read, 1);
        assert.equal(report.stats.files_scanned, 2);
        assert.equal(markers.length, 2);
        assert.equal(new Set(markers.map((finding) => finding.objectId)).size, 1);
    } finally {
        cleanup(repo);
    }
});

test('JSON reports bind findings to commit, object, policy, and scan completeness', () => {
    const repo = repository();
    try {
        write(repo, '.aimhooman.json', POLICY('strict'));
        write(repo, 'src/app.js', '// ponytail: report metadata\n');
        const commit = addCommit(
            repo,
            ['.aimhooman.json', 'src/app.js'],
            'report metadata\n\nGenerated with Codex',
        );
        const policyObject = git(repo, ['rev-parse', `${commit}:.aimhooman.json`]);
        const codeObject = git(repo, ['rev-parse', `${commit}:src/app.js`]);
        initialize(repo);

        const { report } = jsonScan(repo, ['--commit', commit], 10);
        assert.equal(report.schema_version, 1);
        assert.equal(report.commit, commit);
        assert.equal(report.policy_object_id, policyObject);
        assert.equal(report.complete, true);
        assert.equal(typeof report.stats.entries, 'number');
        assert.equal(typeof report.stats.objects_read, 'number');
        assert.deepEqual(report.stats.skipped, {});
        const marker = report.findings.find((finding) => finding.ruleId === 'marker.corner-cut');
        assert.equal(marker.commit, commit);
        assert.equal(marker.objectId, codeObject);
        assert.equal(marker.policyObjectId, policyObject);
        assert.equal(marker.policySource, 'commit-policy');
        assert.equal(marker.scanProfile, 'strict');
    } finally {
        cleanup(repo);
    }
});

test('a 1000-blob commit is scanned within the batched-object time budget', () => {
    const repo = repository();
    try {
        for (let index = 0; index < 1000; index++) {
            write(repo, `src/file-${String(index).padStart(4, '0')}.js`, `export const value${index} = ${index};\n`);
        }
        const commit = addCommit(repo, ['src'], 'many blobs');
        initialize(repo, 'strict');

        const started = performance.now();
        const { report } = jsonScan(repo, ['--commit', commit], 0);
        const elapsed = performance.now() - started;
        assert.equal(report.complete, true);
        assert.equal(report.stats.blob_files, 1000);
        assert.equal(report.stats.objects_read, 1000);
        assert.equal(report.stats.files_scanned, 1000);
        // Correctness (1000 objects read, scan complete) is always asserted. The
        // wall-clock budget is asserted only when AIM_PERF is set: a hard ms
        // ceiling flakes on loaded CI runners, so the elapsed time is otherwise
        // logged as a diagnostic rather than gating the run.
        if (process.env.AIM_PERF) {
            const ceiling = process.platform === 'win32' ? 6000 : 3500;
            assert.ok(
                elapsed < ceiling,
                `1000 blobs took ${elapsed.toFixed(0)}ms; expected about 2s with a ${ceiling}ms platform margin`,
            );
        } else {
            console.log(`aimhooman perf: 1000 blobs scanned in ${elapsed.toFixed(0)}ms (budget ~2000ms)`);
        }
    } finally {
        cleanup(repo);
    }
});

test('history scanning accepts SHA-256 repositories when supported by Git', (t) => {
    const repo = repository({ objectFormat: 'sha256' });
    if (repo.unsupported) {
        t.skip(`Git does not support SHA-256 repositories: ${repo.result.stderr.trim()}`);
        return;
    }
    try {
        write(repo, '.claude.json', 'TOKEN=sha256\n');
        const commit = addCommit(repo, ['.claude.json'], 'sha256 root', { force: true });
        initialize(repo, 'strict');

        const { report } = jsonScan(repo, ['--commit', commit], 10);
        assert.match(report.commit, /^[0-9a-f]{64}$/);
        const finding = report.findings.find((candidate) => candidate.path === '.claude.json');
        assert.match(finding.objectId, /^[0-9a-f]{64}$/);
    } finally {
        cleanup(repo);
    }
});
