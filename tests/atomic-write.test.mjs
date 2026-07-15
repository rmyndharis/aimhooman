import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, withLock } from '../src/atomic-write.mjs';

test('atomicWrite preserves the original and removes its temp after ENOSPC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-atomic-enospc-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, 'original\n');
    try {
        assert.throws(
            () => atomicWrite(file, 'replacement\n', {
                operations: {
                    write() {
                        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
                    },
                },
            }),
            (error) => error.code === 'ENOSPC',
        );
        assert.equal(readFileSync(file, 'utf8'), 'original\n');
        assert.deepEqual(readdirSync(dir), ['state.json']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('atomicWrite preserves the original and removes its temp after EXDEV rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-atomic-exdev-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, 'original\n');
    try {
        assert.throws(
            () => atomicWrite(file, 'replacement\n', {
                operations: {
                    rename() {
                        throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
                    },
                },
            }),
            (error) => error.code === 'EXDEV',
        );
        assert.equal(readFileSync(file, 'utf8'), 'original\n');
        assert.deepEqual(readdirSync(dir), ['state.json']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('atomicWrite reports indeterminate durability when directory fsync fails after rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-atomic-dir-sync-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, 'original\n');
    try {
        assert.throws(
            () => atomicWrite(file, 'replacement\n', {
                operations: {
                    syncDirectory() {
                        throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' });
                    },
                },
            }),
            (error) => (
                /durability is uncertain/.test(error.message)
                && error.cause?.code === 'EIO'
            ),
        );
        assert.equal(readFileSync(file, 'utf8'), 'replacement\n');
        assert.deepEqual(readdirSync(dir), ['state.json']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a stale lock whose PID was reused does not count as a live owner', {
    skip: process.platform === 'win32',
}, () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-pid-reuse-lock-'));
    const lock = join(dir, 'state.lock');
    const queue = `${lock}.queue`;
    const token = '12345678-1234-4123-8123-123456789abc';
    try {
        mkdirSync(queue);
        writeFileSync(join(queue, `${token}.json`), JSON.stringify({
            version: 1,
            pid: process.pid,
            token,
            processIdentity: 'definitely-not-this-process-start',
            choosing: false,
            ticket: 1,
        }));
        assert.equal(withLock(lock, () => 'acquired', {
            retries: 3,
            staleMs: 0,
            retryDelayMs: 1,
        }), 'acquired');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('lock release only removes its own never-reused candidate path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-replacement-'));
    const lock = join(dir, 'state.lock');
    const replacement = '12345678-1234-4123-8123-123456789abc';
    try {
        withLock(lock, () => {
            writeFileSync(join(`${lock}.queue`, `${replacement}.json`), JSON.stringify({
                version: 1,
                pid: process.pid,
                token: replacement,
                processIdentity: null,
                choosing: false,
                ticket: 2,
            }));
        });
        assert.equal(
            JSON.parse(readFileSync(join(`${lock}.queue`, `${replacement}.json`), 'utf8')).token,
            replacement,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('lock release reports filesystem failures and preserves a primary callback error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-release-fault-'));
    const lock = join(dir, 'state.lock');
    const releaseError = Object.assign(new Error('cannot unlink candidate'), { code: 'EACCES' });
    try {
        assert.throws(
            () => withLock(lock, () => 'completed', {
                unlinkCandidate() { throw releaseError; },
            }),
            (error) => error === releaseError,
        );
        assert.equal(readdirSync(`${lock}.queue`).filter((name) => name.endsWith('.json')).length, 1);

        rmSync(`${lock}.queue`, { recursive: true, force: true });
        const primary = new Error('callback failed');
        assert.throws(
            () => withLock(lock, () => { throw primary; }, {
                unlinkCandidate() { throw releaseError; },
            }),
            (error) => (
                error instanceof AggregateError
                && error.cause === primary
                && error.errors[0] === primary
                && error.errors[1] === releaseError
            ),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('first candidate publication cleans up after post-rename directory fsync failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-publish-fault-'));
    const lock = join(dir, 'state.lock');
    try {
        assert.throws(
            () => withLock(lock, () => 'must not enter', {
                candidateOperations: {
                    syncDirectory() {
                        throw Object.assign(new Error('queue directory I/O failure'), { code: 'EIO' });
                    },
                },
            }),
            /durability is uncertain/,
        );
        assert.deepEqual(
            readdirSync(`${lock}.queue`).filter((name) => name.endsWith('.json')),
            [],
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('two bakery contenders never overlap their critical sections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-contenders-'));
    const lock = join(dir, 'state.lock');
    const active = join(dir, 'active');
    const entered = join(dir, 'entered');
    const firstHeld = join(dir, 'first-held');
    const script = `
import { appendFileSync, closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(new URL('../src/atomic-write.mjs', import.meta.url).href)};
const [lock, active, entered, firstHeld, id] = process.argv.slice(1);
withLock(lock, () => {
  const descriptor = openSync(active, 'wx');
  appendFileSync(entered, id);
  if (id === 'A') writeFileSync(firstHeld, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, id === 'A' ? 150 : 10);
  closeSync(descriptor);
  rmSync(active);
}, { retries: 500, retryDelayMs: 2, staleMs: 0 });
`;
    const launch = (id) => spawn(process.execPath, [
        '--input-type=module', '-e', script, lock, active, entered, firstHeld, id,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = (child) => new Promise((resolve) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stderr }));
    });
    try {
        const first = launch('A');
        for (let attempt = 0; attempt < 200 && !existsSync(firstHeld); attempt += 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        assert.equal(existsSync(firstHeld), true);
        const second = launch('B');
        const [firstResult, secondResult] = await Promise.all([result(first), result(second)]);
        assert.equal(firstResult.code, 0, firstResult.stderr);
        assert.equal(secondResult.code, 0, secondResult.stderr);
        assert.equal(readFileSync(entered, 'utf8'), 'AB');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a crashed contender is removed only at its unique candidate path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-crash-'));
    const lock = join(dir, 'state.lock');
    const held = join(dir, 'held');
    const script = `
import { writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(new URL('../src/atomic-write.mjs', import.meta.url).href)};
const [lock, held] = process.argv.slice(1);
withLock(lock, () => {
  writeFileSync(held, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
});
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock, held], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        for (let attempt = 0; attempt < 200 && !existsSync(held); attempt += 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        assert.equal(existsSync(held), true);
        child.kill('SIGKILL');
        await new Promise((resolve) => child.on('close', resolve));
        assert.equal(withLock(lock, () => 'recovered', {
            retries: 10,
            retryDelayMs: 1,
            staleMs: 0,
        }), 'recovered');
    } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
    }
});
