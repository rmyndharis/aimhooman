import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGitPath } from './git-path.mjs';

const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const KINDS = new Set(['path', 'message', 'code']);
const ACTIONS = new Set(['allow', 'review', 'block']);
const AUTOFIXES = new Set(['remove-whole-line']);
const PROFILES = ['clean', 'strict', 'compliance'];
const RULE_FIELDS = new Set([
    'id', 'version', 'provider', 'category', 'confidence', 'kind', 'autofix',
    'match', 'actions', 'reason', 'remediation', 'references',
]);
const MAX_LOCAL_CONTENT_PATTERNS = 32;
const MAX_LOCAL_PATTERN_LENGTH = 512;
const MAX_LOCAL_PATTERN_TOTAL = 4096;
const MAX_LOCAL_PATH_PATTERNS = 32;
const MAX_LOCAL_GLOB_LENGTH = 512;
const MAX_LOCAL_GLOB_TOTAL = 4096;
export const MAX_LOCAL_MATCH_INPUT = 16_384;
const MAX_LOCAL_QUANTIFIERS = 16;

// RulePackError makes a loader failure actionable without requiring callers to
// parse a raw JSON/RegExp exception. `source` is either "builtin" or "local".
export class RulePackError extends Error {
    constructor(source, file, code, detail, cause) {
        const label = source === 'builtin' ? basename(file) : file;
        super(`${source} rule pack "${label}": ${detail}`);
        this.name = 'RulePackError';
        this.source = source;
        this.file = file;
        this.code = code;
        if (cause) this.cause = cause;
    }
}

// The name is retained for compatibility with existing internal callers. The
// returned matcher exposes RegExp's test() shape, but evaluates the glob with
// dynamic programming so repeated wildcards cannot trigger backtracking.
// Supports ** (any depth, including zero), * (within a segment), ? (one non-slash),
// and [class] character classes (POSIX [] for a literal ] member, e.g. []x]).
export function globToRegExp(glob) {
    const tokens = [];
    for (let i = 0; i < glob.length;) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    tokens.push({ type: 'globstar-slash' });
                    i += 3;
                    continue;
                }
                tokens.push({ type: 'globstar' });
                i += 2;
                continue;
            }
            tokens.push({ type: 'star' });
            i += 1;
            continue;
        }
        if (c === '?') {
            tokens.push({ type: 'any' });
            i += 1;
            continue;
        }
        if (c === '[') {
            let j = i + 1;
            if (glob[j] === '!') j += 1;
            // POSIX glob: a ] right after [ (or [!) is a literal member, not the
            // class closer, so []x] matches ] or x.
            if (glob[j] === ']') j += 1;
            const end = glob.indexOf(']', j);
            if (end < 0) {
                tokens.push({ type: 'literal', value: '[' });
                i += 1;
                continue;
            }
            let body = glob.slice(i + 1, end);
            if (body.startsWith('!')) body = '^' + body.slice(1);
            // Escape backslashes and ] in the class body so a trailing \ cannot
            // escape the closing ] (unterminated RegExp → whole local pack
            // rejected) and a literal ] member is unambiguous.
            const escaped = body.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
            tokens.push({ type: 'class', regexp: new RegExp(`^[${escaped}]$`) });
            i = end + 1;
            continue;
        }
        tokens.push({ type: 'literal', value: c });
        i += 1;
    }
    return Object.freeze({
        test(value) {
            return matchGlob(tokens, String(value));
        },
    });
}

function matchGlob(tokens, input) {
    let previous = new Uint8Array(input.length + 1);
    previous[0] = 1;
    for (const token of tokens) {
        const next = new Uint8Array(input.length + 1);
        if (token.type === 'star' || token.type === 'globstar') {
            for (let index = 0; index <= input.length; index++) {
                if (previous[index]) next[index] = 1;
                if (index < input.length && next[index]
                    && (token.type === 'globstar' || input[index] !== '/')) {
                    next[index + 1] = 1;
                }
            }
        } else if (token.type === 'globstar-slash') {
            let canStart = false;
            for (let index = 0; index <= input.length; index++) {
                if (previous[index]) next[index] = 1;
                if (index === 0) continue;
                if (previous[index - 1]) canStart = true;
                if (canStart && input[index - 1] === '/') next[index] = 1;
            }
        } else {
            for (let index = 0; index < input.length; index++) {
                if (!previous[index]) continue;
                const character = input[index];
                if ((token.type === 'literal' && character === token.value)
                    || (token.type === 'any' && character !== '/')
                    || (token.type === 'class' && token.regexp.test(character))) {
                    next[index + 1] = 1;
                }
            }
        }
        previous = next;
    }
    return previous[input.length] === 1;
}

// compileContent builds a RegExp from a rule pattern. JavaScript has no inline
// (?i) flag, so a leading "(?i)" is stripped and mapped to the 'i' flag.
function compileContent(pattern, context) {
    let flags = '';
    let src = pattern;
    if (src.startsWith('(?i)')) {
        flags = 'i';
        src = src.slice(4);
    }
    if (context.source === 'local') validateLocalPattern(src);
    return new RegExp(src, flags);
}

// Local expressions run inside Git hooks, so reject the common unbounded-work
// shapes before compiling them. Built-in packs are maintained with the package
// and are not subject to these compatibility limits.
function validateLocalPattern(pattern) {
    if (pattern.length > MAX_LOCAL_PATTERN_LENGTH) {
        throw new Error(`pattern exceeds ${MAX_LOCAL_PATTERN_LENGTH} characters`);
    }
    // Ignore escaped-backslash pairs first: `\\1` is a literal backslash + 1,
    // not a backreference. Only a backslash that survives on its own before a
    // digit/k< is a real backreference.
    const withoutEscapedBackslashes = pattern.replace(/\\\\/g, '');
    if (/\\(?:[1-9]|k<)/.test(withoutEscapedBackslashes)) {
        throw new Error('backreferences are not allowed in local patterns');
    }
    assertFlatLocalPattern(pattern);

    let inClass = false;
    let quantifiers = 0;
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\') {
            i += 1;
            continue;
        }
        if (inClass) {
            if (char === ']') inClass = false;
            continue;
        }
        if (char === '[') {
            inClass = true;
            continue;
        }
        const repeat = repeatAt(pattern, i);
        if (repeat) {
            quantifiers += 1;
            if (quantifiers > MAX_LOCAL_QUANTIFIERS) {
                throw new Error(`local patterns may contain at most ${MAX_LOCAL_QUANTIFIERS} quantifiers`);
            }
            // assertFlatLocalPattern already rejected groups, alternation, and
            // lookaround; the check below rejects every variable quantifier
            // (*, +, ?, {n,}, {n,m}). Only fixed {n} repeats survive, and fixed
            // repeats cannot backtrack. Local patterns are therefore restricted
            // to literals, character classes, and fixed {n} repeats.
            if (repeat.minimum !== repeat.maximum) {
                throw new Error('variable quantifiers are not allowed in local patterns; use a fixed {n} repeat');
            }
            if (Number.isFinite(repeat.maximum) && repeat.maximum > 1_000) {
                throw new Error('repeat bounds above 1000 are not allowed in local patterns');
            }
            i += repeat.length - 1;
            if (pattern[i + 1] === '?') i += 1;
        }
    }
}

// Local expressions use a flat subset whose work can be bounded by the atom
// and quantifier limits below. JavaScript cannot interrupt one RegExp match, so
// nested backtracking constructs are rejected instead of timed heuristically.
function assertFlatLocalPattern(pattern) {
    let inClass = false;
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '\\') {
            index += 1;
            continue;
        }
        if (inClass) {
            if (character === ']') inClass = false;
            continue;
        }
        if (character === '[') {
            inClass = true;
            continue;
        }
        if (character === '(' || character === ')' || character === '|') {
            throw new Error('groups, alternation, and lookaround are not allowed in local patterns');
        }
    }
}

function repeatAt(pattern, index) {
    const char = pattern[index];
    if (char === '*') return { length: 1, minimum: 0, maximum: Infinity };
    if (char === '+') return { length: 1, minimum: 1, maximum: Infinity };
    if (char === '?') return { length: 1, minimum: 0, maximum: 1 };
    if (char !== '{') return null;
    const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index));
    if (!match) return null;
    const maximum = match[2] === undefined
        ? Number(match[1])
        : match[2] === '' ? Infinity : Number(match[2]);
    return { length: match[0].length, minimum: Number(match[1]), maximum };
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(value, field, ruleLabel, required) {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value) || (required && value.length === 0)) {
        throw new Error(`${ruleLabel} ${field} must be ${required ? 'a non-empty' : 'an'} array of strings`);
    }
    if (value.some((item) => !nonEmptyString(item))) {
        throw new Error(`${ruleLabel} ${field} must contain only non-empty strings`);
    }
    return value;
}

function validateLocalPathPatterns(paths, except, label) {
    const patterns = [...paths, ...except];
    if (patterns.length > MAX_LOCAL_PATH_PATTERNS) {
        throw new Error(`${label} path scopes may contain at most ${MAX_LOCAL_PATH_PATTERNS} local globs`);
    }
    if (patterns.some((pattern) => pattern.length > MAX_LOCAL_GLOB_LENGTH)) {
        throw new Error(`${label} local globs may contain at most ${MAX_LOCAL_GLOB_LENGTH} characters`);
    }
    const total = patterns.reduce((sum, pattern) => sum + pattern.length, 0);
    if (total > MAX_LOCAL_GLOB_TOTAL) {
        throw new Error(`${label} path scopes exceed the ${MAX_LOCAL_GLOB_TOTAL}-character local limit`);
    }
}

function validateRule(rule, index, context) {
    const fallback = `rule at index ${index}`;
    if (!isObject(rule)) throw new Error(`${fallback} must be an object`);
    const label = nonEmptyString(rule.id) ? `rule "${rule.id}"` : fallback;
    const unknownRuleFields = Object.keys(rule).filter((field) => !RULE_FIELDS.has(field));
    if (unknownRuleFields.length) {
        throw new Error(`${label} has unsupported field${unknownRuleFields.length === 1 ? '' : 's'}: ${unknownRuleFields.join(', ')}`);
    }
    for (const field of ['id', 'provider', 'category', 'kind', 'reason']) {
        if (!nonEmptyString(rule[field])) throw new Error(`${label} ${field} must be a non-empty string`);
    }
    if (rule.version !== undefined && (!Number.isInteger(rule.version) || rule.version < 1)) {
        throw new Error(`${label} version must be a positive integer`);
    }
    if (rule.confidence !== undefined && !nonEmptyString(rule.confidence)) {
        throw new Error(`${label} confidence must be a non-empty string`);
    }
    if (!KINDS.has(rule.kind)) {
        throw new Error(`${label} kind must be one of: ${[...KINDS].join(', ')}`);
    }
    if (!isObject(rule.match)) throw new Error(`${label} match must be an object`);
    const matchFields = rule.kind === 'path'
        ? new Set(['paths', 'except', 'path_case'])
        : rule.kind === 'message'
            ? new Set(['content'])
            : new Set(['content', 'paths', 'except', 'path_case']);
    const unknownMatchFields = Object.keys(rule.match).filter((field) => !matchFields.has(field));
    if (unknownMatchFields.length) {
        throw new Error(`${label} match has unsupported field${unknownMatchFields.length === 1 ? '' : 's'}: ${unknownMatchFields.join(', ')}`);
    }
    if (rule.kind === 'path') {
        const paths = validateStringArray(rule.match.paths, 'match.paths', label, true);
        const except = validateStringArray(rule.match.except, 'match.except', label, false);
        validatePathCase(rule.match.path_case, label);
        if (context.source === 'local') validateLocalPathPatterns(paths, except, label);
    } else {
        const content = validateStringArray(rule.match.content, 'match.content', label, true);
        if (context.source === 'local') {
            if (content.length > MAX_LOCAL_CONTENT_PATTERNS) {
                throw new Error(`${label} match.content may contain at most ${MAX_LOCAL_CONTENT_PATTERNS} local patterns`);
            }
            const total = content.reduce((sum, pattern) => sum + pattern.length, 0);
            if (total > MAX_LOCAL_PATTERN_TOTAL) {
                throw new Error(`${label} match.content exceeds the ${MAX_LOCAL_PATTERN_TOTAL}-character local limit`);
            }
        }
        if (rule.kind === 'code') {
            const paths = validateStringArray(rule.match.paths, 'match.paths', label, false);
            const except = validateStringArray(rule.match.except, 'match.except', label, false);
            validatePathCase(rule.match.path_case, label);
            if (context.source === 'local') validateLocalPathPatterns(paths, except, label);
        }
    }
    if (!isObject(rule.actions)) throw new Error(`${label} actions must be an object`);
    const unknownActions = Object.keys(rule.actions).filter((field) => !PROFILES.includes(field));
    if (unknownActions.length) {
        throw new Error(`${label} actions has unsupported field${unknownActions.length === 1 ? '' : 's'}: ${unknownActions.join(', ')}`);
    }
    if (!PROFILES.some((profile) => rule.actions[profile] !== undefined)) {
        throw new Error(`${label} actions must define at least one supported profile`);
    }
    for (const profile of PROFILES) {
        if (rule.actions[profile] !== undefined && !ACTIONS.has(rule.actions[profile])) {
            throw new Error(`${label} actions.${profile} must be one of: ${[...ACTIONS].join(', ')}`);
        }
    }
    validateStringArray(rule.remediation, 'remediation', label, false);
    validateStringArray(rule.references, 'references', label, false);
    if (rule.autofix !== undefined) {
        if (!AUTOFIXES.has(rule.autofix)) {
            throw new Error(`${label} autofix must be one of: ${[...AUTOFIXES].join(', ')}`);
        }
        if (rule.kind !== 'message') {
            throw new Error(`${label} autofix is only valid for message rules`);
        }
        if (rule.confidence !== 'high' || rule.actions.clean !== 'block') {
            throw new Error(`${label} autofix requires high confidence and actions.clean=block`);
        }
        if (context.source !== 'builtin') {
            throw new Error(`${label} local rules cannot edit commit messages automatically`);
        }
        const exact = rule.match.content.every((pattern) => {
            const source = pattern.startsWith('(?i)') ? pattern.slice(4) : pattern;
            return source.startsWith('^') && source.endsWith('$');
        });
        if (!exact) throw new Error(`${label} autofix patterns must match a whole line`);
    }
}

function validatePathCase(value, label) {
    if (value !== undefined && value !== 'sensitive' && value !== 'insensitive') {
        throw new Error(`${label} match.path_case must be sensitive or insensitive`);
    }
}

// compileRule validates and precomputes regexps without mutating the parsed pack.
function compileRule(rule, index, context) {
    try {
        validateRule(rule, index, context);
    } catch (error) {
        throw new RulePackError(context.source, context.file, 'INVALID_SCHEMA', error.message, error);
    }
    const compiled = { ...rule, match: { ...rule.match }, source: context.source };
    try {
        compiled.pathCaseInsensitive = rule.match.path_case === 'insensitive';
        const pathPattern = (value) => (
            compiled.pathCaseInsensitive ? value.toLowerCase() : value
        );
        compiled.pathRes = (rule.match.paths || []).map((value) => globToRegExp(pathPattern(value)));
        compiled.exceptRes = (rule.match.except || []).map((value) => globToRegExp(pathPattern(value)));
        compiled.contentRes = (rule.match.content || []).map((pattern) => compileContent(pattern, context));
    } catch (error) {
        throw new RulePackError(
            context.source,
            context.file,
            'INVALID_REGEX',
            `rule "${rule.id}" has an invalid pattern: ${error.message}`,
            error
        );
    }
    return compiled;
}

function readPack(file, source, knownIds) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new RulePackError(source, file, 'READ_ERROR', `cannot read file: ${error.message}`, error);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new RulePackError(source, file, 'INVALID_JSON', `invalid JSON: ${error.message}`, error);
    }
    if (!Array.isArray(parsed)) {
        throw new RulePackError(source, file, 'INVALID_SCHEMA', 'pack must be a JSON array');
    }

    // Compile into a temporary list so one bad rule rejects the entire pack.
    const compiled = parsed.map((rule, index) => compileRule(rule, index, { source, file }));
    const packIds = new Set();
    for (const rule of compiled) {
        if (knownIds.has(rule.id) || packIds.has(rule.id)) {
            throw new RulePackError(
                source,
                file,
                'DUPLICATE_RULE_ID',
                `duplicate rule id "${rule.id}"`
            );
        }
        packIds.add(rule.id);
    }
    return compiled;
}

function appendPack(rules, knownIds, file, source) {
    const compiled = readPack(file, source, knownIds);
    for (const rule of compiled) {
        knownIds.add(rule.id);
        rules.push(rule);
    }
}

function localRuleFiles(stateDir) {
    if (!stateDir) return { files: [], error: null };
    const dir = join(stateDir, 'rules');
    try {
        return {
            files: readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => join(dir, file)),
            error: null,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return { files: [], error: null };
        return {
            files: [],
            error: new RulePackError('local', dir, 'READ_ERROR', `cannot read directory: ${error.message}`, error),
        };
    }
}

// Loads valid rules and reports malformed local packs separately. Built-in
// failures remain fatal because there is no trustworthy engine without them.
export function loadRulesWithDiagnostics(stateDir) {
    const rules = [];
    const errors = [];
    const knownIds = new Set();
    for (const file of readdirSync(RULES_DIR).filter((file) => file.endsWith('.json')).sort()) {
        appendPack(rules, knownIds, join(RULES_DIR, file), 'builtin');
    }
    const local = localRuleFiles(stateDir);
    if (local.error) errors.push(local.error);
    for (const file of local.files) {
        try {
            appendPack(rules, knownIds, file, 'local');
        } catch (error) {
            errors.push(error instanceof RulePackError
                ? error
                : new RulePackError('local', file, 'UNKNOWN_ERROR', error.message, error));
        }
    }
    return { rules, errors };
}

// Compatibility API: callers that have not opted into diagnostics still get
// the original all-or-error behavior.
export function loadRules(stateDir) {
    const result = loadRulesWithDiagnostics(stateDir);
    if (result.errors.length) throw result.errors[0];
    return result.rules;
}

export function actionFor(rule, profile) {
    return rule.actions[profile] || rule.actions.clean || 'review';
}

export function matchesPath(rule, p) {
    const candidate = rule.pathCaseInsensitive ? p.toLowerCase() : p;
    if (!rule.pathRes.some((re) => re.test(candidate))) return false;
    return !rule.exceptRes.some((re) => re.test(candidate));
}

export function matchesContent(rule, line, path) {
    if (rule.kind === 'code') {
        const normalized = normalizeGitPath(path);
        const candidate = rule.pathCaseInsensitive ? normalized.toLowerCase() : normalized;
        if (rule.pathRes.length && !rule.pathRes.some((re) => re.test(candidate))) return false;
        if (rule.exceptRes.some((re) => re.test(candidate))) return false;
    }
    const input = String(line);
    if (rule.source === 'local' && input.length > MAX_LOCAL_MATCH_INPUT) return false;
    return rule.contentRes.some((re) => re.test(input));
}
