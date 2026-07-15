import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { defaultPatterns, applyExclude, inspectExclude, removeExclude } from '../src/exclude.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('defaultPatterns is derived from unambiguous AI residue rules', () => {
    for (const p of [
        '.claude.json',
        '.claude/projects/**',
        '.codex/logs/**',
        '.copilot/**',
        '.cursor/chats/**',
        '.aider.*',
        '.continue/sessions/**',
        '.playwright-mcp/**',
        '.remember/**',
        '.superpowers/**',
        '.agent/**',
    ]) {
        assert.ok(defaultPatterns().some((x) => x.startsWith(p)), `missing ${p}`);
    }
    // Review-required files and secrets stay visible in git status.
    assert.equal(defaultPatterns().some((x) => x.includes('.env')), false);
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
        for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
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
