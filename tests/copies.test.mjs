import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/rules.mjs';
import {
    RULESET_END,
    RULESET_START,
    extractRuleset,
    normalizedRuleset,
} from '../src/ruleset-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(join(ROOT, 'docs/hosts.json'), 'utf8'));
const providerTerms = new Map([
    ['claude-code', '.claude'],
    ['codex', '.codex'],
    ['copilot', '.copilot'],
    ['cursor', '.cursor'],
    ['aider', 'aider'],
    ['specstory', '.specstory'],
    ['continue', '.continue'],
    ['playwright-mcp', '.playwright-mcp'],
    ['remember', '.remember'],
    ['superpowers', '.superpowers'],
    ['aws', '.aws'],
]);

test('adapter copies contain only their wrapper and the ordered canonical ruleset', () => {
    const canonicalText = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const canonical = normalizedRuleset(canonicalText, 'AGENTS.md');
    const registered = new Set(registry.hosts.map((host) => host.canonical_copy).filter(Boolean));
    const discovered = new Set(findMarkedMarkdown(ROOT)
        .filter((path) => path !== 'AGENTS.md'));
    assert.deepEqual([...registered].sort(), [...discovered].sort());

    for (const path of registered) {
        const text = readFileSync(join(ROOT, path), 'utf8');
        assert.equal(normalizedRuleset(text, path), canonical, `${path} ruleset differs from AGENTS.md`);
        const wrapper = removeRuleset(text).trim();
        assert.match(
            wrapper,
            /^(?:---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n)?# aimhooman$/,
            `${path} contains policy text outside the canonical ruleset region`,
        );
    }
    assert.equal(removeRuleset(canonicalText).trim(), '# aimhooman: ship it like a hooman');
});

test('ruleset comparison preserves meaningful Markdown whitespace', () => {
    const canonical = [
        RULESET_START,
        '- command:',
        '    nested: true',
        RULESET_END,
    ].join('\n');
    const drifted = [
        RULESET_START,
        '- command:',
        '  nested: true',
        RULESET_END,
    ].join('\r\n');
    assert.notEqual(normalizedRuleset(drifted), normalizedRuleset(canonical));
    assert.equal(normalizedRuleset(canonical.replace(/\n/g, '\r\n')), normalizedRuleset(canonical));
});

test('host registry paths exist and the generated support table is current', () => {
    assert.equal(registry.schema_version, 1);
    const ids = new Set();
    for (const host of registry.hosts) {
        assert.equal(ids.has(host.id), false, `duplicate host id: ${host.id}`);
        ids.add(host.id);
        assert.match(host.spec, /^https:\/\//);
        assert.ok(host.files.length > 0);
        assert.equal(host.check_level, 'static');
        assert.match(host.last_checked, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(typeof host.version_checked, 'string');
        assert.ok(host.version_checked.length > 0);
        for (const path of host.files) assert.equal(existsSync(join(ROOT, path)), true, `${host.id}: ${path}`);
        if (host.canonical_copy) assert.ok(host.files.includes(host.canonical_copy));
    }
    execFileSync(process.execPath, ['scripts/sync-hosts.mjs', '--check'], { cwd: ROOT });
});

test('GitHub Copilot hooks preserve enforcement exits on Bash and PowerShell', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.github/hooks/aimhooman.json'), 'utf8'));
    for (const event of ['sessionStart', 'preToolUse']) {
        for (const hook of manifest.hooks[event]) {
            assert.match(hook.bash, /^if command -v aimhooman/);
            assert.doesNotMatch(hook.bash, /aimhooman hook .* \|\| exit 0/);
            assert.match(hook.powershell, /Get-Command aimhooman/);
            assert.match(hook.powershell, /exit \$LASTEXITCODE/);
        }
    }
});

test('Gemini CLI context points at the canonical repository instructions', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.gemini/settings.json'), 'utf8'));
    assert.deepEqual(settings.context?.fileName, ['AGENTS.md']);
    const gemini = registry.hosts.find((host) => host.id === 'gemini-cli');
    assert.ok(gemini?.files.includes('.gemini/settings.json'));
    assert.ok(gemini?.files.includes('GEMINI.md'));
});

test('agent policy names every provider with built-in rules', () => {
    const policy = extractRuleset(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'), 'AGENTS.md').toLowerCase();
    assertProviderCoverage(policy, loadRules());
});

test('provider sync catches a provider used only by a content rule', () => {
    const policy = extractRuleset(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'), 'AGENTS.md').toLowerCase();
    assert.throws(
        () => assertProviderCoverage(policy, [
            ...loadRules(),
            { provider: 'message-only-provider', kind: 'message' },
        ]),
        /message-only-provider/,
    );
});

function assertProviderCoverage(policy, rules) {
    const providers = new Set(rules
        .filter((rule) => !['generic', 'aimhooman'].includes(rule.provider))
        .map((rule) => rule.provider));
    const missingTerms = [...providers].filter((provider) => !providerTerms.has(provider)).sort();
    assert.deepEqual(missingTerms, [], `providers need instruction terms: ${missingTerms.join(', ')}`);
    const unusedTerms = [...providerTerms.keys()].filter((provider) => !providers.has(provider)).sort();
    assert.deepEqual(unusedTerms, [], `instruction terms have no rules: ${unusedTerms.join(', ')}`);
    for (const [provider, term] of providerTerms) {
        assert.match(policy, new RegExp(escapeRegExp(term)), `policy does not name ${provider}`);
    }
}

function removeRuleset(text) {
    extractRuleset(text);
    const start = text.indexOf(RULESET_START);
    const end = text.indexOf(RULESET_END) + RULESET_END.length;
    return text.slice(0, start) + text.slice(end);
}

function findMarkedMarkdown(directory) {
    const found = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'docs'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...findMarkedMarkdown(path));
        else if (/\.mdc?$/.test(entry.name) && readFileSync(path, 'utf8').includes(RULESET_START)) {
            // Registry paths are Git/package paths and always use forward
            // slashes, independent of the checkout host's native separator.
            found.push(relative(ROOT, path).split(sep).join('/'));
        }
    }
    return found;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
