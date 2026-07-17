import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourceDir = join(import.meta.dirname, '..', 'src');

// Returns the argument text of every execFileSync(...) call in the source, by
// counting parentheses from the opening one. String and comment contents are not
// excluded: a lone unbalanced ")" inside either would misread a call's extent.
// No source here does that, and the check runs over this repository only.
function callArguments(source) {
    const calls = [];
    const marker = 'execFileSync(';
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
        let depth = 0;
        const open = at + marker.length - 1;
        for (let index = open; index < source.length; index += 1) {
            if (source[index] === '(') depth += 1;
            else if (source[index] === ')') {
                depth -= 1;
                if (depth === 0) {
                    calls.push({ index: open, text: source.slice(open, index + 1) });
                    break;
                }
            }
        }
    }
    return calls;
}

function lineOf(source, index) {
    return source.slice(0, index).split('\n').length;
}

// Options reach execFileSync either inline or through a variable, as in
// `const opts = {...}; execFileSync('git', args, opts)`. For the variable form,
// resolve the name to its declaration in the same file and read that instead.
function setsTimeout(source, call) {
    if (/\btimeout\s*:/.test(call.text)) return true;
    const passed = call.text.match(/,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)$/);
    if (!passed) return false;
    const declaration = source.match(
        new RegExp(`\\b(?:const|let|var)\\s+${passed[1]}\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\};`),
    );
    return declaration ? /\btimeout\s*:/.test(declaration[0]) : false;
}

// A child that never exits blocks execFileSync forever: it has no default
// timeout. One such git process held a CI runner for 6 hours and died to the
// platform's 6-hour ceiling, not to anything this code did.
test('every execFileSync in src/ sets a timeout', () => {
    const offenders = [];
    for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.mjs'))) {
        const source = readFileSync(join(sourceDir, file), 'utf8');
        for (const call of callArguments(source)) {
            if (!setsTimeout(source, call)) {
                offenders.push(`src/${file}:${lineOf(source, call.index)}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `execFileSync without a timeout:\n${offenders.join('\n')}`);
});

test('the git timeout is bounded and leaves room for a slow repository', async () => {
    const { GIT_TIMEOUT_MS } = await import('../src/git-environment.mjs');
    assert.equal(Number.isInteger(GIT_TIMEOUT_MS), true);
    assert.ok(GIT_TIMEOUT_MS >= 30_000, 'too tight: a large repository would be refused');
    assert.ok(GIT_TIMEOUT_MS <= 300_000, 'too loose: a hang would outlive a CI job');
});
