import test from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { defaultPatterns, applyExclude, inspectExclude, patternsForRules, removeExclude } from '../src/exclude.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('defaultPatterns is derived from unambiguous AI residue rules', () => {
    for (const p of [
        '.claude.json',
        '.claude/projects/**',
        '.codex/logs/**',
        '.copilot/**',
        '.cursor/chats/**',
        '.claude/worktrees/**',
        '.aider.chat.history.md',
        '.aider.tags.cache.v*/**',
        '.continue/sessions/**',
        '.playwright-mcp/**',
        '.remember/**',
        '.superpowers/**',
    ]) {
        assert.ok(defaultPatterns().some((x) => x.startsWith(p)), `missing ${p}`);
    }
    // Project config these tools read must stay visible to git status.
    for (const p of ['.aider.*', '.agent/**']) {
        assert.equal(defaultPatterns().includes(p), false, `${p} would hide project config`);
    }
    // Review-required files stay visible in git status, and .env was never in
    // the auto-exclude set: it was enforced by content and path scanning until
    // that left the product in v0.3.0, and auto-exclude stays artifact-only.
    assert.equal(defaultPatterns().some((x) => x.includes('.env')), false);
});

test('a rule exception re-includes its paths after every exclude line', () => {
    // SpecStory keeps project config beside its history. Git applies the last
    // matching line, so the `!` lines must follow every exclude.
    const patterns = defaultPatterns();
    const firstNegation = patterns.findIndex((p) => p.startsWith('!'));
    assert.ok(firstNegation > patterns.indexOf('.specstory/**'), 'history is excluded first');
    assert.ok(patterns.slice(firstNegation).every((p) => p.startsWith('!')));
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-except-'));
    try {
        execFileSync('git', ['init', '-q', dir]);
        applyExclude(join(dir, '.git', 'info', 'exclude'), patterns);
        for (const path of [
            '.specstory/history/s.md', '.specstory/statistics.json', 'pkg/.specstory/history/s.md',
            '.specstory/cli/config.toml', '.specstory/cli/sub/x.toml', '.specstory/.project.json',
            'pkg/.specstory/cli/config.toml',
        ]) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), 'x\n');
        }
        const ignored = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], {
            cwd: dir, encoding: 'utf8',
        }).trim().split('\n').sort();
        assert.deepEqual(ignored, [
            '.specstory/history/s.md', '.specstory/statistics.json', 'pkg/.specstory/history/s.md',
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A `!` line reaches the whole exclude file. One that reaches outside its own
// rule's directory would show another rule's artifacts again.
test('an exception reaching outside its rule keeps that rule out of the block', () => {
    const rule = (paths, except) => ({
        kind: 'path',
        category: 'ephemeral-state',
        actions: { clean: 'block', strict: 'block', compliance: 'block' },
        match: { paths, except },
    });
    assert.deepEqual(patternsForRules([rule(['scratch/**'], ['**/*.md'])]), []);
    assert.deepEqual(
        patternsForRules([rule(['**/.x/**'], ['**/.x/keep/**'])]),
        ['**/.x/**', '!**/.x/keep/', '!**/.x/keep/**'],
    );
});

test('applyExclude writes a managed block and preserves user lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-'));
    const file = join(dir, 'exclude');
    writeFileSync(file, 'my-own-pattern\n');
    applyExclude(file, defaultPatterns());
    assert.deepEqual(inspectExclude(file, defaultPatterns()), { installed: true, current: true, missing: [] });
    const out = readFileSync(file, 'utf8');
    assert.match(out, /my-own-pattern/);
    assert.match(out, />>> aimhooman managed excludes/);
    assert.match(out, /\.playwright-mcp\//);
    removeExclude(file);
    const after = readFileSync(file, 'utf8');
    assert.match(after, /my-own-pattern/);
    assert.doesNotMatch(after, /aimhooman managed/);
    assert.equal(inspectExclude(file, defaultPatterns()).installed, false);
    rmSync(dir, { recursive: true, force: true });
});

test('refreshing the managed block keeps user lines on their side of it', () => {
    // Git applies the last matching line, so a `!` negation only works below
    // the pattern it overrides. A refresh must not move the block past it.
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-order-'));
    const file = join(dir, 'exclude');
    try {
        writeFileSync(file, 'user-before\n');
        applyExclude(file, ['.one/**']);
        writeFileSync(file, `${readFileSync(file, 'utf8')}!.one/keep.md\n`);
        applyExclude(file, ['.one/**', '.two/**']);

        const once = readFileSync(file, 'utf8');
        const lines = once.split('\n');
        assert.ok(lines.indexOf('user-before') < lines.indexOf('.one/**'), once);
        assert.ok(lines.indexOf('!.one/keep.md') > lines.indexOf('.two/**'), once);
        assert.deepEqual(inspectExclude(file, ['.one/**', '.two/**']), {
            installed: true,
            current: true,
            missing: [],
        });
        applyExclude(file, ['.one/**', '.two/**']);
        assert.equal(readFileSync(file, 'utf8'), once, 'a refresh with the same patterns changes nothing');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('malformed managed markers fail without changing user excludes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-malformed-'));
    const file = join(dir, 'exclude');
    try {
        for (const original of [
            'keep-me\n# >>> aimhooman managed excludes (do not edit by hand)\nlater-user-line\n',
            'keep-me\n# <<< aimhooman managed excludes\nlater-user-line\n',
        ]) {
            writeFileSync(file, original);
            assert.throws(() => applyExclude(file, defaultPatterns()), /markers are malformed/);
            assert.equal(readFileSync(file, 'utf8'), original);
            assert.throws(() => removeExclude(file), /markers are malformed/);
            assert.equal(readFileSync(file, 'utf8'), original);
            assert.throws(() => inspectExclude(file, defaultPatterns()), /markers are malformed/);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('ownership-marker patterns equal to BEGIN/END are rejected as injection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-markers-'));
    const file = join(dir, 'exclude');
    try {
        writeFileSync(file, 'user-line\n');
        // A local rule whose path equals a managed-block marker would forge or
        // duplicate the ownership markers; validatePatterns (in the write path)
        // must reject it. inspectExclude does not write, so only applyExclude
        // enforces this.
        for (const marker of [
            '# >>> aimhooman managed excludes (do not edit by hand)',
            '# <<< aimhooman managed excludes',
        ]) {
            assert.throws(() => applyExclude(file, [marker]), /single-line/);
        }
        assert.equal(readFileSync(file, 'utf8'), 'user-line\n');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('read errors and non-regular exclude paths are not treated as empty files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-read-'));
    const directoryPath = join(dir, 'exclude-directory');
    const target = join(dir, 'target');
    const link = join(dir, 'exclude-link');
    try {
        mkdirSync(directoryPath);
        writeFileSync(target, 'keep-me\n');
        const paths = [directoryPath];
        if (process.platform !== 'win32') {
            symlinkSync(target, link);
            paths.push(link);
        }
        for (const file of paths) {
            assert.throws(() => applyExclude(file, defaultPatterns()), /regular file|EISDIR/);
            assert.throws(() => removeExclude(file), /regular file|EISDIR/);
            assert.throws(() => inspectExclude(file, defaultPatterns()), /regular file|EISDIR/);
        }
        assert.equal(readFileSync(target, 'utf8'), 'keep-me\n');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exclude patterns cannot inject extra lines or ownership markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-pattern-'));
    const file = join(dir, 'exclude');
    try {
        assert.throws(() => applyExclude(file, ['safe/**\n*.pem']), /single-line/);
        assert.equal(inspectExclude(file, defaultPatterns()).installed, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exclude refresh waits for the file lock and preserves a concurrent user edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-ex-lock-'));
    const file = join(dir, 'exclude');
    const marker = join(dir, 'held');
    const lock = `${file}.aimhooman.lock`;
    const childScript = `
import { writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(new URL('../src/atomic-write.mjs', import.meta.url).href)};
const [lock, file, marker] = process.argv.slice(1);
withLock(lock, () => {
  writeFileSync(marker, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  writeFileSync(file, 'user-added-during-refresh\\n');
});
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, lock, file, marker], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !existsSync(marker)) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        assert.equal(existsSync(marker), true);
        applyExclude(file, ['.agent/**']);
        const exit = await new Promise((resolve) => child.on('close', resolve));
        assert.equal(exit, 0);
        const content = readFileSync(file, 'utf8');
        assert.match(content, /user-added-during-refresh/);
        assert.deepEqual(inspectExclude(file, ['.agent/**']), {
            installed: true,
            current: true,
            missing: [],
        });
    } finally {
        if (child.exitCode === null) child.kill();
        rmSync(dir, { recursive: true, force: true });
    }
});
