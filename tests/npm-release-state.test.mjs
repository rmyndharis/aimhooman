import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNpmReleaseState } from '../scripts/npm-release-state.mjs';

const base = {
    name: '@example/package',
    version: '1.2.3',
    registry: 'https://registry.npmjs.org/',
    retries: 3,
    delay: async () => {},
};

function result({ ok = true, value, code = 'E500' }) {
    return ok
        ? { ok: true, status: 0, stdout: JSON.stringify(value), stderr: '' }
        : { ok: false, status: 1, stdout: '', stderr: JSON.stringify({ error: { code } }) };
}

test('new package and forward channel publish are proved before mutation', async () => {
    const first = await resolveNpmReleaseState({
        ...base,
        query: async () => result({ ok: false, code: 'E404' }),
    });
    assert.deepEqual(first, {
        schema_version: 1,
        name: base.name,
        version: base.version,
        channel: 'latest',
        version_state: 'absent',
        package_state: 'absent',
        current_tag: null,
    });

    const forward = await resolveNpmReleaseState({
        ...base,
        query: async (fields) => fields[0].includes('@1.2.3')
            ? result({ ok: false, code: 'E404' })
            : result({ value: { latest: '1.2.2' } }),
    });
    assert.equal(forward.current_tag, '1.2.2');
});

test('existing version is distinguished from an absent version', async () => {
    const state = await resolveNpmReleaseState({
        ...base,
        query: async (fields) => fields[0].includes('@1.2.3')
            ? result({ value: '1.2.3' })
            : result({ value: { latest: '1.2.3' } }),
    });
    assert.equal(state.version_state, 'existing');
    assert.equal(state.package_state, 'existing');
});

test('unknown registry failures retry and then fail closed', async () => {
    let calls = 0;
    await assert.rejects(resolveNpmReleaseState({
        ...base,
        query: async () => {
            calls += 1;
            return result({ ok: false, code: 'E503' });
        },
    }), /remained unavailable after 3 attempts/);
    assert.equal(calls, 3);
});

test('dist-tag rollback and inconsistent registry state are rejected', async () => {
    await assert.rejects(resolveNpmReleaseState({
        ...base,
        query: async (fields) => fields[0].includes('@1.2.3')
            ? result({ ok: false, code: 'E404' })
            : result({ value: { latest: '2.0.0' } }),
    }), /move a release channel backward/);

    await assert.rejects(resolveNpmReleaseState({
        ...base,
        query: async (fields) => fields[0].includes('@1.2.3')
            ? result({ value: '1.2.3' })
            : result({ ok: false, code: 'E404' }),
    }), /version but not its package metadata/);
});

test('registry, package, and response inputs are validated', async () => {
    await assert.rejects(resolveNpmReleaseState({ ...base, name: 'plain' }), /scoped npm name/);
    await assert.rejects(resolveNpmReleaseState({ ...base, registry: 'http://registry.test' }), /HTTPS/);
    await assert.rejects(resolveNpmReleaseState({
        ...base,
        query: async () => ({ ok: true, status: 0, stdout: 'not-json', stderr: '' }),
    }), /invalid JSON/);
});
