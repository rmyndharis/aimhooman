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
    const reincluded = new Set();
    for (const rule of rules || []) {
        if (rule.kind !== 'path' || !AUTO_EXCLUDE_CATEGORIES.has(rule.category)) continue;
        const actions = rule.actions || {};
        if (['clean', 'strict', 'compliance'].some((p) => actions[p] !== 'block')) continue;
        // .gitignore-style files are line based. Never let a local rule
        // turn one catalog value into extra unmanaged exclude lines.
        const lines = (values) => (values || []).filter((pattern) => !/[\r\n]/.test(pattern));
        // Git applies a `!` line to the whole file, so an exception may only
        // reach inside the rule's own directory (`dir/**`); a rule whose
        // exception reaches further would re-include other rules' artifacts.
        const scopes = lines(rule.match?.paths).filter((p) => p.endsWith('/**')).map((p) => p.slice(0, -2));
        if (lines(rule.match?.except).some((e) => !scopes.some((scope) => e.startsWith(scope) && e !== scope))) continue;
        for (const pattern of lines(rule.match?.paths)) patterns.add(pattern);
        // An exception becomes a `!` line. Git re-includes nothing below an
        // excluded directory, so `dir/**` also re-includes `dir/` itself.
        for (const pattern of lines(rule.match?.except)) {
            if (pattern.endsWith('/**')) reincluded.add(`!${pattern.slice(0, -2)}`);
            reincluded.add(`!${pattern}`);
        }
    }
    // Git applies the last matching line, so every `!` line follows the excludes.
    return [...[...patterns].sort(), ...[...reincluded].sort()];
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

// applyExclude writes or refreshes the managed block. Idempotent. A refresh
// rewrites the block where it stands: Git applies the last matching line, so
// a user's `!` negation below the block stops working if the block moves past it.
export function applyExclude(file, patterns) {
    validatePatterns(patterns);
    return withLock(`${file}.aimhooman.lock`, () => {
        mkdirSync(dirname(file), { recursive: true });
        const existing = readExclude(file, '');
        const block = BEGIN + '\n' + patterns.join('\n') + '\n' + END + '\n';
        const range = managedRange(existing);
        if (range) {
            const rest = existing.slice(range.end + END.length).replace(/^\n/, '');
            atomicWrite(file, existing.slice(0, range.start) + block + rest);
            return;
        }
        const body = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
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
