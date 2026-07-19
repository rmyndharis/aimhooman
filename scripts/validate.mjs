#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/rules.mjs';
import { loadProjectPolicy } from '../src/state.mjs';
import { validateCodexManifest } from '../src/codex-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function json(path) {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function files(dir = ROOT, prefix = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const relative = join(prefix, entry.name);
        if (entry.isDirectory()) out.push(...files(join(dir, entry.name), relative));
        else out.push(relative);
    }
    return out;
}

function validateCodexPlugin() {
    const manifest = json('.codex-plugin/plugin.json');
    validateCodexManifest(manifest, ROOT);
    const requireString = (value, field) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
    };
    for (const field of [
        'displayName', 'shortDescription', 'longDescription', 'developerName', 'category',
    ]) requireString(manifest.interface?.[field], `plugin.interface.${field}`);
    if (!Array.isArray(manifest.interface?.capabilities) || !manifest.interface.capabilities.length) {
        throw new Error('plugin.interface.capabilities must be a non-empty array');
    }
    if (!Array.isArray(manifest.interface?.defaultPrompt) || !manifest.interface.defaultPrompt.length) {
        throw new Error('plugin.interface.defaultPrompt must be a non-empty array');
    }
}

let tracked;
if (existsSync(join(ROOT, '.git'))) {
    tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT })
        .toString('utf8')
        .split('\0')
        .filter((path) => path && existsSync(join(ROOT, path)));
} else {
    tracked = files();
}

for (const path of tracked.filter((path) => path.endsWith('.json'))) json(path);

for (const path of tracked.filter((path) => /^(bin|src|scripts|tests)\/.*\.mjs$/.test(path.replace(/\\/g, '/')))) {
    execFileSync(process.execPath, ['--check', join(ROOT, path)], { stdio: 'pipe' });
}

const pkg = json('package.json');
if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' || pkg.publishConfig?.access !== 'public') {
    throw new Error('package publishConfig must pin the public npm registry');
}
validateCodexPlugin();
const claudePlugin = json('.claude-plugin/plugin.json');
if (typeof claudePlugin.hooks !== 'string' || !claudePlugin.hooks.startsWith('./')) {
    throw new Error('.claude-plugin/plugin.json hooks must be a relative path starting with ./');
}
if (!existsSync(join(ROOT, claudePlugin.hooks))) {
    throw new Error(`.claude-plugin/plugin.json hooks path does not exist: ${claudePlugin.hooks}`);
}
const versions = new Map([
    ['package.json', pkg.version],
    ['.claude-plugin/plugin.json', claudePlugin.version],
    ['.codex-plugin/plugin.json', json('.codex-plugin/plugin.json').version],
    ['.claude-plugin/marketplace.json', json('.claude-plugin/marketplace.json').plugins[0].version],
]);
const mismatch = [...versions].filter(([, version]) => version !== pkg.version);
if (mismatch.length) {
    throw new Error(`version mismatch: ${mismatch.map(([file, version]) => `${file}=${version}`).join(', ')}`);
}

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!readme.includes(`version-v${pkg.version.replace(/-/g, '--')}`) || !readme.includes(`alt="v${pkg.version}"`)) {
    throw new Error(`README version badge does not match v${pkg.version}`);
}
if (!changelog.includes(`## [${pkg.version}]`)) {
    throw new Error(`CHANGELOG has no heading for ${pkg.version}`);
}

const rules = loadRules();
const ids = new Set(rules.map((rule) => rule.id));
if (ids.size !== rules.length) throw new Error('built-in rule IDs are not unique');
loadProjectPolicy(ROOT);

execFileSync(process.execPath, ['scripts/sync-catalog.mjs', '--check'], { cwd: ROOT });

console.log(`validated ${tracked.filter((path) => path.endsWith('.json')).length} JSON files, ${rules.length} rules, source syntax, catalog sync, and version ${pkg.version}`);
