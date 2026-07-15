#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(join(root, 'docs/hosts.json'), 'utf8'));
const target = join(root, 'docs/design/agent-portability.md');
const start = '<!-- aimhooman:host-table-start -->';
const end = '<!-- aimhooman:host-table-end -->';
const text = readFileSync(target, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const rows = registry.hosts.map((host) => (
    `| ${host.name} | ${host.tier} | ${host.files.map((file) => `\`${file}\``).join(', ')} | ${host.activation} | ${host.version_checked} | ${host.check_level} (${host.last_checked}) |`
));
const block = [
    start,
    '| Host | Tier | Files | Activation | Version checked | Evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    end,
].join(eol);
const from = text.indexOf(start);
const to = text.indexOf(end);
if (from < 0 || to < from) throw new Error('docs/design/agent-portability.md has no valid host-table marker pair');
const output = text.slice(0, from) + block + text.slice(to + end.length);
if (process.argv.includes('--check')) {
    if (output !== text) throw new Error('host table is out of sync; run node scripts/sync-hosts.mjs');
} else {
    writeFileSync(target, output);
}
