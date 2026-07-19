import test from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    LocalConfigError,
    LocalOverridesError,
    loadConfig,
    loadOverrides,
    loadProjectPolicy,
    normalizeOverrideTarget,
    ProjectPolicyError,
    saveConfig,
    saveOverrides,
} from '../src/state.mjs';

test('versioned project policy takes precedence over per-clone profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-policy-'));
    const state = join(root, '.git', 'aimhooman');
    try {
        mkdirSync(state, { recursive: true });
        saveConfig(state, { profile: 'clean' });
        writeFileSync(join(root, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        assert.deepEqual(loadProjectPolicy(root).profile, 'strict');
        assert.equal(loadConfig(state, root).profile, 'strict');
        assert.equal(loadConfig(state, root).source, 'project');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('invalid versioned project policy is an actionable error', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-policy-'));
    try {
        writeFileSync(join(root, '.aimhooman.json'), '{"schema_version":1,"profile":"nope"}');
        assert.throws(() => loadConfig(join(root, '.git/aimhooman'), root), ProjectPolicyError);
        writeFileSync(join(root, '.aimhooman.json'), '{"schema_version":1,"profile":"clean","extra":true}');
        assert.throws(() => loadConfig(join(root, '.git/aimhooman'), root), /unsupported field: extra/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('missing local config defaults clean but malformed local config fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-local-config-'));
    const state = join(root, 'state');
    try {
        assert.deepEqual(loadConfig(state), { profile: 'clean', source: 'default' });
        mkdirSync(state);
        writeFileSync(join(state, 'config.json'), JSON.stringify({ profile: 'clean' }));
        assert.equal(loadConfig(state).profile, 'clean');
        saveConfig(state, { profile: 'clean' });
        assert.equal(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).schema_version, 1);
        writeFileSync(join(state, 'config.json'), '{bad');
        assert.throws(() => loadConfig(state), LocalConfigError);
        writeFileSync(join(state, 'config.json'), JSON.stringify({ profile: 'unknown' }));
        assert.throws(() => loadConfig(state), /profile must be clean, strict, or compliance/);
        writeFileSync(join(state, 'config.json'), JSON.stringify({ profile: 'clean', extra: true }));
        assert.throws(() => loadConfig(state), /unsupported field: extra/);
        writeFileSync(join(state, 'config.json'), JSON.stringify({ schema_version: 2, profile: 'clean' }));
        assert.throws(() => loadConfig(state), /schema_version must be 1/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the gitignore opt-in round-trips and validates its shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-gitignore-config-'));
    const state = join(root, 'state');
    const file = join(state, 'config.json');
    try {
        saveConfig(state, { profile: 'clean', gitignore: { enabled: true, created: true } });
        assert.deepEqual(loadConfig(state).gitignore, { enabled: true, created: true });
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).gitignore, { enabled: true, created: true });

        // A disabled record normalizes away: absent and disabled are one spelling.
        saveConfig(state, { profile: 'clean', gitignore: { enabled: false, created: false } });
        assert.equal(loadConfig(state).gitignore, undefined);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).gitignore, undefined);
        saveConfig(state, { profile: 'clean' });
        assert.equal(loadConfig(state).gitignore, undefined);

        for (const [value, pattern] of [
            [true, /gitignore must be an object/],
            [{}, /gitignore\.enabled must be a boolean/],
            [{ enabled: true }, /gitignore\.created must be a boolean/],
            [{ enabled: true, created: false, extra: 1 }, /gitignore has unsupported field: extra/],
        ]) {
            writeFileSync(file, JSON.stringify({ profile: 'clean', gitignore: value }));
            assert.throws(() => loadConfig(state), pattern, JSON.stringify(value));
            assert.throws(() => saveConfig(state, { profile: 'clean', gitignore: value }), pattern);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('missing overrides are empty but corrupt or unreadable overrides are errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-overrides-'));
    const state = join(root, 'state');
    try {
        mkdirSync(state);
        assert.deepEqual(loadOverrides(join(root, 'missing')), { allow: [], deny: [] });
        writeFileSync(join(state, 'overrides.json'), '{bad');
        assert.throws(() => loadOverrides(state), LocalOverridesError);
        writeFileSync(join(state, 'overrides.json'), JSON.stringify({
            allow: 'not-an-array',
            deny: [null, { target: '' }, { target: '.env' }],
        }));
        assert.throws(() => loadOverrides(state), /allow must be an array/);
        rmSync(join(state, 'overrides.json'));
        mkdirSync(join(state, 'overrides.json'));
        assert.throws(() => loadOverrides(state), /cannot read file/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('override targets use the same platform path form as scanned Git paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-overrides-normalized-'));
    const state = join(root, 'state');
    try {
        saveOverrides(state, {
            allow: [{ target: './.claude\\session.json', reason: 'fixture' }],
            deny: [{ target: 'generic.agent-instructions' }],
        });
        const overrides = loadOverrides(state);
        const savedTarget = process.platform === 'win32'
            ? '.claude/session.json'
            : '.claude\\session.json';
        const nestedTarget = process.platform === 'win32'
            ? 'nested/file'
            : 'nested\\file';
        assert.equal(overrides.allow[0].target, savedTarget);
        assert.deepEqual(overrides.allow.map((entry) => entry.target), [savedTarget]);
        assert.equal(normalizeOverrideTarget('././nested\\file'), nestedTarget);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('config and override replacement uses clean same-directory temporary files', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-state-write-'));
    const state = join(root, 'state');
    try {
        saveConfig(state, { profile: 'clean' });
        saveConfig(state, { profile: 'strict' });
        saveOverrides(state, { allow: [], deny: [{ target: './.env' }] });
        saveOverrides(state, { allow: [{ target: './README.md' }], deny: [] });

        assert.equal(loadConfig(state).profile, 'strict');
        assert.deepEqual(loadOverrides(state).allow.map((entry) => entry.target), ['README.md']);
        assert.deepEqual(readdirSync(state).sort(), ['config.json', 'overrides.json']);
        assert.deepEqual(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')), {
            schema_version: 1,
            profile: 'strict',
        });
        const storedOverrides = JSON.parse(readFileSync(join(state, 'overrides.json'), 'utf8'));
        assert.equal(storedOverrides.schema_version, 1);
        assert.equal(storedOverrides.allow[0].scope, undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('override state accepts legacy entries but rejects unsupported schema fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-overrides-contract-'));
    const state = join(root, 'state');
    try {
        mkdirSync(state);
        const file = join(state, 'overrides.json');
        writeFileSync(file, JSON.stringify({ allow: [{ target: 'README.md' }], deny: [] }));
        assert.equal(loadOverrides(state).allow[0].scope, undefined);

        // v0.3.0 retired the secret-path scope with built-in secret scanning:
        // legacy entries drop with a one-line stderr warning naming the file
        // instead of failing the load, and the rest of the file survives.
        writeFileSync(file, JSON.stringify({
            allow: [
                { target: '.env', scope: 'secret-path' },
                { target: 'README.md', scope: 'path' },
            ],
            deny: [{ target: '.aws/credentials', scope: 'secret-path' }],
        }));
        const writes = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
        let migrated;
        try {
            migrated = loadOverrides(state);
        } finally {
            process.stderr.write = originalWrite;
        }
        assert.deepEqual(migrated.allow, [{ target: 'README.md', scope: 'path' }]);
        assert.deepEqual(migrated.deny, []);
        assert.equal(writes.length, 1);
        assert.match(writes[0], /dropped 2 override\(s\) with retired scope "secret-path"/);
        assert.ok(writes[0].includes(file), 'warning names the overrides file');

        writeFileSync(file, JSON.stringify({
            allow: [],
            deny: [{ target: '.aimhooman.json', scope: 'policy-migration' }],
        }));
        assert.throws(() => loadOverrides(state), /policy-migration is only valid for allow/);

        writeFileSync(file, JSON.stringify({ schema_version: 2, allow: [], deny: [] }));
        assert.throws(() => loadOverrides(state), /schema_version must be 1/);
        writeFileSync(file, JSON.stringify({ schema_version: 1, allow: [], deny: [], extra: true }));
        assert.throws(() => loadOverrides(state), /unsupported field: extra/);
        writeFileSync(file, JSON.stringify({
            schema_version: 1,
            allow: [{ target: 'README.md', scope: 'path', extra: true }],
            deny: [],
        }));
        assert.throws(() => loadOverrides(state), /unsupported field: extra/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('review and policy migration overrides require complete revision bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-overrides-bindings-'));
    const state = join(root, 'state');
    const oid = 'a'.repeat(40);
    const next = 'b'.repeat(40);
    try {
        mkdirSync(state);
        const file = join(state, 'overrides.json');
        const write = (allow) => writeFileSync(file, JSON.stringify({ schema_version: 1, allow, deny: [] }));

        write([{ target: 'AGENTS.md', scope: 'reviewed-instruction' }]);
        assert.throws(() => loadOverrides(state), /head is required for reviewed-instruction/);
        write([{ target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid }]);
        assert.throws(() => loadOverrides(state), /transition is required for reviewed-instruction/);
        write([{
            target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid, transition: 'staged',
        }]);
        assert.throws(() => loadOverrides(state), /newObjectId is required for reviewed-instruction/);
        write([{
            target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid,
            transition: 'staged', newObjectId: next,
        }]);
        assert.throws(() => loadOverrides(state), /newMode is required for reviewed-instruction/);
        write([{
            target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid,
            transition: 'not-a-commit', newObjectId: next, newMode: '100644',
        }]);
        assert.throws(() => loadOverrides(state), /transition must be "staged" or a full Git object ID/);
        write([{
            target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid,
            transition: 'staged', newObjectId: next, newMode: '120000',
        }]);
        assert.throws(() => loadOverrides(state), /newMode must be a regular-file Git mode or null/);
        write([{
            target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid,
            transition: 'staged', newObjectId: next, newMode: null,
        }]);
        assert.throws(() => loadOverrides(state), /must both describe a blob or both be null/);
        write([{
            target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid,
            transition: oid, newObjectId: next, newMode: '100644', oldObjectId: oid,
        }]);
        assert.throws(() => loadOverrides(state), /oldObjectId is only valid for policy-migration/);
        write([{ target: 'AGENTS.md', scope: 'path', head: oid }]);
        assert.throws(() => loadOverrides(state), /head requires a review-bound scope/);

        write([{
            target: '.aimhooman.json',
            scope: 'policy-migration',
            head: oid,
            transition: oid,
            oldObjectId: oid,
        }]);
        assert.throws(() => loadOverrides(state), /newObjectId is required for policy-migration/);
        write([{
            target: 'nested/.aimhooman.json',
            scope: 'policy-migration',
            head: oid,
            transition: oid,
            oldObjectId: oid,
            newObjectId: next,
        }]);
        assert.throws(() => loadOverrides(state), /target must be \.aimhooman\.json/);
        write([{
            target: '.aimhooman.json',
            scope: 'policy-migration',
            head: oid,
            transition: 'not-a-commit',
            oldObjectId: oid,
            newObjectId: null,
            newMode: null,
        }]);
        assert.throws(() => loadOverrides(state), /transition must be "staged" or a full Git object ID/);

        write([{
            target: '.aimhooman.json',
            scope: 'policy-migration',
            head: oid,
            transition: 'staged',
            oldObjectId: oid,
            newObjectId: next,
        }]);
        assert.throws(() => loadOverrides(state), /newMode is required for policy-migration/);
        write([{
            target: '.aimhooman.json',
            scope: 'policy-migration',
            head: oid,
            transition: 'staged',
            oldObjectId: oid,
            newObjectId: next,
            newMode: null,
        }]);
        assert.throws(() => loadOverrides(state), /must both describe a blob or both be null/);

        write([
            {
                target: 'AGENTS.md', scope: 'reviewed-instruction', head: oid,
                transition: 'staged', newObjectId: null, newMode: null,
            },
            {
                target: '.aimhooman.json',
                scope: 'policy-migration',
                head: oid,
                transition: 'staged',
                oldObjectId: oid,
                newObjectId: null,
                newMode: null,
            },
        ]);
        assert.equal(loadOverrides(state).allow.length, 2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('override bindings normalize to the published schema contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-overrides-canonical-'));
    const state = join(root, 'state');
    const upper = 'A'.repeat(40);
    const nextUpper = 'B'.repeat(40);
    try {
        saveOverrides(state, {
            allow: [{
                target: '.aimhooman.json',
                scope: 'policy-migration',
                head: upper,
                transition: upper,
                oldObjectId: upper,
                newObjectId: nextUpper,
                newMode: '100644',
                at: '2026-07-13T12:34:56+07:00',
            }],
            deny: [],
        });
        const stored = JSON.parse(readFileSync(join(state, 'overrides.json'), 'utf8'));
        assert.equal(stored.schema_version, 1);
        const [migration] = stored.allow;
        assert.equal(migration.head, upper.toLowerCase());
        assert.equal(migration.transition, upper.toLowerCase());
        assert.equal(migration.oldObjectId, upper.toLowerCase());
        assert.equal(migration.newObjectId, nextUpper.toLowerCase());
        assert.equal(migration.newMode, '100644');

        const schema = JSON.parse(readFileSync(
            join(import.meta.dirname, '..', 'schemas', 'overrides.schema.json'),
            'utf8',
        ));
        const objectId = new RegExp(schema.$defs.objectId.pattern);
        for (const field of ['head', 'transition', 'oldObjectId', 'newObjectId']) {
            assert.match(migration[field], objectId, field);
        }

        migration.at = 'yesterday';
        writeFileSync(join(state, 'overrides.json'), JSON.stringify(stored));
        assert.throws(() => loadOverrides(state), /at must be an RFC3339 date-time/);

        for (const impossible of ['2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z']) {
            migration.at = impossible;
            writeFileSync(join(state, 'overrides.json'), JSON.stringify(stored));
            assert.throws(() => loadOverrides(state), /at must be an RFC3339 date-time/, impossible);
        }
        migration.at = '2024-02-29T00:00:00Z';
        writeFileSync(join(state, 'overrides.json'), JSON.stringify(stored));
        assert.equal(loadOverrides(state).allow[0].at, migration.at);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('invalid state replacement leaves the prior files unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-state-failure-'));
    const state = join(root, 'state');
    try {
        saveConfig(state, { profile: 'strict' });
        saveOverrides(state, { allow: [], deny: [{ target: '.env' }] });
        const configBefore = readFileSync(join(state, 'config.json'));
        const overridesBefore = readFileSync(join(state, 'overrides.json'));

        assert.throws(() => saveConfig(state, { profile: 'clean', value: 1n }), /unsupported field/);
        assert.throws(
            () => saveOverrides(state, { allow: [{ target: 'README.md', value: 1n }], deny: [] }),
            /unsupported field/,
        );
        assert.deepEqual(readFileSync(join(state, 'config.json')), configBefore);
        assert.deepEqual(readFileSync(join(state, 'overrides.json')), overridesBefore);
        assert.deepEqual(readdirSync(state).sort(), ['config.json', 'overrides.json']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a failed temporary-file write leaves the prior state unchanged', {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
}, () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-state-permission-'));
    const state = join(root, 'state');
    try {
        saveConfig(state, { profile: 'strict' });
        saveOverrides(state, { allow: [], deny: [{ target: '.env' }] });
        const configBefore = readFileSync(join(state, 'config.json'));
        const overridesBefore = readFileSync(join(state, 'overrides.json'));
        chmodSync(state, 0o500);

        assert.throws(() => saveConfig(state, { profile: 'clean' }), /EACCES|permission denied/i);
        assert.throws(
            () => saveOverrides(state, { allow: [{ target: 'README.md' }], deny: [] }),
            /EACCES|permission denied/i,
        );
        assert.deepEqual(readFileSync(join(state, 'config.json')), configBefore);
        assert.deepEqual(readFileSync(join(state, 'overrides.json')), overridesBefore);
    } finally {
        chmodSync(state, 0o700);
        rmSync(root, { recursive: true, force: true });
    }
});

test('withLock holds the critical section and fails closed on a legacy shared lockfile', async () => {
    const { withLock } = await import('../src/atomic-write.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-'));
    try {
        const nestedLock = join(dir, 'missing', 'overrides.json.lock');
        assert.equal(withLock(nestedLock, () => 'created'), 'created');
        assert.deepEqual(readdirSync(join(dir, 'missing')), ['overrides.json.lock.queue']);
        assert.deepEqual(readdirSync(`${nestedLock}.queue`), []);

        const lock = join(dir, 'overrides.json.lock');
        assert.equal(withLock(lock, () => {
            let nestedEntered = false;
            assert.throws(
                () => withLock(lock, () => { nestedEntered = true; }, {
                    retries: 1,
                    staleMs: 0,
                }),
                /cannot acquire state lock/,
            );
            assert.equal(nestedEntered, false);
            return 42;
        }), 42);
        // The lock is released on return, so an immediate re-acquire succeeds.
        assert.equal(withLock(lock, () => 'again'), 'again');
        writeFileSync(lock, 'held');
        let entered = false;
        assert.throws(
            () => withLock(lock, () => { entered = true; }, {
                retries: 2,
                retryDelayMs: 1,
                staleMs: 60000,
            }),
            /cannot acquire state lock/,
        );
        assert.equal(entered, false);
        // A pre-queue lockfile may belong to an older aimhooman process. There
        // is no portable conditional unlink for that shared path, so even an
        // apparently stale file remains a fail-closed blocker.
        assert.throws(
            () => withLock(lock, () => 'must-not-enter', { retries: 1, staleMs: 0 }),
            /cannot acquire state lock/,
        );
        rmSync(lock);
        assert.equal(withLock(lock, () => 'after-manual-cleanup'), 'after-manual-cleanup');

        assert.equal(withLock(lock, () => {
            writeFileSync(lock, 'replacement');
            return 'replaced';
        }), 'replaced');
        assert.equal(readFileSync(lock, 'utf8'), 'replacement');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a queue directory swept mid-acquisition is recreated, not failed onto the caller', async () => {
    const { withLock } = await import('../src/atomic-write.mjs');
    const { openSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'aim-lock-swept-'));
    try {
        const lock = join(dir, 'overrides.json.lock');
        const queue = `${lock}.queue`;
        // `aimhooman uninstall` removes empty queue directories. Between mkdir and
        // the first publication this contender owns no file there, so the sweep can
        // land in the gap — which is wide, because building the candidate probes the
        // process identity via `ps` on macOS and BSD.
        let swept = false;
        const operations = {
            open: (path, flags, mode) => {
                if (!swept) {
                    swept = true;
                    rmSync(queue, { recursive: true, force: true });
                }
                return openSync(path, flags, mode);
            },
        };
        assert.equal(
            withLock(lock, () => 'entered', { candidateOperations: operations }),
            'entered',
        );
        assert.equal(swept, true, 'the sweep never ran, so the race was not exercised');
        // Released cleanly: the candidate is gone and the lock is immediately reusable.
        assert.deepEqual(readdirSync(queue), []);
        assert.equal(withLock(lock, () => 'again'), 'again');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
