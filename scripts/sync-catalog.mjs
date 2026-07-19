#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionFor, loadRules } from '../src/rules.mjs';
import { patternsForRules } from '../src/exclude.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES = ['clean', 'strict', 'compliance'];
const GENERATED_NOTE = 'Generated from rules/*.json by `npm run sync:catalog`; do not edit by hand.';

// Both artifacts are regenerated whole from the built-in rule packs, so the
// published catalog can never drift behind enforcement. The marker pairs wrap
// the machine-derived section of each file.
const GITIGNORE_START = '# >>> aimhooman:catalog-start';
const GITIGNORE_END = '# <<< aimhooman:catalog-end';
const CATALOG_START = '<!-- aimhooman:catalog-start -->';
const CATALOG_END = '<!-- aimhooman:catalog-end -->';

export function renderGitignore(rules) {
    return [
        '# AI tooling artifacts for .gitignore',
        '#',
        '# These patterns cover the session and state files that AI coding tools',
        '# write into a working tree: transcripts, history, caches, logs, and local',
        '# settings. aimhooman keeps them out of commits. Copy the lines below into',
        '# your .gitignore as-is. Matching follows normal gitignore rules and is',
        '# case-sensitive. The machine-enforced version of this list lives in the',
        '# aimhooman CLI, which blocks these paths at commit time; this file is the',
        '# standalone copy for anyone who wants the same coverage without the hooks.',
        '#',
        `# ${GENERATED_NOTE}`,
        '# `npm run check` fails when this file is stale.',
        '',
        GITIGNORE_START,
        ...patternsForRules(rules),
        GITIGNORE_END,
        '',
    ].join('\n');
}

export function renderCatalog(rules) {
    const rows = rules.map((rule) => [
        `\`${rule.id}\``,
        rule.provider,
        rule.category,
        rule.kind,
        ...PROFILES.map((profile) => actionFor(rule, profile)),
        rule.reason,
    ].map(cell).join(' | '));
    return [
        '# AI-artifact catalog',
        '',
        `<!-- ${GENERATED_NOTE} -->`,
        '',
        'aimhooman watches commits for AI residue: tooling artifacts (session files,',
        'local settings, and agent state that belong on your machine, not in history)',
        'and AI attribution (co-author trailers, "generated with" lines, leftover',
        'markers in code). The table lists every built-in rule and what each profile',
        'does when it matches: `block` stops the commit, `review` asks a human to',
        'confirm, `allow` lets it through.',
        '',
        'Secret scanning is out of scope since v0.3.0. See',
        '[docs/secrets.md](secrets.md) for the reasoning and the gitleaks setup we',
        'recommend instead.',
        '',
        CATALOG_START,
        '| Rule | Provider | Category | Kind | clean | strict | compliance | Reason |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map((row) => `| ${row} |`),
        CATALOG_END,
        '',
    ].join('\n');
}

// A pipe inside a cell would split the Markdown table; rule text does not use
// any today, and this keeps a future reason safe.
function cell(value) {
    return String(value).replace(/\|/g, '\\|');
}

export function catalogTargets(root) {
    return [
        { file: 'docs/ai-artifacts.gitignore', render: renderGitignore },
        { file: 'docs/catalog.md', render: renderCatalog },
    ].map((target) => ({ ...target, path: join(root, target.file) }));
}

// syncCatalog writes both artifacts, or with check=true only reports drift.
// Rules always load from the built-in packs (no stateDir), so a local pack
// can never leak into the public catalog.
export function syncCatalog(root = ROOT, { check = false } = {}) {
    const rules = loadRules();
    const stale = [];
    for (const target of catalogTargets(root)) {
        const output = target.render(rules);
        const current = existsSync(target.path) ? readFileSync(target.path, 'utf8') : null;
        if (current === output) continue;
        if (check) stale.push(target.file);
        else writeFileSync(target.path, output);
    }
    if (stale.length) {
        throw new Error(`catalog is out of sync: ${stale.join(', ')}; run npm run sync:catalog`);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        syncCatalog(ROOT, { check: process.argv.includes('--check') });
    } catch (error) {
        console.error(`sync:catalog: ${error.message}`);
        process.exitCode = 1;
    }
}
