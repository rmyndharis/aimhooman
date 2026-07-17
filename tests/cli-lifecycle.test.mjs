import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/aimhooman.mjs', import.meta.url));
const ATTRIBUTION = 'Fix the parser\n\nCo-authored-by: Claude <noreply@anthropic.com>\n';

function createRepo(profile = null) {
    const root = mkdtempSync(join(tmpdir(), 'aim-lifecycle-repo-'));
    const home = mkdtempSync(join(tmpdir(), 'aim-lifecycle-home-'));
    const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
    };
    const repo = { root, home, env };
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Test User']);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '--no-verify', '-q', '-m', 'Initial fixture']);
    if (profile) {
        const initialized = run(repo, ['init', '--profile', profile]);
        assert.equal(initialized.status, 0, initialized.stderr);
    }
    return repo;
}

function cleanup(...repos) {
    for (const repo of repos) {
        if (!repo) continue;
        rmSync(repo.root, { recursive: true, force: true });
        rmSync(repo.home, { recursive: true, force: true });
    }
}

function git(repo, args, options = {}) {
    return execFileSync('git', args, {
        cwd: repo.root,
        env: repo.env,
        encoding: 'utf8',
        stdio: options.stdio,
    }).trim();
}

function run(repo, args, options = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: repo.root,
        env: repo.env,
        encoding: 'utf8',
        input: options.input,
    });
}

function gitPath(repo, name) {
    return git(repo, ['rev-parse', '--path-format=absolute', '--git-path', name]);
}

function stateDir(repo) {
    return gitPath(repo, 'aimhooman');
}

function writePolicy(repo, profile) {
    writeFileSync(
        join(repo.root, '.aimhooman.json'),
        JSON.stringify({ schema_version: 1, profile }) + '\n',
    );
}

function jsonOutput(result) {
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
}

test('main commands reject unknown options before doing work', async (t) => {
    const repo = createRepo('clean');
    const message = join(repo.root, 'COMMIT_MESSAGE');
    writeFileSync(message, 'Normal message\n');
    try {
        const cases = [
            ['check', '--unknown'],
            ['audit', '--unknown'],
            ['scan', '--unknown'],
            ['precommit', '--unknown'],
            ['commitmsg', message, '--unknown'],
            ['init', '--unknown'],
            ['status', '--unknown'],
            ['explain', 'secret.dotenv', '--unknown'],
            ['allow', 'README.md', '--unknown'],
            ['deny', 'README.md', '--unknown'],
            ['override', 'list', '--unknown'],
            ['review', 'AGENTS.md', '--head', 'HEAD', '--unknown'],
            ['policy-review', '--unknown'],
            ['fix', '--message', message, '--unknown'],
            ['doctor', '--unknown'],
            ['uninstall', '--unknown'],
            ['version', '--unknown'],
        ];
        for (const args of cases) {
            await t.test(args[0], () => {
                const result = run(repo, args);
                assert.equal(result.status, 20, `${args.join(' ')}\n${result.stderr}`);
                assert.match(result.stderr, /unknown option/);
            });
        }

        const unknownCommand = run(repo, ['does-not-exist']);
        assert.equal(unknownCommand.status, 20);
        assert.match(unknownCommand.stderr, /unknown command/);
    } finally {
        cleanup(repo);
    }
});

test('repeatable-looking singleton flags and conflicting modes are rejected', async (t) => {
    const repo = createRepo('clean');
    const message = join(repo.root, 'COMMIT_MESSAGE');
    writeFileSync(message, 'Normal message\n');
    try {
        const repeated = [
            ['check', '--json', '--json'],
            ['check', '--profile', 'clean', '--profile', 'strict'],
            ['init', '--profile', 'clean', '--profile', 'strict'],
            ['allow', 'README.md', '--reason', 'one', '--reason', 'two'],
            ['deny', 'README.md', '--reason', 'one', '--reason', 'two'],
            ['override', 'list', '--json', '--json'],
            ['review', 'AGENTS.md', '--head', 'HEAD', '--head', 'HEAD'],
            ['policy-review', '--head', 'HEAD', '--head', 'HEAD'],
            ['fix', '--message', message, '--message', message],
            ['uninstall', '--purge-state', '--purge-state'],
        ];
        for (const args of repeated) {
            await t.test(`repeated: ${args[0]} ${args[1]}`, () => {
                const result = run(repo, args);
                assert.equal(result.status, 20, `${args.join(' ')}\n${result.stderr}`);
                assert.match(result.stderr, /may only be used once/);
            });
        }

        const conflicts = [
            ['check', '--staged', '--tracked'],
            ['audit', '--staged'],
            ['scan', '--commit', 'HEAD'],
            ['init', '--global', '--profile', 'clean'],
            ['override', 'reset', '--allow', '--deny'],
            ['policy-review', '--staged', '--transition', 'HEAD'],
            ['uninstall', '--global', '--purge-state'],
        ];
        for (const args of conflicts) {
            await t.test(`conflict: ${args[0]} ${args[1]}`, () => {
                const result = run(repo, args);
                assert.equal(result.status, 20, `${args.join(' ')}\n${result.stderr}`);
                assert.match(result.stderr, /options conflict/);
            });
        }
    } finally {
        cleanup(repo);
    }
});

test('a misspelled global uninstall flag leaves repository enforcement intact', () => {
    const repo = createRepo('strict');
    try {
        const hooks = gitPath(repo, 'hooks');
        const before = {
            precommit: readFileSync(join(hooks, 'pre-commit')),
            premerge: readFileSync(join(hooks, 'pre-merge-commit')),
            commitmsg: readFileSync(join(hooks, 'commit-msg')),
            config: readFileSync(join(stateDir(repo), 'config.json')),
            exclude: readFileSync(gitPath(repo, 'info/exclude')),
        };

        const result = run(repo, ['uninstall', '--gloabl']);
        assert.equal(result.status, 20, result.stderr);
        assert.match(result.stderr, /unknown option "--gloabl"/);
        assert.deepEqual(readFileSync(join(hooks, 'pre-commit')), before.precommit);
        assert.deepEqual(readFileSync(join(hooks, 'pre-merge-commit')), before.premerge);
        assert.deepEqual(readFileSync(join(hooks, 'commit-msg')), before.commitmsg);
        assert.deepEqual(readFileSync(join(stateDir(repo), 'config.json')), before.config);
        assert.deepEqual(readFileSync(gitPath(repo, 'info/exclude')), before.exclude);

        const status = run(repo, ['status']);
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /hooks:\s+commit-msg, pre-commit, pre-merge-commit, reference-transaction/);
    } finally {
        cleanup(repo);
    }
});

test('uninstall --purge-state removes the shared state directory; plain uninstall keeps it', () => {
    const repo = createRepo('strict');
    try {
        // init created the shared state directory under the common git dir.
        assert.equal(existsSync(stateDir(repo)), true);

        // Plain uninstall keeps the state directory for local policy continuity.
        const keep = run(repo, ['uninstall']);
        assert.equal(keep.status, 0, keep.stderr);
        assert.match(keep.stdout, /state kept/);
        assert.equal(existsSync(stateDir(repo)), true);

        // Reinstall, then purge: the shared state directory itself is gone.
        const reinstalled = run(repo, ['init', '--profile', 'strict']);
        assert.equal(reinstalled.status, 0, reinstalled.stderr);
        assert.equal(existsSync(stateDir(repo)), true);

        const purge = run(repo, ['uninstall', '--purge-state']);
        assert.equal(purge.status, 0, purge.stderr);
        assert.match(purge.stdout, /state purged/);
        assert.equal(existsSync(stateDir(repo)), false);
    } finally {
        cleanup(repo);
    }
});

test('a damaged exclude marker cannot swallow the uninstall report', {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
    // uninstall does the irreversible work first — remove the dispatchers,
    // restore any chained originals — then clears the managed excludes, and only
    // then reports. Removing one of the two markers by hand made that clear
    // throw, and the throw unwound past the whole report, including the check
    // that exists because a surviving dispatcher printed under "uninstalled"
    // reads as done. A read-only hooks directory keeps every dispatcher alive,
    // so the user must be told they are still guarded.
    const repo = createRepo('clean');
    const hooks = gitPath(repo, 'hooks');
    try {
        const exclude = gitPath(repo, 'info/exclude');
        writeFileSync(exclude, readFileSync(exclude, 'utf8')
            .split('\n')
            .filter((line) => !line.startsWith('# >>> aimhooman managed excludes'))
            .join('\n'));
        chmodSync(hooks, 0o500);

        const uninstalled = run(repo, ['uninstall']);
        assert.equal(uninstalled.status, 30, uninstalled.stdout + uninstalled.stderr);
        assert.match(uninstalled.stderr, /NOT uninstalled; leaving dispatchers in place/);
        assert.match(uninstalled.stderr, /reference-transaction/);
        assert.match(uninstalled.stderr, /These still guard every commit/);
        // The excludes failure is reported beside the removal report, not instead
        // of it, and it still names what went wrong.
        assert.match(uninstalled.stderr, /exclude block left in/);
        assert.match(uninstalled.stderr, /markers are malformed/);
    } finally {
        chmodSync(hooks, 0o700);
        cleanup(repo);
    }
});

test('a non-regular exclude file still fails the uninstall loudly', {
    skip: process.platform === 'win32',
}, () => {
    // The excludes read is the enforcement point for the symlink guard. Catching
    // its throw must surface the message, never swallow it into a silent exit 0.
    const repo = createRepo('clean');
    try {
        const exclude = gitPath(repo, 'info/exclude');
        const elsewhere = join(repo.root, 'exclude-elsewhere');
        writeFileSync(elsewhere, '');
        rmSync(exclude);
        symlinkSync(elsewhere, exclude);

        const uninstalled = run(repo, ['uninstall']);
        assert.equal(uninstalled.status, 30, uninstalled.stdout + uninstalled.stderr);
        assert.match(uninstalled.stderr, /must be a regular file/);
    } finally {
        cleanup(repo);
    }
});

test('override list, replacement, removal, reset, and path normalization are stable', () => {
    const repo = createRepo('clean');
    try {
        let result = run(repo, ['allow', './nested/AGENTS.md', '--reason', 'team file']);
        assert.equal(result.status, 0, result.stderr);
        result = run(repo, ['override', 'list', '--json']);
        let overrides = jsonOutput(result);
        assert.equal(overrides.schema_version, 1);
        assert.deepEqual(overrides.allow.map((entry) => entry.target), ['nested/AGENTS.md']);
        assert.deepEqual(overrides.deny, []);

        result = run(repo, ['deny', './nested/AGENTS.md', '--reason', 'local file']);
        assert.equal(result.status, 0, result.stderr);
        overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.deepEqual(overrides.allow, []);
        assert.deepEqual(overrides.deny.map((entry) => entry.target), ['nested/AGENTS.md']);

        result = run(repo, ['allow', 'attribution.claude-coauthor']);
        assert.equal(result.status, 0, result.stderr);
        result = run(repo, ['override', 'remove', './nested/AGENTS.md']);
        assert.equal(result.status, 0, result.stderr);
        overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.deepEqual(overrides.allow.map((entry) => entry.target), ['attribution.claude-coauthor']);
        assert.deepEqual(overrides.deny, []);

        result = run(repo, ['deny', 'README.md']);
        assert.equal(result.status, 0, result.stderr);
        result = run(repo, ['override', 'reset', '--allow']);
        assert.equal(result.status, 0, result.stderr);
        overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.deepEqual(overrides.allow, []);
        assert.deepEqual(overrides.deny.map((entry) => entry.target), ['README.md']);

        result = run(repo, ['override', 'reset']);
        assert.equal(result.status, 0, result.stderr);
        overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.deepEqual(overrides.allow, []);
        assert.deepEqual(overrides.deny, []);

        result = run(repo, ['override', 'remove', 'missing']);
        assert.equal(result.status, 20);
        assert.match(result.stderr, /no override/);
    } finally {
        cleanup(repo);
    }
});

test('legacy override scopes are inferred and doctor compares effective scope', () => {
    const repo = createRepo('clean');
    const file = join(stateDir(repo), 'overrides.json');
    try {
        writeFileSync(file, JSON.stringify({
            allow: [{ target: 'generic.agent-instructions' }],
            deny: [],
        }));
        const replaced = run(repo, ['deny', 'generic.agent-instructions']);
        assert.equal(replaced.status, 0, replaced.stderr);
        let overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.deepEqual(overrides.allow, []);
        assert.equal(overrides.deny.length, 1);
        assert.equal(overrides.deny[0].scope, 'rule');

        writeFileSync(file, JSON.stringify({
            schema_version: 1,
            allow: [{ target: 'generic.agent-instructions', scope: 'rule' }],
            deny: [{ target: 'generic.agent-instructions', scope: 'path' }],
        }));
        const distinct = run(repo, ['doctor']);
        assert.equal(distinct.status, 0, distinct.stdout + distinct.stderr);

        writeFileSync(file, JSON.stringify({
            allow: [{ target: 'generic.agent-instructions' }],
            deny: [{ target: 'generic.agent-instructions', scope: 'rule' }],
        }));
        const conflict = run(repo, ['doctor']);
        assert.equal(conflict.status, 20, conflict.stdout + conflict.stderr);
        assert.match(conflict.stdout, /allow\/deny conflict "generic\.agent-instructions"/);
    } finally {
        cleanup(repo);
    }
});

test('instruction review acknowledgments are bound to both path and current HEAD', () => {
    const repo = createRepo('strict');
    try {
        writeFileSync(join(repo.root, 'AGENTS.md'), '# Shared instructions\n');
        git(repo, ['add', 'AGENTS.md']);
        const reviewed = run(repo, ['review', './AGENTS.md', '--head', 'HEAD', '--reason', 'maintainer review']);
        assert.equal(reviewed.status, 0, reviewed.stderr);

        let checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 0, checked.stderr);
        assert.deepEqual(jsonOutput(checked).findings, []);

        mkdirSync(join(repo.root, 'nested'));
        writeFileSync(join(repo.root, 'nested/AGENTS.md'), '# Different instructions\n');
        git(repo, ['add', 'nested/AGENTS.md']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        assert.deepEqual(
            jsonOutput(checked).findings.map((finding) => finding.path),
            ['nested/AGENTS.md'],
        );

        git(repo, ['reset', '-q']);
        writeFileSync(join(repo.root, 'next.txt'), 'advance HEAD\n');
        git(repo, ['add', 'next.txt']);
        git(repo, ['commit', '--no-verify', '-q', '-m', 'Advance fixture']);
        git(repo, ['add', 'AGENTS.md']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        assert.deepEqual(
            jsonOutput(checked).findings.map((finding) => finding.path),
            ['AGENTS.md'],
        );
    } finally {
        cleanup(repo);
    }
});

test('instruction review binds the exact staged blob and rejects absent, changed, copied, and conflicted targets', () => {
    const repo = createRepo('strict');
    try {
        let reviewed = run(repo, ['review', 'AGENTS.md', '--head', 'HEAD']);
        assert.equal(reviewed.status, 20, reviewed.stderr);
        assert.match(reviewed.stderr, /missing from the selected Git snapshot/);

        const original = '# Shared instructions\n';
        writeFileSync(join(repo.root, 'AGENTS.md'), original);
        git(repo, ['add', 'AGENTS.md']);
        const stagedOid = git(repo, ['rev-parse', ':AGENTS.md']);
        reviewed = run(repo, ['review', 'AGENTS.md', '--head', 'HEAD']);
        assert.equal(reviewed.status, 0, reviewed.stderr);
        const overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.ok(overrides.allow.some((entry) => (
            entry.target === 'AGENTS.md' && entry.newObjectId === stagedOid
        )));

        // An unstaged worktree edit does not change the immutable staged blob.
        writeFileSync(join(repo.root, 'AGENTS.md'), '# Worktree-only edit\n');
        let checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 0, checked.stderr);

        // Staging the edit changes the blob and invalidates the acknowledgment.
        git(repo, ['add', 'AGENTS.md']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);

        writeFileSync(join(repo.root, 'AGENTS.md'), original);
        git(repo, ['add', 'AGENTS.md']);
        mkdirSync(join(repo.root, 'nested'));
        writeFileSync(join(repo.root, 'nested/AGENTS.md'), original);
        git(repo, ['add', 'nested/AGENTS.md']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        assert.ok(jsonOutput(checked).findings.some((finding) => finding.path === 'nested/AGENTS.md'));

        git(repo, ['reset', '-q']);
        const hashBlob = (content) => execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repo.root,
            env: repo.env,
            input: content,
            encoding: 'utf8',
        }).trim();
        // Stage one is the exact blob already reviewed above. Even when that
        // path rule is suppressed, an unresolved index is never complete.
        const base = stagedOid;
        const ours = hashBlob('ours\n');
        const theirs = hashBlob('theirs\n');
        execFileSync('git', ['update-index', '--index-info'], {
            cwd: repo.root,
            env: repo.env,
            input: `100644 ${base} 1\tAGENTS.md\n100644 ${ours} 2\tAGENTS.md\n100644 ${theirs} 3\tAGENTS.md\n`,
        });
        reviewed = run(repo, ['review', 'AGENTS.md', '--head', 'HEAD']);
        assert.equal(reviewed.status, 30, reviewed.stderr);
        assert.match(reviewed.stderr, /unmerged|stage-zero/);

        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        let report = jsonOutput(checked);
        assert.equal(report.complete, false);
        assert.equal(report.stats.entries, 3);
        assert.ok(report.findings.some((finding) => (
            finding.ruleId === 'generic.agent-instructions' && finding.objectId === ours
        )));
        assert.match(checked.stderr, /all conflict stages were scanned/);

        const secret = hashBlob(`aws_secret_access_key = ${'a'.repeat(40)}\n`);
        execFileSync('git', ['update-index', '--index-info'], {
            cwd: repo.root,
            env: repo.env,
            input: `100644 ${base} 1\tAGENTS.md\n100644 ${ours} 2\tAGENTS.md\n100644 ${secret} 3\tAGENTS.md\n`,
        });
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        report = jsonOutput(checked);
        assert.equal(report.complete, false);
        assert.equal(report.stats.entries, 3);
        assert.ok(report.findings.some((finding) => (
            finding.objectId === secret && finding.matchedRuleIds.includes('secret.aws-key-content')
        )));
    } finally {
        cleanup(repo);
    }
});

test('instruction review records an exact staged tombstone for a deletion', () => {
    const repo = createRepo('strict');
    try {
        writeFileSync(join(repo.root, 'AGENTS.md'), '# tracked instructions\n');
        git(repo, ['add', 'AGENTS.md']);
        git(repo, [
            '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q',
            '-m', 'add instructions',
        ]);
        git(repo, ['rm', '-q', 'AGENTS.md']);

        let checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);

        const reviewed = run(repo, [
            'review', 'AGENTS.md', '--head', 'HEAD', '--reason', 'approved deletion',
        ]);
        assert.equal(reviewed.status, 0, reviewed.stderr);
        const overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        assert.ok(overrides.allow.some((entry) => (
            entry.target === 'AGENTS.md'
            && entry.scope === 'reviewed-instruction'
            && entry.transition === 'staged'
            && entry.newObjectId === null
        )));

        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 0, checked.stderr);
        assert.deepEqual(jsonOutput(checked).findings, []);
    } finally {
        cleanup(repo);
    }
});

test('instruction reviews reject symlinks and bind the regular-file mode', {
    skip: process.platform === 'win32',
}, () => {
    const repo = createRepo('strict');
    try {
        const target = join(repo.root, 'target.md');
        const instructions = join(repo.root, 'AGENTS.md');
        writeFileSync(target, '# linked instructions\n');
        symlinkSync('target.md', instructions);
        git(repo, ['add', 'target.md', 'AGENTS.md']);

        let reviewed = run(repo, ['review', 'AGENTS.md', '--head', 'HEAD']);
        assert.equal(reviewed.status, 20, reviewed.stderr);
        assert.match(reviewed.stderr, /regular-file|mode|symlink/i);
        let checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);

        // Changing the symlink target without changing the AGENTS index entry
        // must not make that symlink reviewable.
        writeFileSync(target, '# changed outside the protected path\n');
        reviewed = run(repo, ['review', 'AGENTS.md', '--head', 'HEAD']);
        assert.equal(reviewed.status, 20, reviewed.stderr);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);

        git(repo, ['reset', '-q']);
        rmSync(instructions);
        // A regular file can deliberately have the same blob bytes as the
        // symlink payload. The Git mode is what keeps those identities apart.
        writeFileSync(instructions, 'target.md');
        git(repo, ['add', 'AGENTS.md']);
        const regularOid = git(repo, ['rev-parse', ':AGENTS.md']);
        reviewed = run(repo, ['review', 'AGENTS.md', '--head', 'HEAD']);
        assert.equal(reviewed.status, 0, reviewed.stderr);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 0, checked.stderr);

        rmSync(instructions);
        symlinkSync('target.md', instructions);
        git(repo, ['add', 'AGENTS.md']);
        assert.equal(git(repo, ['rev-parse', ':AGENTS.md']), regularOid);
        assert.match(git(repo, ['ls-files', '--stage', '--', 'AGENTS.md']), /^120000 /);

        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        assert.ok(jsonOutput(checked).findings.some((finding) => (
            finding.ruleId === 'generic.agent-instructions'
        )));
    } finally {
        cleanup(repo);
    }
});

test('ordinary allow entries cannot approve a protected strict policy downgrade', () => {
    const repo = createRepo('clean');
    try {
        writePolicy(repo, 'strict');
        git(repo, ['add', '.aimhooman.json']);
        git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'Add strict policy']);
        writePolicy(repo, 'compliance');
        git(repo, ['add', '.aimhooman.json']);
        const allowed = run(repo, ['allow', '.aimhooman.json', '--reason', 'ordinary path allow']);
        assert.equal(allowed.status, 0, allowed.stderr);

        const checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        const report = jsonOutput(checked);
        assert.equal(report.profile, 'strict');
        assert.equal(report.policy_source, 'head-strict-floor');
        assert.ok(report.findings.some((finding) => finding.ruleId === 'generic.project-policy'));
    } finally {
        cleanup(repo);
    }
});

test('staged policy review is bound to head, transition, and policy object IDs', () => {
    const repo = createRepo('clean');
    try {
        writePolicy(repo, 'strict');
        git(repo, ['add', '.aimhooman.json']);
        git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'Add strict policy']);
        const reviewedHead = git(repo, ['rev-parse', 'HEAD']);
        const oldObject = git(repo, ['rev-parse', 'HEAD:.aimhooman.json']);

        writePolicy(repo, 'compliance');
        git(repo, ['add', '.aimhooman.json']);
        const newObject = git(repo, ['rev-parse', ':.aimhooman.json']);
        const reviewed = run(repo, [
            'policy-review', '--head', 'HEAD', '--staged',
            '--old', oldObject, '--new', newObject, '--reason', 'intentional migration',
        ]);
        assert.equal(reviewed.status, 0, reviewed.stderr);

        let checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 11, checked.stderr);
        let report = jsonOutput(checked);
        assert.equal(report.profile, 'compliance');
        assert.equal(report.policy_source, 'staged-policy');
        assert.ok(report.findings.every((finding) => finding.decision !== 'block'));

        const overrides = jsonOutput(run(repo, ['override', 'list', '--json']));
        const migration = overrides.allow.find((entry) => entry.scope === 'policy-migration');
        assert.equal(migration.head, reviewedHead);
        assert.equal(migration.transition, 'staged');
        assert.equal(migration.oldObjectId, oldObject);
        assert.equal(migration.newObjectId, newObject);
        assert.equal(migration.newMode, '100644');

        // A symlink can have the same blob object ID as the reviewed regular
        // policy. Its mode is part of the acknowledgment and policy parsing
        // rejects it before any local fallback can weaken enforcement.
        git(repo, ['update-index', '--cacheinfo', '120000', newObject, '.aimhooman.json']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.notEqual(checked.status, 0, checked.stderr);
        assert.match(checked.stderr, /regular Git file.*120000/);
        const precommit = run(repo, ['precommit']);
        assert.notEqual(precommit.status, 0, precommit.stderr);
        assert.match(precommit.stderr, /regular Git file.*120000/);
        // core.symlinks=false on Git for Windows preserves the existing 120000
        // index entry when the worktree contains the symlink payload as a plain
        // file. Restore the reviewed regular-file entry explicitly instead of
        // depending on checkout-platform symlink behavior.
        git(repo, ['update-index', '--cacheinfo', `100644,${newObject},.aimhooman.json`]);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 11, checked.stderr);

        const message = join(repo.root, 'reviewed-policy-message.txt');
        writeFileSync(message, 'Subject\n\nCo-authored-by: Claude <noreply@anthropic.com>\n');
        const messageCheck = run(repo, ['commitmsg', message]);
        assert.equal(messageCheck.status, 0, messageCheck.stderr);
        assert.match(readFileSync(message, 'utf8'), /Co-authored-by: Claude/);

        writePolicy(repo, 'clean');
        git(repo, ['add', '.aimhooman.json']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        report = jsonOutput(checked);
        assert.equal(report.profile, 'strict');
        assert.equal(report.policy_source, 'head-strict-floor');

        git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '.aimhooman.json']);
        writeFileSync(join(repo.root, 'advance.txt'), 'new head\n');
        git(repo, ['add', 'advance.txt']);
        git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'Advance strict baseline']);
        writePolicy(repo, 'clean');
        git(repo, ['add', '.aimhooman.json']);
        checked = run(repo, ['check', '--staged', '--json']);
        assert.equal(checked.status, 10, checked.stderr);
        report = jsonOutput(checked);
        assert.equal(report.profile, 'strict');
        assert.equal(report.policy_source, 'head-strict-floor');
    } finally {
        cleanup(repo);
    }
});

test('fix follows clean, compliance, and strict write policies', () => {
    const clean = createRepo('clean');
    const compliance = createRepo('compliance');
    const strict = createRepo('strict');
    try {
        const cleanMessage = join(clean.root, 'CLEAN_MESSAGE');
        writeFileSync(cleanMessage, ATTRIBUTION);
        let result = run(clean, ['fix', '--message', cleanMessage]);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(readFileSync(cleanMessage, 'utf8'), /Co-authored-by/);
        assert.equal(readFileSync(cleanMessage + '.aimhooman-bak', 'utf8'), ATTRIBUTION);

        const cleanApply = join(clean.root, 'CLEAN_APPLY_MESSAGE');
        writeFileSync(cleanApply, ATTRIBUTION);
        result = run(clean, ['fix', '--message', cleanApply, '--apply']);
        assert.equal(result.status, 20, result.stderr);
        assert.match(result.stderr, /--apply is only needed.*strict/);
        assert.equal(readFileSync(cleanApply, 'utf8'), ATTRIBUTION);
        assert.equal(existsSync(cleanApply + '.aimhooman-bak'), false);

        const complianceMessage = join(compliance.root, 'COMPLIANCE_MESSAGE');
        writeFileSync(complianceMessage, ATTRIBUTION);
        result = run(compliance, ['fix', '--message', complianceMessage]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /preserves attribution disclosures/);
        assert.equal(readFileSync(complianceMessage, 'utf8'), ATTRIBUTION);
        assert.equal(existsSync(complianceMessage + '.aimhooman-bak'), false);

        const strictMessage = join(strict.root, 'STRICT_MESSAGE');
        writeFileSync(strictMessage, ATTRIBUTION);
        result = run(strict, ['fix', '--message', strictMessage]);
        assert.equal(result.status, 11, result.stderr);
        assert.match(result.stderr, /rerun with --apply/);
        assert.equal(readFileSync(strictMessage, 'utf8'), ATTRIBUTION);
        assert.equal(existsSync(strictMessage + '.aimhooman-bak'), false);

        result = run(strict, ['fix', '--message', strictMessage, '--apply']);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(readFileSync(strictMessage, 'utf8'), /Co-authored-by/);
        assert.equal(readFileSync(strictMessage + '.aimhooman-bak', 'utf8'), ATTRIBUTION);
    } finally {
        cleanup(clean, compliance, strict);
    }
});

test('failed init restores hooks, state, excludes, content, and file modes', () => {
    const repo = createRepo();
    try {
        const hooks = gitPath(repo, 'hooks');
        const precommit = join(hooks, 'pre-commit');
        const commitmsg = join(hooks, 'commit-msg');
        const state = stateDir(repo);
        const config = join(state, 'config.json');
        const exclude = gitPath(repo, 'info/exclude');
        const foreignPrecommit = '#!/bin/sh\necho existing-precommit\n';
        const foreignCommitmsg = '#!/bin/sh\necho existing-commitmsg\n';
        const existingConfig = '{\n  "profile": "clean"\n}\n';
        const existingExclude = '# existing local exclude\n.cache/\n';

        mkdirSync(hooks, { recursive: true });
        mkdirSync(join(state, 'chained', 'commit-msg'), { recursive: true });
        writeFileSync(precommit, foreignPrecommit, { mode: 0o744 });
        writeFileSync(commitmsg, foreignCommitmsg, { mode: 0o754 });
        writeFileSync(config, existingConfig, { mode: 0o640 });
        mkdirSync(dirname(exclude), { recursive: true });
        writeFileSync(exclude, existingExclude, { mode: 0o644 });
        chmodSync(precommit, 0o744);
        chmodSync(commitmsg, 0o754);
        chmodSync(config, 0o640);

        const beforeModes = {
            precommit: statSync(precommit).mode & 0o777,
            commitmsg: statSync(commitmsg).mode & 0o777,
            config: statSync(config).mode & 0o777,
            exclude: statSync(exclude).mode & 0o777,
        };
        const result = run(repo, ['init', '--profile', 'strict']);
        assert.equal(result.status, 30, result.stderr);
        assert.match(result.stderr, /prior files were restored/);

        assert.equal(readFileSync(precommit, 'utf8'), foreignPrecommit);
        assert.equal(readFileSync(commitmsg, 'utf8'), foreignCommitmsg);
        assert.equal(readFileSync(config, 'utf8'), existingConfig);
        assert.equal(readFileSync(exclude, 'utf8'), existingExclude);
        assert.equal(statSync(precommit).mode & 0o777, beforeModes.precommit);
        assert.equal(statSync(commitmsg).mode & 0o777, beforeModes.commitmsg);
        assert.equal(statSync(config).mode & 0o777, beforeModes.config);
        assert.equal(statSync(exclude).mode & 0o777, beforeModes.exclude);
        assert.doesNotMatch(readFileSync(precommit, 'utf8'), /aimhooman-managed/);
        assert.doesNotMatch(readFileSync(commitmsg, 'utf8'), /aimhooman-managed/);
    } finally {
        cleanup(repo);
    }
});

test('repository lifecycle lock prevents overlapping init mutation', () => {
    const repo = createRepo();
    const lock = gitPath(repo, 'aimhooman-lifecycle.lock');
    try {
        writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live-test-holder' }));
        const initialized = run(repo, ['init', '--profile', 'strict']);
        assert.equal(initialized.status, 30, initialized.stderr);
        assert.match(initialized.stderr, /cannot acquire state lock/);
        assert.equal(existsSync(join(stateDir(repo), 'config.json')), false);
        assert.equal(existsSync(gitPath(repo, 'hooks/pre-commit')), false);
    } finally {
        rmSync(lock, { force: true });
        cleanup(repo);
    }
});

test('lifecycle queue serializes init/init, init/uninstall, and failed/successful init pairs', async (t) => {
    const candidateForPid = (lock, pid) => {
        try {
            for (const name of readdirSync(`${lock}.queue`)) {
                if (!name.endsWith('.json')) continue;
                try {
                    const candidate = JSON.parse(
                        readFileSync(join(`${lock}.queue`, name), 'utf8'),
                    );
                    if (candidate.pid === pid
                        && candidate.choosing === false
                        && Number.isSafeInteger(candidate.ticket)) return candidate;
                } catch {
                    // A candidate may be between its two atomic publications.
                }
            }
            return null;
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
    };
    const waitForCandidate = async (lock, child) => {
        // Wall-clock budget: child startup (Node boot + module load + ticket
        // publication) varies across Node versions and under CI load, so a fixed
        // poll count flakes on the slowest supported runner (Node 22.8.0).
        //
        // Stop as soon as the child exits: a candidate can only appear while it
        // is alive, so waiting out the budget after it is gone reports a bare
        // timeout that hides the real fault (a crash or an early error exit
        // looks exactly like a slow start). Report the child's fate instead.
        //
        // The poll must yield to the event loop: child.exitCode and the stderr
        // listeners are only updated while it runs, so a blocking wait would
        // pin both at their initial values and make every failure look alike.
        const deadline = Date.now() + 30000;
        const started = Date.now();
        let candidate = candidateForPid(lock, child.pid);
        while (!candidate && Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) {
                // Re-check once: the child may have published and exited between
                // the last poll and this liveness check.
                candidate = candidateForPid(lock, child.pid);
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            candidate = candidateForPid(lock, child.pid);
        }
        assert.ok(candidate, `no lifecycle candidate from PID ${child.pid} after ${Date.now() - started}ms `
            + `(exit=${child.exitCode} signal=${child.signalCode}); `
            + 'a candidate appears only while the process is alive, so a non-null exit here means it '
            + `failed before publishing its ticket. Child stderr: ${JSON.stringify(child.capturedStderr || '')}`);
        return candidate;
    };
    const holdLifecycle = (repo) => {
        const lock = gitPath(repo, 'aimhooman-lifecycle.lock');
        writeFileSync(lock, 'legacy holder\n');
        return lock;
    };
    // Keep every child's output on the process object so a failed wait can name
    // what the child said before it died, instead of only that it never showed up.
    const recordOutput = (child) => {
        child.capturedStderr = '';
        child.stderr.on('data', (chunk) => { child.capturedStderr += chunk; });
        return child;
    };
    const launch = (repo, args) => recordOutput(spawn(process.execPath, [CLI, ...args], {
        cwd: repo.root,
        env: repo.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const launchFixer = (repo, lock, exclude) => {
        const script = join(repo.home, 'fix-exclude.mjs');
        writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(new URL('../src/atomic-write.mjs', import.meta.url).href)};
const [lock, exclude] = process.argv.slice(2);
withLock(lock, () => writeFileSync(exclude, 'user pattern\\n'), { retries: 1000 });
`);
        return recordOutput(spawn(process.execPath, [script, lock, exclude], {
            cwd: repo.root,
            env: repo.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        }));
    };
    const outcome = (child) => new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const settleChildren = async (lock, children, outcomes) => {
        rmSync(lock, { force: true });
        for (const child of children.filter(Boolean)) {
            if (child.exitCode === null && child.signalCode === null) child.kill();
        }
        await Promise.allSettled(outcomes.filter(Boolean));
    };
    const assertInstalled = (repo, profile) => {
        assert.equal(JSON.parse(readFileSync(join(stateDir(repo), 'config.json'))).profile, profile);
        for (const name of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'reference-transaction']) {
            assert.equal(existsSync(gitPath(repo, `hooks/${name}`)), true, name);
        }
        assert.match(readFileSync(repo.excludeFile || gitPath(repo, 'info/exclude'), 'utf8'), /aimhooman managed excludes/);
    };

    await t.test('concurrent init/init leaves one coherent installed state', async () => {
        const repo = createRepo();
        const lock = holdLifecycle(repo);
        let first;
        let second;
        let firstOutcome;
        let secondOutcome;
        try {
            first = launch(repo, ['init', '--profile', 'strict']);
            firstOutcome = outcome(first);
            const firstCandidate = await waitForCandidate(lock, first);
            second = launch(repo, ['init', '--profile', 'strict']);
            secondOutcome = outcome(second);
            const secondCandidate = await waitForCandidate(lock, second);
            assert.ok(firstCandidate.ticket < secondCandidate.ticket);
            assert.ok(candidateForPid(lock, first.pid), 'first init must still be queued');
            assert.ok(candidateForPid(lock, second.pid), 'second init must still be queued');
            rmSync(lock, { force: true });
            const [a, b] = await Promise.all([firstOutcome, secondOutcome]);
            assert.equal(a.status, 0, a.stderr);
            assert.equal(b.status, 0, b.stderr);
            assertInstalled(repo, 'strict');
        } finally {
            await settleChildren(lock, [first, second], [firstOutcome, secondOutcome]);
            cleanup(repo);
        }
    });

    await t.test('concurrent init/uninstall leaves one coherent uninstalled state', async () => {
        const repo = createRepo();
        const lock = holdLifecycle(repo);
        let initializing;
        let uninstalling;
        let initOutcome;
        let uninstallOutcome;
        try {
            initializing = launch(repo, ['init', '--profile', 'clean']);
            initOutcome = outcome(initializing);
            const initCandidate = await waitForCandidate(lock, initializing);
            uninstalling = launch(repo, ['uninstall']);
            uninstallOutcome = outcome(uninstalling);
            const uninstallCandidate = await waitForCandidate(lock, uninstalling);
            assert.ok(initCandidate.ticket < uninstallCandidate.ticket);
            assert.ok(candidateForPid(lock, initializing.pid), 'init must still be queued');
            assert.ok(candidateForPid(lock, uninstalling.pid), 'uninstall must still be queued');
            rmSync(lock, { force: true });
            const [a, b] = await Promise.all([initOutcome, uninstallOutcome]);
            assert.equal(a.status, 0, a.stderr);
            assert.equal(b.status, 0, b.stderr);
            for (const name of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'reference-transaction']) {
                assert.equal(existsSync(gitPath(repo, `hooks/${name}`)), false, name);
            }
            assert.equal(JSON.parse(readFileSync(join(stateDir(repo), 'config.json'))).profile, 'clean');
            assert.doesNotMatch(readFileSync(gitPath(repo, 'info/exclude'), 'utf8'), /aimhooman managed excludes/);
        } finally {
            await settleChildren(
                lock,
                [initializing, uninstalling],
                [initOutcome, uninstallOutcome],
            );
            cleanup(repo);
        }
    });

    await t.test('failed init rolls back before a queued init succeeds', async () => {
        const repo = createRepo();
        const lock = holdLifecycle(repo);
        const exclude = gitPath(repo, 'info/exclude');
        let first;
        let fixer;
        let second;
        let firstOutcome;
        let fixerOutcome;
        let secondOutcome;
        try {
            mkdirSync(dirname(exclude), { recursive: true });
            writeFileSync(exclude, '# >>> aimhooman managed excludes (do not edit by hand)\nmissing end\n');
            first = launch(repo, ['init', '--profile', 'strict']);
            firstOutcome = outcome(first);
            const firstCandidate = await waitForCandidate(lock, first);
            fixer = launchFixer(repo, lock, exclude);
            fixerOutcome = outcome(fixer);
            const fixerCandidate = await waitForCandidate(lock, fixer);
            second = launch(repo, ['init', '--profile', 'strict']);
            secondOutcome = outcome(second);
            const secondCandidate = await waitForCandidate(lock, second);
            assert.ok(firstCandidate.ticket < fixerCandidate.ticket);
            assert.ok(fixerCandidate.ticket < secondCandidate.ticket);
            assert.ok(candidateForPid(lock, first.pid), 'failing init must still be queued');
            assert.ok(candidateForPid(lock, fixer.pid), 'fixer must still be queued');
            assert.ok(candidateForPid(lock, second.pid), 'second init must still be queued');
            rmSync(lock, { force: true });
            const [failed, fixed, succeeded] = await Promise.all([
                firstOutcome,
                fixerOutcome,
                secondOutcome,
            ]);
            assert.notEqual(failed.status, 0, failed.stderr);
            assert.doesNotMatch(failed.stderr, /cannot acquire state lock/);
            assert.match(failed.stderr, /initialisation failed and prior files were restored/);
            assert.equal(fixed.status, 0, fixed.stderr);
            assert.equal(succeeded.status, 0, succeeded.stderr);
            assertInstalled(repo, 'strict');
            assert.match(readFileSync(exclude, 'utf8'), /user pattern/);
        } finally {
            await settleChildren(
                lock,
                [first, fixer, second],
                [firstOutcome, fixerOutcome, secondOutcome],
            );
            cleanup(repo);
        }
    });
});

test('late init failure preserves an existing managed dispatcher and chained predecessor', () => {
    const repo = createRepo();
    try {
        const hooks = gitPath(repo, 'hooks');
        const precommit = join(hooks, 'pre-commit');
        const chained = join(stateDir(repo), 'chained', 'pre-commit');
        const config = join(stateDir(repo), 'config.json');
        const exclude = gitPath(repo, 'info/exclude');
        const foreign = '#!/bin/sh\nprintf foreign-hook\\n\n';
        writeFileSync(precommit, foreign, { mode: 0o741 });
        chmodSync(precommit, 0o741);

        const initialized = run(repo, ['init', '--profile', 'clean']);
        assert.equal(initialized.status, 0, initialized.stderr);
        assert.equal(readFileSync(chained, 'utf8'), foreign);
        // Windows does not expose POSIX chmod bits through stat. Content and
        // rollback identity remain testable there; exact mode preservation is a
        // POSIX filesystem contract.
        if (process.platform !== 'win32') assert.equal(statSync(chained).mode & 0o777, 0o741);

        const malformedExclude = '# >>> aimhooman managed excludes (do not edit by hand)\nmissing end marker\n';
        writeFileSync(exclude, malformedExclude, { mode: 0o640 });
        chmodSync(exclude, 0o640);
        const before = {
            dispatcher: readFileSync(precommit),
            dispatcherMode: statSync(precommit).mode & 0o777,
            chained: readFileSync(chained),
            chainedMode: statSync(chained).mode & 0o777,
            config: readFileSync(config),
            configMode: statSync(config).mode & 0o777,
            exclude: readFileSync(exclude),
            excludeMode: statSync(exclude).mode & 0o777,
        };

        const failed = run(repo, ['init', '--profile', 'strict']);
        assert.equal(failed.status, 30, failed.stderr);
        assert.match(failed.stderr, /prior files were restored/);
        assert.deepEqual(readFileSync(precommit), before.dispatcher);
        assert.equal(statSync(precommit).mode & 0o777, before.dispatcherMode);
        assert.deepEqual(readFileSync(chained), before.chained);
        assert.equal(statSync(chained).mode & 0o777, before.chainedMode);
        assert.deepEqual(readFileSync(config), before.config);
        assert.equal(statSync(config).mode & 0o777, before.configMode);
        assert.deepEqual(readFileSync(exclude), before.exclude);
        assert.equal(statSync(exclude).mode & 0o777, before.excludeMode);
    } finally {
        cleanup(repo);
    }
});

test('corrupt override state fails clearly at every enforcement entry point', async (t) => {
    const repo = createRepo('strict');
    const message = join(repo.root, 'COMMIT_MESSAGE');
    writeFileSync(message, 'Normal message\n');
    try {
        writeFileSync(join(stateDir(repo), 'overrides.json'), '{not valid json\n');
        const cases = [
            ['check', '--staged', '--json'],
            ['precommit'],
            ['commitmsg', message],
            ['status'],
            ['allow', 'README.md'],
            ['override', 'list'],
        ];
        for (const args of cases) {
            await t.test(args[0], () => {
                const result = run(repo, args);
                assert.equal(result.status, 20, `${args.join(' ')}\n${result.stderr}`);
                assert.match(result.stderr, /local overrides.*invalid JSON/i);
            });
        }

        const doctor = run(repo, ['doctor']);
        assert.equal(doctor.status, 20, doctor.stderr);
        assert.match(doctor.stdout, /x overrides:.*local overrides.*invalid JSON/i);
        assert.doesNotMatch(doctor.stdout, /aimhooman: healthy/);
    } finally {
        cleanup(repo);
    }
});

test('status and doctor print evidence for policy, hooks, rules, overrides, runtime, and state', () => {
    const repo = createRepo('strict');
    try {
        const status = run(repo, ['status']);
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /profile:\s+strict/);
        assert.match(status.stdout, /policy:\s+local \(local, object=none\)/);
        assert.match(status.stdout, /hook pre-commit: managed, executable, reachable/);
        assert.match(status.stdout, /hook pre-merge-commit: managed, executable, reachable/);
        assert.match(status.stdout, /hook commit-msg: managed, executable, reachable/);
        assert.match(status.stdout, /rules:\s+\d+ built-in/);
        assert.match(status.stdout, /overrides:\s+0 allow, 0 deny/);
        assert.match(status.stdout, /excludes:\s+current/);
        assert.match(status.stdout, /hooks path: local=unset, global=unset/);
        assert.match(status.stdout, /runtime:\s+Node \d+\.\d+\.\d+; git version/i);
        assert.match(status.stdout, new RegExp(`state:\\s+${escapeRegExp(resolve(stateDir(repo)))}`));

        const doctor = run(repo, ['doctor']);
        assert.equal(doctor.status, 0, doctor.stderr);
        assert.match(doctor.stdout, /ok policy loads \(worktree=strict\/local, staged=strict\/local, HEAD=strict\/local\)/);
        assert.match(doctor.stdout, /ok rule pack loads \(\d+ rules\)/);
        assert.match(doctor.stdout, /ok managed excludes are current/);
        assert.match(doctor.stdout, /ok overrides load \(0 allow, 0 deny\)/);
        assert.match(doctor.stdout, /ok pre-commit hook v\d+ is fingerprint-valid and reachable/);
        assert.match(doctor.stdout, /ok pre-merge-commit hook v\d+ is fingerprint-valid and reachable/);
        assert.match(doctor.stdout, /ok commit-msg hook v\d+ is fingerprint-valid and reachable/);
        assert.match(doctor.stdout, /ok host adapters present/);
        assert.match(doctor.stdout, /ok runtime Node \d+\.\d+\.\d+; git version/i);
        assert.match(doctor.stdout, new RegExp(`ok state directory ${escapeRegExp(resolve(stateDir(repo)))}`));
        assert.match(doctor.stdout, /aimhooman: healthy/);
    } finally {
        cleanup(repo);
    }
});

test('init requires Git 2.28 while accepting vendor suffixes, and doctor reports an old runtime', {
    skip: process.platform === 'win32',
}, () => {
    const oldRepo = createRepo();
    const supportedRepo = createRepo();
    try {
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const installFakeGit = (repo, version) => {
            const bin = join(repo.root, 'fake-bin');
            mkdirSync(bin, { recursive: true });
            const fake = join(bin, 'git');
            writeFileSync(
                fake,
                `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo ${JSON.stringify(version)}\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
                { mode: 0o755 },
            );
            chmodSync(fake, 0o755);
            repo.env = { ...repo.env, PATH: `${bin}:${repo.env.PATH}` };
        };

        installFakeGit(oldRepo, 'git version 2.27.9.vendor.4');
        let result = run(oldRepo, ['init', '--profile', 'strict']);
        assert.equal(result.status, 20, result.stderr);
        assert.match(result.stderr, /Git 2\.28\.0 or newer/);
        assert.equal(existsSync(join(stateDir(oldRepo), 'config.json')), false);
        assert.equal(existsSync(gitPath(oldRepo, 'hooks/pre-commit')), false);

        result = run(oldRepo, ['init', '--global', '--yes']);
        assert.equal(result.status, 20, result.stderr);
        const globalPath = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
            cwd: oldRepo.root,
            env: oldRepo.env,
            encoding: 'utf8',
        });
        assert.notEqual(globalPath.status, 0);

        installFakeGit(supportedRepo, 'git version 2.28.0.windows.1');
        result = run(supportedRepo, ['init', '--profile', 'strict']);
        assert.equal(result.status, 0, result.stderr);

        const fake = join(supportedRepo.root, 'fake-bin', 'git');
        writeFileSync(
            fake,
            `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "git version 2.27.0 (Vendor Git-99)"\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
            { mode: 0o755 },
        );
        chmodSync(fake, 0o755);
        result = run(supportedRepo, ['doctor']);
        assert.equal(result.status, 20, result.stderr);
        assert.match(result.stdout, /x runtime .*Git 2\.28\.0\+ required/);
    } finally {
        cleanup(oldRepo, supportedRepo);
    }
});

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
