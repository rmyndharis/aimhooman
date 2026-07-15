import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPackageManifest } from '../scripts/package-manifest.mjs';
import { DEFAULT_SCAN_LIMITS } from '../src/scan-session.mjs';

const root = join(import.meta.dirname, '..');

function filesBelow(directory, prefix) {
    const paths = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) paths.push(...filesBelow(join(directory, entry.name), relative));
        else paths.push(relative);
    }
    return paths;
}

function requiredFiles() {
    const runtime = ['bin', 'src', 'rules', 'hooks', 'schemas', 'docs/design', 'docs/logo']
        .flatMap((directory) => filesBelow(join(root, directory), directory));
    const registry = JSON.parse(readFileSync(join(root, 'docs/hosts.json'), 'utf8'));
    const adapters = registry.hosts.flatMap((host) => [
        ...host.files,
        ...(host.canonical_copy ? [host.canonical_copy] : []),
    ]);
    return [...new Set([...runtime, 'docs/hosts.json', ...adapters])];
}

test('package manifest accepts the required runtime tree', () => {
    assert.doesNotThrow(() => assertPackageManifest(requiredFiles(), root));
    for (const file of filesBelow(join(root, 'docs/logo'), 'docs/logo')) {
        assert.ok(
            statSync(join(root, file)).size <= DEFAULT_SCAN_LIMITS.maxFileBytes,
            `${file} must fit within the default history-scan file limit`,
        );
    }
});

test('package manifest rejects internal reviews, credentials, and local AI state', () => {
    const forbidden = [
        'docs/reviews/internal.md',
        'src/.env',
        'src/private.PEM',
        'src/.claude.json',
        'src/.claude/session-1.json',
        'src/.codex/sessions/run.json',
        'src/.codex/history.jsonl',
        'src/.copilot/state.json',
        'src/.cursor/session.json',
        'src/.aider.conf.yml',
        'src/.specstory/history.json',
        'src/.continue/sessions/run.json',
        'src/.playwright-mcp/trace.json',
        'src/.remember/state.json',
        'src/.superpowers/cache.json',
        'src/.agent/state.json',
    ];
    for (const path of forbidden) {
        assert.throws(
            () => assertPackageManifest([...requiredFiles(), path], root),
            /internal review|secret-prone|local AI state/,
            path,
        );
    }
    assert.doesNotThrow(() => assertPackageManifest([
        ...requiredFiles(),
        'src/.env.example',
    ], root));
});

test('package manifest allows a public PEM certificate but rejects private-key PEM content', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aim-package-pem-'));
    try {
        for (const directory of [
            'bin', 'src', 'rules', 'hooks', 'schemas', 'docs/design',
        ]) mkdirSync(join(fixture, directory), { recursive: true });
        writeFileSync(
            join(fixture, 'docs/hosts.json'),
            '{"schema_version":1,"hosts":[]}\n',
        );
        const certificate = join(fixture, 'src/public.pem');
        const paths = ['docs/hosts.json', 'src/public.pem'];
        writeFileSync(
            certificate,
            '-----BEGIN CERTIFICATE-----\npublic fixture\n-----END CERTIFICATE-----\n',
        );
        assert.doesNotThrow(() => assertPackageManifest(paths, fixture));

        writeFileSync(
            certificate,
            '-----BEGIN ' + 'PRIVATE KEY-----\nprivate fixture\n-----END PRIVATE KEY-----\n',
        );
        assert.throws(
            () => assertPackageManifest(paths, fixture),
            /private-key content/,
        );
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('package manifest rejects paths outside the public package contract', () => {
    for (const path of [
        '.github/workflows/release.yml',
        '/src/absolute.mjs',
        'src/../secret.txt',
        'src\\ambiguous.mjs',
        'src/control\nname.mjs',
    ]) {
        assert.throws(
            () => assertPackageManifest([...requiredFiles(), path], root),
            /unsafe path|unexpected path/,
            path,
        );
    }
});

test('package manifest requires every adapter named by the host registry', () => {
    const files = requiredFiles();
    for (const adapter of [
        '.github/hooks/aimhooman.json',
        '.cursor/rules/aimhooman.mdc',
        '.gemini/settings.json',
        'GEMINI.md',
    ]) {
        assert.throws(
            () => assertPackageManifest(files.filter((path) => path !== adapter), root),
            new RegExp(`missing host adapter ${adapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
            adapter,
        );
    }
});

test('package manifest rejects adapter files absent from the host registry', () => {
    for (const path of [
        '.cursor/rules/abandoned.mdc',
        '.claude-plugin/old.json',
        'hooks/legacy.json',
        'skills/unused/SKILL.md',
    ]) {
        assert.throws(
            () => assertPackageManifest([...requiredFiles(), path], root),
            /unregistered host adapter/,
            path,
        );
    }
});
