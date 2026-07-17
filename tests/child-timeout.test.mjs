import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// bin/ is the entry point every installed git hook executes, so an unbounded call
// there reaches a user exactly like one in src/. scripts/ is repository tooling that
// never ships, and its own CI job bounds it.
const GUARDED = ['src', 'bin'];
const root = join(import.meta.dirname, '..');

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Both gates below have to read every shipped file, including any added under a new
// subdirectory: a call site the walk never opens is a call site neither gate checks.
function guardedSources() {
    const sources = [];
    for (const directory of GUARDED) {
        for (const entry of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
            // The walk yields directory entries too, so a directory named *.mjs would
            // reach readFileSync and throw EISDIR.
            if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
            const file = join(entry.parentPath, entry.name);
            sources.push([relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8')]);
        }
    }
    return sources;
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
    for (const [path, source] of guardedSources()) {
        for (const call of callArguments(source, path)) {
            checked += 1;
            if (!setsTimeout(source, call)) offenders.push(`${path}:${lineOf(source, call.index)}`);
        }
    }
    assert.ok(checked >= 20, `expected to inspect the known call sites, saw ${checked}`);
    assert.deepEqual(offenders, [], `execFileSync without a timeout:\n${offenders.join('\n')}`);
});

// Match the import rather than call text: `.exec(` on a RegExp is unrelated to
// child_process, and a substring search cannot tell the two apart. Anchor on the
// specifier, not on one way of writing the statement: either quote style, with or
// without the node: prefix, static or dynamic, are all the same import to Node, and a
// file may import the module more than once.
const CHILD_PROCESS_IMPORT = /(?:from|import\s*\()\s*['"](?:node:)?child_process['"]/g;
const NAMED_IMPORT = /import\s*\{([^{}]*)\}\s*$/;
const IMPORT_CLAUSE = /\bimport\b[^;\n]*$/;

// Returns what each child_process import pulls in. A brace list names its own bindings,
// so those are read out. A default, namespace, or dynamic import hands over the whole
// module and states no names at all, so it is reported verbatim: a form this gate
// cannot read must fail it, not pass as an import of nothing.
function childProcessApis(source) {
    const stripped = stripComments(source);
    const apis = [];
    for (const match of stripped.matchAll(CHILD_PROCESS_IMPORT)) {
        const before = stripped.slice(0, match.index);
        const named = before.match(NAMED_IMPORT);
        if (named) {
            apis.push(...named[1].split(',').map((part) => part.trim()).filter(Boolean));
            continue;
        }
        apis.push(`${before.match(IMPORT_CLAUSE)?.[0] ?? ''}${match[0]}`.trim());
    }
    return apis;
}

// execFileSync is the only child-process API the shipped code uses. If that changes,
// the check above stops covering the surface it claims to, so hold the assumption here
// rather than let a spawnSync quietly bypass the gate.
test('src/ and bin/ import no child-process API other than execFileSync', () => {
    const others = [];
    for (const [path, source] of guardedSources()) {
        for (const api of childProcessApis(source)) {
            if (api !== 'execFileSync') others.push(`${path}: ${api}`);
        }
    }
    assert.deepEqual(others, [], `child-process API this gate does not check:\n${others.join('\n')}`);
});

// This gate's subject is the spelling of an import, and the shipped tree happens to use
// exactly one spelling. Every form below is a working way to reach spawnSync, so a gate
// that cannot read one of them reports green over an open surface.
test('the child-process import check reads every import form', () => {
    for (const form of [
        "import { spawnSync } from 'node:child_process';",
        'import { spawnSync } from "node:child_process";',
        "import { spawnSync } from 'child_process';",
        "import cp from 'node:child_process';",
        "import * as cp from 'node:child_process';",
        "const { spawnSync } = await import('node:child_process');",
        "import { execFileSync } from 'node:child_process';\nimport { spawnSync } from 'node:child_process';",
    ]) {
        assert.notDeepEqual(
            childProcessApis(form).filter((api) => api !== 'execFileSync'),
            [],
            `import form this gate cannot read: ${form}`,
        );
    }
    assert.deepEqual(childProcessApis("import { execFileSync } from 'node:child_process';"), ['execFileSync']);
});

test('the git timeout is bounded and leaves room for a slow repository', async () => {
    const { GIT_TIMEOUT_MS } = await import('../src/git-environment.mjs');
    assert.equal(Number.isInteger(GIT_TIMEOUT_MS), true);
    assert.ok(GIT_TIMEOUT_MS >= 30_000, 'too tight: a large repository would be refused');
    assert.ok(GIT_TIMEOUT_MS <= 300_000, 'too loose: a hang would outlive a CI job');
});
