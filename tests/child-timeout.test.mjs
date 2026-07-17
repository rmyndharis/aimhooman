import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// bin/ is the entry point every installed git hook executes, so an unbounded call
// there reaches a user exactly like one in src/. scripts/ is repository tooling that
// never ships, and its own CI job bounds it.
const GUARDED = ['src', 'bin'];
const root = join(import.meta.dirname, '..');

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Returns the argument text of every execFileSync(...) call, by counting parentheses
// from the opening one. Parentheses inside strings, regexes, and comments are counted
// too, so an unbalanced one there would misread a call's extent. Rather than let that
// pass silently, an unterminated call throws: an unparseable call site fails the gate
// instead of disappearing from it.
function callArguments(source, label) {
    const calls = [];
    const marker = 'execFileSync(';
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
        let depth = 0;
        let closed = false;
        const open = at + marker.length - 1;
        for (let index = open; index < source.length; index += 1) {
            if (source[index] === '(') depth += 1;
            else if (source[index] === ')') {
                depth -= 1;
                if (depth === 0) {
                    calls.push({ index: open, text: source.slice(open, index + 1) });
                    closed = true;
                    break;
                }
            }
        }
        if (!closed) {
            throw new Error(`${label}: unbalanced parentheses after execFileSync( at offset ${open}`);
        }
    }
    return calls;
}

function lineOf(source, index) {
    return source.slice(0, index).split('\n').length;
}

// Options reach execFileSync either inline or through a variable, as in
// `const opts = {...}; execFileSync('git', args, opts)`. For the variable form, resolve
// the name to the nearest declaration ABOVE the call. Nearest-preceding is not a real
// scope model — a parameter named like an earlier local still resolves to that local —
// so a name declared more than once is treated as unresolvable and fails the gate.
function setsTimeout(source, call) {
    if (/\btimeout\s*:/.test(stripComments(call.text))) return true;
    const passed = call.text.match(/,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)$/);
    if (!passed) return false;
    const declarations = source.slice(0, call.index).match(
        new RegExp(`\\b(?:const|let|var)\\s+${passed[1]}\\s*=\\s*\\{[\\s\\S]*?\\n\\s*\\};`, 'g'),
    );
    if (declarations?.length !== 1) return false;
    return /\btimeout\s*:/.test(stripComments(declarations[0]));
}

// execFileSync has no default timeout, so a child that never exits blocks its caller
// for as long as it lives. One git process held a CI runner for six hours and died to
// the platform's ceiling, not to anything this code did. The bound has to hold for
// call sites nobody has written yet, which is what this test is for.
test('every execFileSync in src/ and bin/ sets a timeout', () => {
    const offenders = [];
    let checked = 0;
    for (const directory of GUARDED) {
        for (const file of readdirSync(join(root, directory)).filter((name) => name.endsWith('.mjs'))) {
            const relative = `${directory}/${file}`;
            const source = readFileSync(join(root, relative), 'utf8');
            for (const call of callArguments(source, relative)) {
                checked += 1;
                if (!setsTimeout(source, call)) offenders.push(`${relative}:${lineOf(source, call.index)}`);
            }
        }
    }
    assert.ok(checked >= 20, `expected to inspect the known call sites, saw ${checked}`);
    assert.deepEqual(offenders, [], `execFileSync without a timeout:\n${offenders.join('\n')}`);
});

// execFileSync is the only child-process API the shipped code uses. If that changes,
// the check above stops covering the surface it claims to, so hold the assumption here
// rather than let a spawnSync quietly bypass the gate.
test('src/ and bin/ import no child-process API other than execFileSync', () => {
    const others = [];
    for (const directory of GUARDED) {
        for (const file of readdirSync(join(root, directory)).filter((name) => name.endsWith('.mjs'))) {
            const source = stripComments(readFileSync(join(root, directory, file), 'utf8'));
            // Match the import rather than call text: `.exec(` on a RegExp is unrelated
            // to child_process, and a substring search cannot tell the two apart.
            const imported = source.match(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/);
            for (const name of imported?.[1].split(',').map((part) => part.trim()).filter(Boolean) || []) {
                if (name !== 'execFileSync') others.push(`${directory}/${file}: ${name}`);
            }
        }
    }
    assert.deepEqual(others, [], `child-process API this gate does not check:\n${others.join('\n')}`);
});

test('the git timeout is bounded and leaves room for a slow repository', async () => {
    const { GIT_TIMEOUT_MS } = await import('../src/git-environment.mjs');
    assert.equal(Number.isInteger(GIT_TIMEOUT_MS), true);
    assert.ok(GIT_TIMEOUT_MS >= 30_000, 'too tight: a large repository would be refused');
    assert.ok(GIT_TIMEOUT_MS <= 300_000, 'too loose: a hang would outlive a CI job');
});
