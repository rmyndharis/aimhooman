import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/rules.mjs';
import { patternsForRules } from '../src/exclude.mjs';
import {
    renderCatalog,
    renderGitignore,
    syncCatalog,
} from '../scripts/sync-catalog.mjs';

const ROOT = join(import.meta.dirname, '..');

function withTempRoot(run) {
    const root = mkdtempSync(join(tmpdir(), 'aimhooman-catalog-'));
    try {
        mkdirSync(join(root, 'docs'), { recursive: true });
        run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function managedLines(text, start, end) {
    return text.slice(text.indexOf(start) + start.length, text.indexOf(end))
        .split('\n')
        .filter((line) => line.trim());
}

test('catalog generators are deterministic across rule loads', () => {
    assert.equal(renderGitignore(loadRules()), renderGitignore(loadRules()));
    assert.equal(renderCatalog(loadRules()), renderCatalog(loadRules()));
    const patterns = patternsForRules(loadRules());
    assert.deepEqual(patterns, [...patterns].sort());
});

test('sync:catalog --check passes on the committed artifacts', () => {
    execFileSync(process.execPath, ['scripts/sync-catalog.mjs', '--check'], { cwd: ROOT });
    const rules = loadRules();
    assert.equal(readFileSync(join(ROOT, 'docs/ai-artifacts.gitignore'), 'utf8'), renderGitignore(rules));
    assert.equal(readFileSync(join(ROOT, 'docs/catalog.md'), 'utf8'), renderCatalog(rules));
});

test('sync:catalog --check fails when an artifact is stale or missing', () => {
    withTempRoot((root) => {
        assert.throws(() => syncCatalog(root, { check: true }), /out of sync: .*ai-artifacts\.gitignore/);
        syncCatalog(root);
        assert.doesNotThrow(() => syncCatalog(root, { check: true }));
        writeFileSync(join(root, 'docs/catalog.md'), 'stale hand edit\n');
        assert.throws(() => syncCatalog(root, { check: true }), /out of sync: docs\/catalog\.md/);
        syncCatalog(root);
        assert.doesNotThrow(() => syncCatalog(root, { check: true }));
    });
});

test('gitignore artifact lists exactly the rule-derived patterns', () => {
    const text = readFileSync(join(ROOT, 'docs/ai-artifacts.gitignore'), 'utf8');
    const lines = managedLines(text, '# >>> aimhooman:catalog-start', '# <<< aimhooman:catalog-end');
    assert.deepEqual(lines, patternsForRules(loadRules()));
});

test('catalog table covers every built-in rule', () => {
    const text = readFileSync(join(ROOT, 'docs/catalog.md'), 'utf8');
    const rows = managedLines(text, '<!-- aimhooman:catalog-start -->', '<!-- aimhooman:catalog-end -->')
        .filter((line) => line.startsWith('| `'));
    const rules = loadRules();
    assert.equal(rows.length, rules.length);
    for (const [index, rule] of rules.entries()) {
        assert.ok(rows[index].startsWith(`| \`${rule.id}\` |`), `catalog row ${index} is not ${rule.id}`);
        assert.ok(rows[index].endsWith(` ${rule.reason} |`), `${rule.id} reason differs`);
    }
});
