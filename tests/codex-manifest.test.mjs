import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCodexManifest } from '../src/codex-manifest.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'aim-manifest-'));
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks/hooks.json'), '{}');
    return root;
}

function base(extra = {}) {
    return { name: 'sample', version: '1.0.0', description: 'sample plugin', ...extra };
}

test('Codex manifest accepts every documented hook representation', () => {
    const root = fixture();
    try {
        for (const hooks of [
            './hooks/hooks.json',
            ['./hooks/hooks.json'],
            { hooks: {} },
            [{ hooks: {} }],
        ]) {
            assert.equal(validateCodexManifest(base({ hooks }), root).hooks, hooks);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Codex manifest rejects id and unsafe or missing hook paths', () => {
    const root = fixture();
    try {
        assert.throws(() => validateCodexManifest(base({ id: 'sample' }), root), /unsupported.*id/);
        assert.throws(() => validateCodexManifest(base({ hooks: 'hooks/hooks.json' }), root), /start with/);
        assert.throws(() => validateCodexManifest(base({ hooks: './missing.json' }), root), /does not exist/);
        assert.throws(() => validateCodexManifest(base({ hooks: '../outside.json' }), root), /start with|escapes/);
        assert.throws(() => validateCodexManifest(base({ hooks: ['./hooks/hooks.json', {}] }), root), /only paths|only inline/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Codex manifest validates skills/apps/mcpServers path traversal like hooks', () => {
    // The shared validatePath guard runs for these fields too; pin it so a
    // field-specific regression (dropping validatePathValue or weakening it)
    // cannot let an escaping path through.
    const root = fixture();
    try {
        mkdirSync(join(root, 'skills'));
        mkdirSync(join(root, 'apps'));
        assert.doesNotThrow(() => validateCodexManifest(base({ skills: './skills/' }), root));
        assert.doesNotThrow(() => validateCodexManifest(base({ apps: './apps/' }), root));
        for (const field of ['skills', 'apps', 'mcpServers']) {
            assert.throws(() => validateCodexManifest(base({ [field]: 'skills/' }), root), /start with/);
            assert.throws(() => validateCodexManifest(base({ [field]: '../outside' }), root), /start with|escapes/);
            assert.throws(() => validateCodexManifest(base({ [field]: './missing' }), root), /does not exist/);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
