import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadRules } from './rules.mjs';
import { atomicWrite, withLock } from './atomic-write.mjs';

const BEGIN = '# >>> aimhooman managed excludes (do not edit by hand)';
const END = '# <<< aimhooman managed excludes';

// Local AI residue kept out of `git status`. Deriving this list from the rule
// catalog prevents the prevention layer from drifting behind enforcement. We
// intentionally exclude only unambiguous tooling state/settings: review-
// required and policy rules must remain visible to users.
const AUTO_EXCLUDE_CATEGORIES = new Set(['ephemeral-state', 'local-settings']);

export function patternsForRules(rules) {
    const patterns = new Set();
    for (const rule of rules || []) {
        if (rule.kind !== 'path' || !AUTO_EXCLUDE_CATEGORIES.has(rule.category)) continue;
        if (rule.match?.except?.length) continue;
        const actions = rule.actions || {};
        if (['clean', 'strict', 'compliance'].some((p) => actions[p] !== 'block')) continue;
        for (const pattern of rule.match?.paths || []) {
            // .gitignore-style files are line based. Never let a local rule
            // turn one catalog value into extra unmanaged exclude lines.
            if (!/[\r\n]/.test(pattern)) patterns.add(pattern);
        }
    }
    return [...patterns].sort();
}

// Default exclude patterns derived from the built-in catalog — a convenience
// for tests/inspection. Lazy + memoized so importing this module never triggers
// a rule-pack load (production callers derive patterns from their own engine
// rules via patternsForRules). Eager loading here would also make every command
// fail-closed on a corrupt rule pack, even commands that never exclude.
let cachedDefaultPatterns;
export function defaultPatterns() {
    if (!cachedDefaultPatterns) cachedDefaultPatterns = patternsForRules(loadRules());
    return cachedDefaultPatterns;
}

// applyExclude writes or refreshes the managed block. Idempotent.
export function applyExclude(file, patterns) {
    validatePatterns(patterns);
    return withLock(`${file}.aimhooman.lock`, () => {
        mkdirSync(dirname(file), { recursive: true });
        const existing = readExclude(file, '');
        let body = stripBlock(existing);
        if (body && !body.endsWith('\n')) body += '\n';
        const block = BEGIN + '\n' + patterns.join('\n') + '\n' + END + '\n';
        atomicWrite(file, body + block);
    });
}

// removeExclude strips the managed block, keeping other excludes.
export function removeExclude(file) {
    return withLock(`${file}.aimhooman.lock`, () => {
        const existing = readExclude(file, null);
        if (existing === null) return;
        atomicWrite(file, stripBlock(existing));
    });
}

export function inspectExclude(file, patterns) {
    const existing = readExclude(file, null);
    if (existing === null) {
        return { installed: false, current: false, missing: [...patterns] };
    }
    const range = managedRange(existing);
    if (!range) return { installed: false, current: false, missing: [...patterns] };
    const { start, end } = range;
    const actual = new Set(existing.slice(start + BEGIN.length, end).split('\n').map((s) => s.trim()).filter(Boolean));
    const missing = patterns.filter((pattern) => !actual.has(pattern));
    return { installed: true, current: missing.length === 0 && actual.size === patterns.length, missing };
}

// managedPatterns returns the pattern lines currently inside the managed
// block, or [] when the file or block is absent. Read-only.
export function managedPatterns(file) {
    const existing = readExclude(file, null);
    if (existing === null) return [];
    const range = managedRange(existing);
    if (!range) return [];
    return existing
        .slice(range.start + BEGIN.length, range.end)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}

function stripBlock(s) {
    const range = managedRange(s);
    if (!range) return s;
    const { start, end } = range;
    let before = s.slice(0, start).replace(/\n+$/, '');
    if (before) before += '\n';
    const rest = s.slice(end + END.length).replace(/^\n/, '');
    return before + rest;
}

function readExclude(file, missing) {
    try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`exclude path "${file}" must be a regular file`);
        }
        return readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return missing;
        throw error;
    }
}

function managedRange(value) {
    const start = value.indexOf(BEGIN);
    const firstEnd = value.indexOf(END);
    if (start < 0 && firstEnd < 0) return null;
    if (start < 0 || firstEnd < start + BEGIN.length) {
        throw new Error('managed exclude markers are malformed; repair the file by hand');
    }
    const nestedStart = value.indexOf(BEGIN, start + BEGIN.length);
    const nextEnd = value.indexOf(END, firstEnd + END.length);
    if (nestedStart >= 0 || nextEnd >= 0) {
        throw new Error('managed exclude markers appear more than once; repair the file by hand');
    }
    return { start, end: firstEnd };
}

function validatePatterns(patterns) {
    if (!Array.isArray(patterns) || patterns.some((pattern) => (
        typeof pattern !== 'string'
        || pattern.length === 0
        || /[\r\n]/.test(pattern)
        || pattern === BEGIN
        || pattern === END
    ))) {
        throw new TypeError('exclude patterns must be non-empty single-line strings');
    }
}
