#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULESET_END, RULESET_START, rulesetBlock } from '../src/ruleset-text.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalText = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const canonical = rulesetBlock(canonicalText, 'AGENTS.md');
const copies = [
    'skills/aimhooman/SKILL.md',
    '.cursor/rules/aimhooman.mdc',
    '.clinerules/aimhooman.md',
    '.windsurf/rules/aimhooman.md',
    '.github/copilot-instructions.md',
    '.kiro/steering/aimhooman.md',
    'GEMINI.md',
    '.agents/rules/aimhooman.md',
];

for (const relative of copies) {
    const file = join(root, relative);
    const text = readFileSync(file, 'utf8');
    let output;
    const start = text.indexOf(RULESET_START);
    const end = text.indexOf(RULESET_END);
    if (start >= 0 || end >= 0) {
        if (start < 0 || end < start) throw new Error(`${relative} has invalid ruleset markers`);
        output = text.slice(0, start) + canonical + text.slice(end + RULESET_END.length);
    } else {
        const title = /(^|\n)# aimhooman\r?\n/.exec(text);
        if (!title) throw new Error(`${relative} has no ruleset markers or aimhooman title`);
        const body = title.index + title[0].length;
        output = text.slice(0, body) + '\n' + canonical + '\n';
    }
    writeFileSync(file, output.replace(/\n*$/, '\n'));
}
