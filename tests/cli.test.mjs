import test from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, truncateSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'bin/aimhooman.mjs');

function makeRepo(profile) {
    const dir = mkdtempSync(join(tmpdir(), 'aim-cli-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'x');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    execFileSync('node', [CLI, 'init', '--profile', profile], { cwd: dir });
    return dir;
}

function run(cmd, args, cwd) {
    try { return execFileSync('node', [CLI, cmd, ...args], { cwd, encoding: 'utf8' }); }
    catch (e) { return { code: e.status, stderr: e.stderr }; }
}

function result(cmd, args, cwd, input) {
    return spawnSync('node', [CLI, cmd, ...args], { cwd, input, encoding: 'utf8' });
}

function globalFixtureEnv(home) {
    return {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: join(home, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
    };
}

test('help lists command aliases and mutually exclusive lifecycle forms', () => {
    const help = result('--help', [], process.cwd());
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /aimhooman audit\|scan/);
    assert.match(help.stdout, /fix .*--apply \(strict only\)/);
    assert.match(help.stdout, /uninstall \[--purge-state\]\n\s+aimhooman uninstall --global/);
    assert.doesNotMatch(help.stdout, /uninstall[^\n]*--purge-state[^\n]*--global/);
});

test('refcheck accepts Git 2.54 preparing phase without running the prepared scan', () => {
    const preparing = result('refcheck', ['preparing'], process.cwd(), 'malformed ref input\n');
    assert.equal(preparing.status, 0, preparing.stderr);
    assert.equal(preparing.stdout, '');
    assert.equal(preparing.stderr, '');

    const invalid = result('refcheck', ['prepare'], process.cwd(), '');
    assert.equal(invalid.status, 20, invalid.stderr);
    assert.match(invalid.stderr, /must be preparing, prepared, committed, or aborted/);
});

test('precommit: clean unstages AI artifact and exits 0', () => {
    const dir = makeRepo('clean');
    try {
        mkdirSync(join(dir, '.playwright-mcp'));
        writeFileSync(join(dir, '.playwright-mcp/trace.json'), '{}');
        execFileSync('git', ['add', '-f', '.playwright-mcp/trace.json'], { cwd: dir });
        const out = run('precommit', [], dir);
        assert.equal(out.code, undefined); // exit 0 has no .status
        // still staged? it should have been unstaged
        const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim();
        assert.equal(staged, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit: clean omits the empty-commit hint when other files remain staged', () => {
    const dir = makeRepo('clean');
    try {
        mkdirSync(join(dir, '.playwright-mcp'));
        writeFileSync(join(dir, '.playwright-mcp/trace.json'), '{}');
        execFileSync('git', ['add', '-f', '.playwright-mcp/trace.json'], { cwd: dir });
        writeFileSync(join(dir, 'feature.txt'), 'safe\n');
        execFileSync('git', ['add', 'feature.txt'], { cwd: dir });

        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        // The artifact is unstaged, the real feature work stays staged, and the
        // empty-commit hint is absent because feature.txt remains in the commit.
        const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        assert.equal(staged, 'feature.txt');
        assert.doesNotMatch(out.stderr, /commit will be empty/);
        assert.doesNotMatch(out.stderr, /nothing else staged/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit: a zero-similarity blocked rename restores the possible source deletion', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, 'old.txt'), 'tracked');
        execFileSync('git', ['add', 'old.txt'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'add old file'], { cwd: dir });
        unlinkSync(join(dir, 'old.txt'));
        execFileSync('git', ['add', '-u'], { cwd: dir });
        mkdirSync(join(dir, '.playwright-mcp'));
        writeFileSync(join(dir, '.playwright-mcp/trace.json'), '{}');
        execFileSync('git', ['add', '-f', '.playwright-mcp/trace.json'], { cwd: dir });

        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stderr, /commit will be empty/);
        const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        assert.equal(staged, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit: strict blocks and exits 10', () => {
    const dir = makeRepo('strict');
    try {
        mkdirSync(join(dir, '.playwright-mcp'));
        writeFileSync(join(dir, '.playwright-mcp/trace.json'), '{}');
        execFileSync('git', ['add', '-f', '.playwright-mcp/trace.json'], { cwd: dir });
        const out = run('precommit', [], dir);
        assert.equal(out.code, 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit: clean fails closed when a known secret cannot be unstaged', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.env'), 'SECRET=x');
        execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
        writeFileSync(join(dir, '.git/index.lock'), 'held');
        const out = result('precommit', [], dir);
        assert.equal(out.status, 10);
        assert.match(out.stderr, /commit stopped; repair the index and retry/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit: clean stops when a non-secret artifact cannot be unstaged', () => {
    const dir = makeRepo('clean');
    try {
        mkdirSync(join(dir, '.playwright-mcp'), { recursive: true });
        writeFileSync(join(dir, '.playwright-mcp', 'trace.json'), '{}');
        execFileSync('git', ['add', '-f', '.playwright-mcp/trace.json'], { cwd: dir });
        writeFileSync(join(dir, '.git/index.lock'), 'held');
        const out = result('precommit', [], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.match(out.stderr, /commit stopped; repair the index and retry/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit: malformed local profile config fails closed', () => {
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, '.git/aimhooman/config.json'), '{bad');
        writeFileSync(join(dir, 'README.md'), 'changed');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        const out = result('precommit', [], dir);
        assert.equal(out.status, 20, out.stderr);
        assert.match(out.stderr, /local config/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: clean strips AI attribution and exits 0', () => {
    const dir = makeRepo('clean');
    try {
        const msg = join(dir, 'MSG');
        writeFileSync(msg, 'Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\n');
        const out = run('commitmsg', [msg], dir);
        assert.equal(out.code, undefined);
        assert.doesNotMatch(readFileSync(msg, 'utf8'), /anthropic/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: clean leaves an unterminated exact attribution unchanged and stops', () => {
    const dir = makeRepo('clean');
    try {
        const msg = join(dir, 'MSG');
        const original = Buffer.from('Fix\n\nGenerated by ChatGPT');
        writeFileSync(msg, original);
        const out = result('commitmsg', [msg], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.match(out.stderr, /attribution\.generated-with/);
        assert.deepEqual(readFileSync(msg), original);
        assert.equal(existsSync(msg + '.aimhooman-bak'), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: an unsafe non-UTF-8 repair is rejected without changing any byte', () => {
    const dir = makeRepo('clean');
    try {
        const msg = join(dir, 'MSG');
        const original = Buffer.concat([
            Buffer.from('Subject '),
            Buffer.from([0xff]),
            Buffer.from('\n\nCo-authored-by: Claude <noreply@anthropic.com>\n'),
        ]);
        writeFileSync(msg, original);
        const out = result('commitmsg', [msg], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.match(out.stderr, /not valid UTF-8/);
        assert.deepEqual(readFileSync(msg), original);
        assert.equal(existsSync(msg + '.aimhooman-bak'), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: compliance keeps AI attribution', () => {
    const dir = makeRepo('compliance');
    try {
        const msg = join(dir, 'MSG');
        writeFileSync(msg, 'Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\n');
        run('commitmsg', [msg], dir);
        assert.match(readFileSync(msg, 'utf8'), /Co-authored-by: Claude/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: strict blocks and exits 10', () => {
    const dir = makeRepo('strict');
    try {
        const msg = join(dir, 'MSG');
        writeFileSync(msg, 'Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\n');
        const out = run('commitmsg', [msg], dir);
        assert.equal(out.code, 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init: a tracked hooks directory is refused with the reason, not a bare failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-cli-tracked-hooks-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        mkdirSync(join(dir, '.husky'), { recursive: true });
        writeFileSync(join(dir, '.husky/pre-commit'), '#!/bin/sh\necho team\n');
        execFileSync('git', ['add', '-A'], { cwd: dir });
        execFileSync('git', ['commit', '-q', '-m', 'hooks'], { cwd: dir });
        execFileSync('git', ['config', '--local', 'core.hooksPath', '.husky'], { cwd: dir });

        const out = result('init', [], dir);
        assert.notEqual(out.status, 0, 'init must not claim success without an active guard');
        assert.match(out.stderr, /tracked by this repository/, out.stderr);
        assert.match(out.stderr, /core\.hooksPath/, out.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: allow override preserves matching attribution', () => {
    const dir = makeRepo('clean');
    try {
        execFileSync('node', [CLI, 'allow', 'attribution.claude-coauthor', '--reason', 'team policy'], { cwd: dir });
        const msg = join(dir, 'MSG');
        writeFileSync(msg, 'Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\n');
        const out = result('commitmsg', [msg], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.match(readFileSync(msg, 'utf8'), /Co-authored-by: Claude/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: review-only local rule is reported without modifying the message', () => {
    const dir = makeRepo('clean');
    try {
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(join(dir, '.git/aimhooman/rules/message.json'), JSON.stringify([{
            id: 'local.message-review', version: 1, provider: 'local', category: 'review', kind: 'message',
            match: { content: ['REVIEW-ME'] },
            actions: { clean: 'review', strict: 'review', compliance: 'review' },
            reason: 'manual review required',
        }]));
        const msg = join(dir, 'MSG');
        writeFileSync(msg, 'Fix\n\nREVIEW-ME\n');
        const out = result('commitmsg', [msg], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stderr, /REVIEW/);
        assert.match(readFileSync(msg, 'utf8'), /REVIEW-ME/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: non-repairable local blocks remain visible without changing the message', () => {
    const dir = makeRepo('clean');
    try {
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(join(dir, '.git/aimhooman/rules/message.json'), JSON.stringify([{
            id: 'local.message-block', version: 1, provider: 'local', category: 'custom', kind: 'message',
            match: { content: ['KEEP-VISIBLE'] },
            actions: { clean: 'block', strict: 'block', compliance: 'block' },
            reason: 'local message policy matched',
        }]));
        const msg = join(dir, 'MSG');
        writeFileSync(msg, 'Fix\n\nKEEP-VISIBLE\n');
        const out = result('commitmsg', [msg], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.match(out.stderr, /local\.message-block/);
        assert.equal(readFileSync(msg, 'utf8'), 'Fix\n\nKEEP-VISIBLE\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmsg: strict fails closed (exit 31) when a local message rule cannot evaluate an oversized line', () => {
    const dir = makeRepo('strict');
    try {
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(join(dir, '.git/aimhooman/rules/message.json'), JSON.stringify([{
            id: 'local.message-marker', version: 1, provider: 'local', category: 'custom', kind: 'message',
            match: { content: ['LOCAL-MARKER'] },
            actions: { clean: 'block', strict: 'block', compliance: 'block' },
            reason: 'local message marker',
        }]));
        const msg = join(dir, 'MSG');
        // A single line beyond the local-match input limit cannot be evaluated by
        // the local rule, so the scan is incomplete; strict must fail closed.
        writeFileSync(msg, `subject\n\n${'x'.repeat(20000)} LOCAL-MARKER\n`);
        const out = result('commitmsg', [msg], dir);
        assert.equal(out.status, 31, out.stderr);
        assert.match(out.stderr, /scan incomplete/i);
        assert.match(out.stderr, /local-input-limit/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fix: strict fails closed (exit 31) when a local message rule cannot evaluate an oversized line', () => {
    const dir = makeRepo('strict');
    try {
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(join(dir, '.git/aimhooman/rules/message.json'), JSON.stringify([{
            id: 'local.message-marker', version: 1, provider: 'local', category: 'custom', kind: 'message',
            match: { content: ['LOCAL-MARKER'] },
            actions: { clean: 'block', strict: 'block', compliance: 'block' },
            reason: 'local message marker',
        }]));
        const msg = join(dir, 'MSG');
        writeFileSync(msg, `subject\n\n${'x'.repeat(20000)} LOCAL-MARKER\n`);
        const out = result('fix', ['--message', msg], dir);
        assert.equal(out.status, 31, out.stderr);
        assert.match(out.stderr, /scan incomplete/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict staged check catches rename destination', () => {
    const dir = makeRepo('strict');
    try {
        execFileSync('git', ['mv', 'README.md', '.env'], { cwd: dir });
        const out = result('check', ['--staged', '--json'], dir);
        assert.equal(out.status, 10);
        const report = JSON.parse(out.stdout);
        assert.equal(report.findings[0]?.path, '.env');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict staged checks keep instruction deletion and rename source review-required', () => {
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, 'CLAUDE.md'), '# shared instructions\n');
        execFileSync('git', ['add', 'CLAUDE.md'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'add instructions'], { cwd: dir });

        execFileSync('git', ['rm', '-q', 'CLAUDE.md'], { cwd: dir });
        let out = result('check', ['--staged', '--json'], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.ok(JSON.parse(out.stdout).findings.some((finding) => finding.path === 'CLAUDE.md'));

        execFileSync('git', ['restore', '--staged', '--worktree', 'CLAUDE.md'], { cwd: dir });
        execFileSync('git', ['mv', 'CLAUDE.md', 'team-notes.md'], { cwd: dir });
        out = result('check', ['--staged', '--json'], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.ok(JSON.parse(out.stdout).findings.some((finding) => (
            finding.path === 'CLAUDE.md' && finding.status === 'R'
        )));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clean precommit fully unstages a blocked rename', () => {
    const dir = makeRepo('clean');
    try {
        execFileSync('git', ['config', 'diff.renames', 'false'], { cwd: dir });
        execFileSync('git', ['mv', 'README.md', '.env'], { cwd: dir });
        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stderr, /unstaged 1 AI artifact/);
        const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        assert.equal(staged, '');
        assert.match(out.stderr, /commit will be empty/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clean precommit preserves both index sides of a renamed file with secret content', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, 'old.txt'), 'safe\n');
        execFileSync('git', ['add', 'old.txt'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'add source'], { cwd: dir });
        execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: dir });
        writeFileSync(join(dir, 'new.txt'), 'safe\n-----BEGIN ' + 'PRIVATE KEY-----\nsecret\n');
        execFileSync('git', ['add', 'new.txt'], { cwd: dir });
        const worktreeBytes = readFileSync(join(dir, 'new.txt'));
        const headBytes = execFileSync('git', ['show', 'HEAD:old.txt'], { cwd: dir });

        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.equal(
            execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim(),
            '',
        );
        assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8').includes('PRIVATE KEY'), true);
        assert.deepEqual(readFileSync(join(dir, 'new.txt')), worktreeBytes);
        assert.deepEqual(execFileSync('git', ['show', 'HEAD:old.txt'], { cwd: dir }), headBytes);
        assert.equal(existsSync(join(dir, 'old.txt')), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict staged check flags a secret renamed to a neutral path', () => {
    // Path-only secrets (e.g. .env) are detected by filename. A `git mv` to a
    // neutral name must not smuggle them past the destination scan, which only
    // catches content-shaped secrets. The finding is reported on the destination
    // (where the bytes now live) with the rename source preserved.
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, '.env'), 'DB_PASSWORD=hunter2\n');
        execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'track env'], { cwd: dir });
        execFileSync('git', ['mv', '.env', 'config'], { cwd: dir });

        const out = result('check', ['--staged', '--json'], dir);
        assert.equal(out.status, 10, out.stderr);
        const findings = JSON.parse(out.stdout).findings;
        assert.ok(findings.some((finding) => (
            finding.ruleId === 'secret.dotenv'
            && finding.decision === 'block'
            && finding.path === 'config'
            && finding.status === 'R'
            && finding.sourcePath === '.env'
        )), `expected a reattributed rename-secret finding, got ${JSON.stringify(findings)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clean precommit removes a secret renamed to a neutral path', () => {
    // The finding must point at the destination so clean repair unstages the blob
    // carrying the secret. A source-path finding would unstage the old name and
    // leave the secret staged under the new one.
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.env'), 'DB_PASSWORD=hunter2\n');
        execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'track env'], { cwd: dir });
        execFileSync('git', ['mv', '.env', 'config'], { cwd: dir });

        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        const staged = execFileSync('git', ['diff', '--cached', '--name-status'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        assert.equal(staged, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleting a secret path is not itself a finding', () => {
    // Removing a forbidden path is hygiene, not a violation: the delete branch of
    // the rename/delete review scan must keep suppressing secret findings.
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, '.env'), 'DB_PASSWORD=hunter2\n');
        execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'track env'], { cwd: dir });
        execFileSync('git', ['rm', '-q', '.env'], { cwd: dir });

        const out = result('check', ['--staged', '--json'], dir);
        assert.equal(out.status, 0, out.stderr);
        const findings = JSON.parse(out.stdout).findings;
        assert.ok(!findings.some((finding) => finding.matchedRuleIds?.includes('secret.dotenv')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('staged check safely skips oversized files instead of hitting child-process maxBuffer', () => {
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, 'large.txt'), '');
        truncateSync(join(dir, 'large.txt'), 65 * 1024 * 1024);
        execFileSync('git', ['add', 'large.txt'], { cwd: dir });
        const out = result('check', ['--staged', '--json'], dir);
        assert.equal(out.status, 31, out.stderr);
        const report = JSON.parse(out.stdout);
        assert.equal(report.complete, false);
        assert.equal(report.stats.skipped['size-limit'], 1);
        assert.deepEqual(report.findings, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit fails closed on incomplete scans in clean and compliance profiles', () => {
    for (const profile of ['clean', 'compliance']) {
        const dir = makeRepo(profile);
        try {
            writeFileSync(join(dir, 'large.txt'), '');
            truncateSync(join(dir, 'large.txt'), 3 * 1024 * 1024);
            execFileSync('git', ['add', 'large.txt'], { cwd: dir });
            const out = result('precommit', [], dir);
            assert.equal(out.status, 31, `${profile}: ${out.stderr}`);
            assert.match(out.stderr, /scan incomplete/i);
            assert.equal(
                execFileSync('git', ['diff', '--cached', '--name-only'], {
                    cwd: dir,
                    encoding: 'utf8',
                }).trim(),
                'large.txt',
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('staged and tracked scans skip gitlink content without losing path checks', () => {
    const dir = makeRepo('strict');
    try {
        const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${oid},vendor/submodule`], { cwd: dir });
        const staged = result('check', ['--staged', '--json'], dir);
        assert.equal(staged.status, 0, staged.stderr);
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'gitlink'], { cwd: dir });
        const audit = result('audit', ['--json'], dir);
        assert.equal(audit.status, 0, audit.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit scans secrets from every unresolved conflict stage', () => {
    const dir = makeRepo('clean');
    try {
        const main = execFileSync(
            'git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' },
        ).trim();
        writeFileSync(join(dir, 'conflict.txt'), 'base\n');
        execFileSync('git', ['add', 'conflict.txt'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'conflict base'], { cwd: dir });

        execFileSync('git', ['checkout', '-q', '-b', 'secret-side'], { cwd: dir });
        writeFileSync(
            join(dir, 'conflict.txt'),
            '-----BEGIN ' + 'PRIVATE KEY-----\nsecret\n',
        );
        execFileSync('git', ['add', 'conflict.txt'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'secret side'], { cwd: dir });

        execFileSync('git', ['checkout', '-q', main], { cwd: dir });
        writeFileSync(join(dir, 'conflict.txt'), 'safe side\n');
        execFileSync('git', ['add', 'conflict.txt'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'safe side'], { cwd: dir });
        const merge = spawnSync('git', ['merge', 'secret-side'], { cwd: dir, encoding: 'utf8' });
        assert.equal(merge.status, 1);

        const audit = result('audit', ['--json'], dir);
        assert.equal(audit.status, 10, audit.stderr);
        const report = JSON.parse(audit.stdout);
        assert.equal(report.complete, false);
        assert.match(audit.stderr, /no single staged snapshot exists/);
        assert.ok(report.findings.some((finding) => (
            finding.path === 'conflict.txt'
            && finding.ruleId === 'secret.private-key-content'
        )));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('range and audit targets catch a violation already committed with hooks bypassed', () => {
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, 'safe-name'), 'secret');
        execFileSync('git', ['add', 'safe-name'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync('git', ['mv', 'safe-name', '.env'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'rename'], { cwd: dir });

        const range = result('check', ['--range', 'HEAD~1..HEAD', '--json'], dir);
        assert.equal(range.status, 10, range.stderr);
        assert.equal(JSON.parse(range.stdout).findings[0]?.path, '.env');

        const audit = result('audit', ['--json'], dir);
        assert.equal(audit.status, 10, audit.stderr);
        assert.equal(JSON.parse(audit.stdout).target, 'tracked');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict agent guard denies --no-verify before a combined add and commit', () => {
    const dir = makeRepo('strict');
    try {
        const payload = JSON.stringify({
            cwd: dir,
            tool_name: 'Bash',
            tool_input: { command: 'git add -A && git commit --no-verify -m leak' },
        });
        const out = result('hook', ['pre-tool-use'], dir, payload);
        assert.equal(out.status, 0, out.stderr);
        const decision = JSON.parse(out.stdout);
        assert.equal(decision.permissionDecision, 'deny');
        assert.match(decision.permissionDecisionReason, /forbids bypassing repository policy hooks/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hook command exits 20 on an unsupported event', () => {
    // The hook subcommand validates its event before loading the parser module
    // or touching a repository, so an unsupported event fails fast with a usage
    // error rather than proceeding to the agent guard.
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-'));
    try {
        const out = result('hook', ['bogus-event'], dir);
        assert.equal(out.status, 20, out.stderr);
        assert.match(out.stderr, /hook requires exactly one supported event/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean allows a benign non-git pipeline and denies a pipe to a shell', () => {
    const dir = makeRepo('clean');
    try {
        const benign = result('hook', ['pre-tool-use'], dir, JSON.stringify({
            cwd: dir,
            tool_name: 'Bash',
            tool_input: { command: 'gh issue view 747 --comments 2>&1 | tail -60' },
        }));
        assert.equal(benign.status, 0, benign.stderr);
        assert.doesNotMatch(benign.stdout, /"deny"/);

        const danger = result('hook', ['pre-tool-use'], dir, JSON.stringify({
            cwd: dir,
            tool_name: 'Bash',
            tool_input: { command: 'cat script.sh | bash' },
        }));
        const decision = JSON.parse(danger.stdout).hookSpecificOutput?.permissionDecision;
        assert.equal(decision, 'deny', danger.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict agent guard recognizes bundled -n and core.hooksPath overrides', () => {
    const dir = makeRepo('strict');
    try {
        for (const command of [
            'git commit -an -m leak',
            'git -c core.hooksPath=/dev/null commit -m leak',
            'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m leak',
            'env GIT_CONFIG_PARAMETERS=core.hooksPath=/dev/null git commit -m leak',
            'GIT_CONFIG_GLOBAL=/tmp/evil.cfg git commit -m leak',
            'git -c include.path=/tmp/evil.cfg commit -m leak',
        ]) {
            const payload = JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command } });
            const out = result('hook', ['pre-tool-use'], dir, payload);
            assert.equal(out.status, 0, out.stderr);
            assert.equal(JSON.parse(out.stdout).permissionDecision, 'deny', command);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agent guard evaluates git -C against the target repository policy', () => {
    const source = makeRepo('clean');
    const target = makeRepo('strict');
    try {
        for (const command of [
            `git -C "${target}" commit --no-verify -m leak`,
            `cd "${target}" && git commit --no-verify -m leak`,
            `env -C "${target}" git commit --no-verify -m leak`,
            `env --chdir="${target}" git commit --no-verify -m leak`,
            `sudo git -C "${target}" commit --no-verify -m leak`,
            `x=git; $x -C "${target}" commit --no-verify -m leak`,
            `(cd "${target}" && git commit --no-verify -m leak)`,
            `bash -lc 'cd "${target}" && git commit --no-verify -m leak'`,
        ]) {
            const payload = JSON.stringify({ cwd: source, tool_name: 'Bash', tool_input: { command } });
            const out = result('hook', ['pre-tool-use'], source, payload);
            assert.equal(out.status, 0, out.stderr);
            assert.equal(JSON.parse(out.stdout).permissionDecision, 'deny', command);
        }
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
    }
});

test('strict agent guard denies combined add and commit when no Git guard is installed', () => {
    const dir = makeRepo('strict');
    try {
        execFileSync('node', [CLI, 'uninstall'], { cwd: dir });
        const payload = JSON.stringify({
            cwd: dir,
            tool_name: 'Bash',
            tool_input: { command: 'git add -A && git commit -m combined' },
        });
        const out = result('hook', ['pre-tool-use'], dir, payload);
        assert.equal(out.status, 0, out.stderr);
        const decision = JSON.parse(out.stdout);
        assert.equal(decision.permissionDecision, 'deny');
        assert.match(decision.permissionDecisionReason, /managed.*guards|guards.*unavailable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clean skips a malformed local rule pack without cancelling precommit', () => {
    const dir = makeRepo('clean');
    try {
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(join(dir, '.git/aimhooman/rules/broken.json'), 'not-json');
        writeFileSync(join(dir, 'normal.txt'), 'x');
        execFileSync('git', ['add', 'normal.txt'], { cwd: dir });
        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stderr, /pack skipped/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict fails closed on a malformed local rule pack', () => {
    const dir = makeRepo('strict');
    try {
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(join(dir, '.git/aimhooman/rules/broken.json'), 'not-json');
        writeFileSync(join(dir, 'normal.txt'), 'x');
        execFileSync('git', ['add', 'normal.txt'], { cwd: dir });
        const out = result('precommit', [], dir);
        assert.equal(out.status, 20, out.stderr);
        assert.match(out.stderr, /rule pack|cannot scan/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clean precommit reports review-required paths without blocking', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, 'AGENTS.md'), '# team policy\n');
        execFileSync('git', ['add', 'AGENTS.md'], { cwd: dir });
        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stderr, /REVIEW/);
        assert.match(out.stderr, /AGENTS\.md/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI override scopes block new paths and require an explicit secret-path allow', () => {
    const dir = makeRepo('strict');
    try {
        writeFileSync(join(dir, 'blocked.txt'), 'ordinary content\n');
        execFileSync('git', ['add', 'blocked.txt'], { cwd: dir });
        assert.equal(result('deny', ['blocked.txt'], dir).status, 0);
        let checked = result('check', ['--staged', '--json'], dir);
        assert.equal(checked.status, 10, checked.stderr);
        assert.equal(JSON.parse(checked.stdout).findings[0]?.ruleId, 'override.path-deny');

        execFileSync('git', ['reset', '-q'], { cwd: dir });
        writeFileSync(join(dir, '.env'), 'SECRET=value\n');
        execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
        // A bare allow of a secret-matching path used to report success yet
        // leave the block in place; it now fails closed and directs to the
        // explicit secret-path scope (a local override must not hide a key).
        const bareAllow = result('allow', ['.env'], dir);
        assert.equal(bareAllow.status, 20, bareAllow.stderr);
        assert.match(bareAllow.stderr, /matches a secret rule/);
        assert.match(bareAllow.stderr, /--scope secret-path/);
        checked = result('check', ['--staged', '--json'], dir);
        assert.equal(checked.status, 10, checked.stderr);
        assert.equal(JSON.parse(checked.stdout).findings[0]?.ruleId, 'secret.dotenv');

        assert.equal(result('allow', ['.env', '--scope', 'secret-path'], dir).status, 0);
        checked = result('check', ['--staged', '--json'], dir);
        assert.equal(checked.status, 0, checked.stderr);
        assert.deepEqual(JSON.parse(checked.stdout).findings, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects a rule-scope allow for a secret rule and directs to secret-path', () => {
    const dir = makeRepo('clean');
    try {
        const denied = result('allow', ['secret.dotenv'], dir);
        assert.equal(denied.status, 20, denied.stderr);
        assert.match(denied.stderr, /secret rules cannot be allowed at --scope rule/);
        assert.match(denied.stderr, /--scope secret-path/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('check rejects missing target values instead of silently scanning staged content', () => {
    const dir = makeRepo('clean');
    try {
        const out = result('check', ['--range'], dir);
        assert.equal(out.status, 20);
        assert.match(out.stderr, /missing value/);
        const swallowed = result('check', ['--commit', '--json'], dir);
        assert.equal(swallowed.status, 20);
        assert.match(swallowed.stderr, /missing value/);
        const singleRevision = result('check', ['--range', 'HEAD'], dir);
        assert.equal(singleRevision.status, 20);
        assert.match(singleRevision.stderr, /both endpoints/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('versioned project policy overrides the per-clone profile', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        writeFileSync(join(dir, '.env'), 'SECRET=x');
        execFileSync('git', ['add', '-f', '.aimhooman.json', '.env'], { cwd: dir });
        const guard = result('precommit', [], dir);
        assert.equal(guard.status, 10, guard.stderr);
        const weakened = result('check', ['--staged', '--profile', 'clean'], dir);
        assert.equal(weakened.status, 20);
        assert.match(weakened.stderr, /cannot lower target profile "strict"/);
        const status = result('status', [], dir);
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /profile:\s+strict/);
        assert.match(status.stdout, /policy:\s+project/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unstaged malformed worktree policy does not replace the staged target policy', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), '{bad json');
        const out = result('precommit', [], dir);
        assert.equal(out.status, 0, out.stderr);
        const status = result('status', [], dir);
        assert.equal(status.status, 20);
        assert.match(status.stderr, /cannot load enforcement state/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a committed strict project policy cannot silently downgrade itself', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'strict baseline'], { cwd: dir });

        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('node', [CLI, 'allow', '.aimhooman.json', '--reason', 'reviewed'], { cwd: dir });
        const out = result('precommit', [], dir);
        assert.equal(out.status, 10, out.stderr);
        assert.match(out.stderr, /generic\.project-policy/);
        const payload = JSON.stringify({
            cwd: dir,
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m downgrade' },
        });
        const agent = result('hook', ['pre-tool-use'], dir, payload);
        assert.equal(agent.status, 0, agent.stderr);
        assert.equal(JSON.parse(agent.stdout).permissionDecision, 'deny');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precommit validates staged policy content rather than only the working copy', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), '{bad staged json');
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        const out = result('precommit', [], dir);
        assert.equal(out.status, 20);
        assert.match(out.stderr, /staged:\.aimhooman\.json/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed committed policy remains fail-closed even with a valid working copy', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), '{bad committed json');
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'bad baseline'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        const guard = result('precommit', [], dir);
        assert.equal(guard.status, 20);
        assert.match(guard.stderr, /staged:\.aimhooman\.json/);

        const payload = JSON.stringify({
            cwd: dir,
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m bypass' },
        });
        const agent = result('hook', ['pre-tool-use'], dir, payload);
        assert.equal(agent.status, 0, agent.stderr);
        assert.equal(JSON.parse(agent.stdout).permissionDecision, 'deny');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('range scan inherits a strict base policy and catches its deletion', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'strict baseline'], { cwd: dir });
        execFileSync('git', ['rm', '-q', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'delete policy'], { cwd: dir });
        execFileSync('node', [CLI, 'allow', '.aimhooman.json', '--reason', 'reviewed'], { cwd: dir });
        const out = result('check', ['--range', 'HEAD~1..HEAD', '--json'], dir);
        assert.equal(out.status, 10, out.stderr);
        const report = JSON.parse(out.stdout);
        assert.equal(report.policy_source, 'parent-strict-floor');
        assert.equal(report.findings[0]?.ruleId, 'generic.project-policy');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict range scan accepts an explicitly reviewed initial project policy', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'add team policy'], { cwd: dir });
        execFileSync('node', [CLI, 'allow', '.aimhooman.json', '--reason', 'CODEOWNERS reviewed'], { cwd: dir });
        const out = result('check', ['--range', 'HEAD~1..HEAD', '--profile', 'strict', '--json'], dir);
        assert.equal(out.status, 0, out.stderr);
        assert.deepEqual(JSON.parse(out.stdout).findings, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict policy rename-away is protected in precommit and range scans', () => {
    const dir = makeRepo('clean');
    try {
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'strict baseline'], { cwd: dir });
        execFileSync('git', ['mv', '.aimhooman.json', 'policy.old'], { cwd: dir });
        execFileSync('node', [CLI, 'allow', '.aimhooman.json', '--reason', 'reviewed'], { cwd: dir });
        const guard = result('precommit', [], dir);
        assert.equal(guard.status, 10, guard.stderr);
        assert.match(guard.stderr, /generic\.project-policy/);
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'rename policy'], { cwd: dir });
        const range = result('check', ['--range', 'HEAD~1..HEAD', '--json'], dir);
        assert.equal(range.status, 10, range.stderr);
        assert.equal(JSON.parse(range.stdout).findings[0]?.path, '.aimhooman.json');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status: reports local rule packs alongside built-in', () => {
    const dir = makeRepo('clean');
    try {
        let out = run('status', [], dir);
        assert.match(out, /built-in/);
        assert.doesNotMatch(out, /rules:.*local/);
        mkdirSync(join(dir, '.git/aimhooman/rules'), { recursive: true });
        writeFileSync(
            join(dir, '.git/aimhooman/rules/extra.json'),
            '[{"id":"local.test","version":1,"provider":"local","category":"custom","kind":"path","match":{"paths":["**/test-local"]},"actions":{"clean":"review"},"reason":"test"}]'
        );
        out = run('status', [], dir);
        assert.match(out, /\+ 1 local/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor rejects a partial hook installation including a missing merge guard', () => {
    const dir = makeRepo('clean');
    try {
        const hooks = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
            cwd: dir, encoding: 'utf8',
        }).trim();
        unlinkSync(join(hooks, 'pre-merge-commit'));
        const out = result('doctor', [], dir);
        assert.equal(out.status, 20);
        assert.match(out.stdout, /hooks incomplete/);
        assert.match(out.stdout, /pre-merge-commit/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init --global sets core.hooksPath and installs dispatchers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glb-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        const confirmation = spawnSync('node', [CLI, 'init', '--global'], {
            cwd: dir, env, encoding: 'utf8',
        });
        assert.equal(confirmation.status, 20);
        assert.match(confirmation.stderr, /rerun with --yes/);
        execFileSync('node', [CLI, 'init', '--global', '--yes'], { cwd: dir, env });
        const hp = execFileSync('git', ['config', '--global', 'core.hooksPath'], {
            env, encoding: 'utf8',
        }).trim();
        assert.ok(hp.length > 0);
        assert.ok(existsSync(hp + '/pre-commit'));
        assert.ok(existsSync(hp + '/pre-merge-commit'));
        assert.ok(existsSync(hp + '/commit-msg'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('global reference dispatcher stays transparent in unsupported bare repositories', () => {
    const source = mkdtempSync(join(tmpdir(), 'aim-global-bare-source-'));
    const bare = mkdtempSync(join(tmpdir(), 'aim-global-bare-target-'));
    const home = mkdtempSync(join(tmpdir(), 'aim-global-bare-home-'));
    const env = globalFixtureEnv(home);
    try {
        execFileSync('git', ['init', '-q'], { cwd: source, env });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: source, env });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: source, env });
        writeFileSync(join(source, 'README.md'), 'safe bare push\n');
        execFileSync('git', ['add', 'README.md'], { cwd: source, env });
        execFileSync('git', ['commit', '-q', '-m', 'safe source'], { cwd: source, env });
        execFileSync('git', ['init', '--bare', '-q'], { cwd: bare, env });
        execFileSync('node', [CLI, 'init', '--global', '--yes'], { cwd: source, env });

        const pushed = spawnSync(
            'git',
            ['push', bare, 'HEAD:refs/heads/main'],
            { cwd: source, env, encoding: 'utf8' },
        );
        assert.equal(pushed.status, 0, pushed.stderr);
        assert.equal(
            execFileSync('git', ['rev-parse', 'refs/heads/main'], {
                cwd: bare,
                env,
                encoding: 'utf8',
            }).trim(),
            execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: source,
                env,
                encoding: 'utf8',
            }).trim(),
        );
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(bare, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('init --global refuses when core.hooksPath is already set elsewhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glb-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        // pre-existing foreign hooksPath (e.g. husky/lefthook) must be preserved
        execFileSync('git', ['config', '--global', 'core.hooksPath', '/some/husky/dir'], { env });
        const out = spawnSync('node', [CLI, 'init', '--global', '--yes'], {
            cwd: dir, env, encoding: 'utf8',
        });
        assert.equal(out.status, 20);
        assert.match(out.stderr, /refusing to overwrite/);
        // the foreign value is UNCHANGED
        const hp = execFileSync('git', ['config', '--global', 'core.hooksPath'], {
            env, encoding: 'utf8',
        }).trim();
        assert.equal(hp, '/some/husky/dir');
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('init --global refuses symlink hook destinations without changing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glb-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        const hooks = join(home, '.aimhooman/hooks');
        mkdirSync(hooks, { recursive: true });
        const target = join(home, 'foreign-hook');
        writeFileSync(target, '#!/bin/sh\necho foreign\n');
        symlinkSync(target, join(hooks, 'pre-commit'));
        const out = spawnSync('node', [CLI, 'init', '--global', '--yes'], { cwd: dir, env, encoding: 'utf8' });
        assert.equal(out.status, 20);
        assert.match(out.stderr, /symlink/);
        assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\necho foreign\n');
        const configured = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { env });
        assert.notEqual(configured.status, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('init --global refuses to overwrite a foreign regular hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glb-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        const hooks = join(home, '.aimhooman/hooks');
        mkdirSync(hooks, { recursive: true });
        const foreign = '#!/bin/sh\necho foreign\n';
        writeFileSync(join(hooks, 'pre-commit'), foreign);
        const out = spawnSync('node', [CLI, 'init', '--global', '--yes'], { cwd: dir, env, encoding: 'utf8' });
        assert.equal(out.status, 20);
        assert.match(out.stderr, /not managed by aimhooman/);
        assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), foreign);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('local init fails when a shared foreign hooksPath has no aimhooman guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-shared-'));
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir, env });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, env });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, env });
        const shared = join(home, 'foreign-hooks');
        mkdirSync(shared);
        execFileSync('git', ['config', '--global', 'core.hooksPath', shared], { env });
        const out = spawnSync('node', [CLI, 'init', '--profile', 'strict'], { cwd: dir, env, encoding: 'utf8' });
        assert.equal(out.status, 20);
        assert.match(out.stderr, /repository guard is not active/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('uninstall --global unsets core.hooksPath and removes dispatchers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glb-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        execFileSync('node', [CLI, 'init', '--global', '--yes'], { cwd: dir, env });
        const hp = execFileSync('git', ['config', '--global', 'core.hooksPath'], {
            env, encoding: 'utf8',
        }).trim();
        assert.ok(existsSync(hp + '/pre-commit'));
        assert.ok(existsSync(hp + '/pre-merge-commit'));
        assert.ok(existsSync(hp + '/commit-msg'));
        execFileSync('node', [CLI, 'uninstall', '--global'], { cwd: dir, env });
        // core.hooksPath now unset -> `git config --get` exits non-zero
        let stillSet = true;
        try {
            execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { env, encoding: 'utf8' });
        } catch { stillSet = false; }
        assert.equal(stillSet, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('uninstall --global preserves a core.hooksPath changed after installation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glb-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        execFileSync('node', [CLI, 'init', '--global', '--yes'], { cwd: dir, env });
        execFileSync('git', ['config', '--global', 'core.hooksPath', '/foreign/hooks'], { env });
        const out = spawnSync('node', [CLI, 'uninstall', '--global'], { cwd: dir, env, encoding: 'utf8' });
        assert.equal(out.status, 0, out.stderr);
        const kept = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { env, encoding: 'utf8' }).trim();
        assert.equal(kept, '/foreign/hooks');
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});

test('local uninstall warns when an inherited global core.hooksPath remains active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-glbwarn-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'aim-home-'));
    const env = globalFixtureEnv(home);
    try {
        execFileSync('node', [CLI, 'init', '--global', '--yes'], { cwd: dir, env });

        const out = spawnSync('node', [CLI, 'uninstall'], { cwd: dir, env, encoding: 'utf8' });
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /global Git guard is still active/);
        assert.match(out.stdout, /uninstall --global/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    }
});
