import {
    lstatSync,
    mkdirSync,
    readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { normalizeGitPath } from './git-path.mjs';

// Per-repository state, stored in the common Git dir (never the worktree).

const PROFILES = new Set(['clean', 'strict', 'compliance']);
const OVERRIDE_SCOPES = new Set([
    'path', 'rule', 'reviewed-instruction', 'reviewed-policy-file', 'policy-migration',
]);
const OVERRIDE_FIELDS = new Set([
    'target', 'scope', 'reason', 'actor', 'at', 'head', 'transition', 'oldObjectId', 'newObjectId', 'newMode',
]);
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REVIEWED_MODE = /^(?:100644|100755)$/;
const RFC3339_DATE_TIME = new RegExp(
    '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])'
    + 't(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?'
    + '(?:z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$',
    'i',
);

export class ProjectPolicyError extends Error {
    constructor(file, detail, cause) {
        super(`project policy "${file}": ${detail}`);
        this.name = 'ProjectPolicyError';
        this.file = file;
        if (cause) this.cause = cause;
    }
}

export class LocalConfigError extends Error {
    constructor(file, detail, cause) {
        super(`local config "${file}": ${detail}`);
        this.name = 'LocalConfigError';
        this.file = file;
        if (cause) this.cause = cause;
    }
}

export class LocalOverridesError extends Error {
    constructor(file, detail, cause) {
        super(`local overrides "${file}": ${detail}`);
        this.name = 'LocalOverridesError';
        this.file = file;
        if (cause) this.cause = cause;
    }
}

export function loadProjectPolicy(root) {
    if (!root) return null;
    const file = join(root, '.aimhooman.json');
    let stat;
    try {
        stat = lstatSync(file);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new ProjectPolicyError(file, `cannot inspect file: ${error.message}`, error);
    }
    if (!stat.isFile()) {
        throw new ProjectPolicyError(file, 'must be a regular file, not a symlink or special file');
    }
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new ProjectPolicyError(file, `cannot read file: ${error.message}`, error);
    }
    return parseProjectPolicy(text, file);
}

// Strip a single leading UTF-8 BOM: Node's utf8 decoder keeps it, and
// JSON.parse rejects it with a misleading "invalid JSON" syntax error.
function stripBom(text) {
    return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function parseProjectPolicy(text, file = '.aimhooman.json') {
    let policy;
    try {
        policy = JSON.parse(stripBom(text));
    } catch (error) {
        throw new ProjectPolicyError(file, `invalid JSON: ${error.message}`, error);
    }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new ProjectPolicyError(file, 'root must be a JSON object');
    }
    const unknown = Object.keys(policy).filter((key) => !['schema_version', 'profile'].includes(key));
    if (unknown.length) {
        throw new ProjectPolicyError(file, `unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    }
    if (policy.schema_version !== 1) {
        throw new ProjectPolicyError(file, 'schema_version must be 1');
    }
    if (!PROFILES.has(policy.profile)) {
        throw new ProjectPolicyError(file, 'profile must be clean, strict, or compliance');
    }
    return { schemaVersion: 1, profile: policy.profile, file };
}

export function loadConfig(stateDir, root) {
    const project = loadProjectPolicy(root);
    if (project) return { profile: project.profile, source: 'project', file: project.file };
    const file = join(stateDir, 'config.json');
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { profile: 'clean', source: 'default' };
        throw new LocalConfigError(file, `cannot read file: ${error.message}`, error);
    }
    let config;
    try {
        config = JSON.parse(stripBom(text));
    } catch (error) {
        throw new LocalConfigError(file, `invalid JSON: ${error.message}`, error);
    }
    const normalized = normalizeLocalConfig(config, file);
    return {
        profile: normalized.profile,
        source: 'local',
        file,
        ...(normalized.gitignore ? { gitignore: normalized.gitignore } : {}),
    };
}

export function saveConfig(stateDir, config) {
    const file = join(stateDir, 'config.json');
    const normalized = normalizeLocalConfig(config, file);
    atomicWriteJson(file, {
        schema_version: 1,
        profile: normalized.profile,
        ...(normalized.gitignore ? { gitignore: normalized.gitignore } : {}),
    });
}

function normalizeLocalConfig(config, file) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new LocalConfigError(file, 'root must be a JSON object');
    }
    const unknown = Object.keys(config).filter((key) => !['schema_version', 'profile', 'gitignore'].includes(key));
    if (unknown.length) {
        throw new LocalConfigError(file, `unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    }
    // Unversioned files written by pre-release builds remain readable. Every
    // subsequent save writes schema_version=1, while unknown/future versions
    // fail closed instead of being interpreted under the wrong contract.
    if (config.schema_version !== undefined && config.schema_version !== 1) {
        throw new LocalConfigError(file, 'schema_version must be 1');
    }
    if (!PROFILES.has(config.profile)) {
        throw new LocalConfigError(file, 'profile must be clean, strict, or compliance');
    }
    const gitignore = normalizeGitignoreConfig(config.gitignore, file);
    return { profile: config.profile, ...(gitignore ? { gitignore } : {}) };
}

// The gitignore field records an `init --gitignore` opt-in for this clone:
// enabled says the worktree .gitignore carries our managed block, created says
// the file did not exist before we wrote it (so uninstall may delete a file we
// introduced once the block leaves it empty). It stays out of the project
// policy on purpose — whether this clone created its .gitignore is per-clone
// state, never team policy. Absent means disabled, and a disabled record
// normalizes away so the two spellings cannot drift apart.
function normalizeGitignoreConfig(value, file) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new LocalConfigError(file, 'gitignore must be an object');
    }
    const unknown = Object.keys(value).filter((key) => !['enabled', 'created'].includes(key));
    if (unknown.length) {
        throw new LocalConfigError(file, `gitignore has unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    }
    for (const field of ['enabled', 'created']) {
        if (typeof value[field] !== 'boolean') {
            throw new LocalConfigError(file, `gitignore.${field} must be a boolean`);
        }
    }
    return value.enabled ? { enabled: true, created: value.created } : undefined;
}

export function loadOverrides(stateDir) {
    const file = join(stateDir, 'overrides.json');
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { allow: [], deny: [] };
        throw new LocalOverridesError(file, `cannot read file: ${error.message}`, error);
    }
    return parseOverrides(text, file);
}

export function saveOverrides(stateDir, overrides) {
    const file = join(stateDir, 'overrides.json');
    const normalized = normalizeOverrides(overrides, file);
    atomicWriteJson(file, { schema_version: 1, ...normalized });
}

export function normalizeOverrideTarget(target) {
    if (typeof target !== 'string') return '';
    return normalizeGitPath(target);
}

function parseOverrides(text, file) {
    let value;
    try {
        value = JSON.parse(stripBom(text));
    } catch (error) {
        throw new LocalOverridesError(file, `invalid JSON: ${error.message}`, error);
    }
    return normalizeOverrides(value, file);
}

function normalizeOverrides(value, file) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new LocalOverridesError(file, 'root must be a JSON object');
    }
    const unknown = Object.keys(value).filter((key) => !['schema_version', 'allow', 'deny'].includes(key));
    if (unknown.length) {
        throw new LocalOverridesError(file, `unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    }
    // Older local files had no schema_version. Reads keep that compatibility;
    // saveOverrides always rewrites the canonical versioned form.
    if (value.schema_version !== undefined && value.schema_version !== 1) {
        throw new LocalOverridesError(file, 'schema_version must be 1');
    }
    const dropped = { count: 0 };
    const normalized = {
        allow: overrideEntries(value.allow, 'allow', file, dropped),
        deny: overrideEntries(value.deny, 'deny', file, dropped),
    };
    if (dropped.count) {
        process.stderr.write(
            `aimhooman: warning: ${file}: dropped ${dropped.count} override(s) with retired scope "secret-path"; built-in secret scanning was removed in v0.3.0\n`
        );
    }
    return normalized;
}

function overrideEntries(value, key, file, dropped = { count: 0 }) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new LocalOverridesError(file, `${key} must be an array`);
    }
    return value.map((entry, index) => {
        // Built-in secret scanning and its secret-path override scope were
        // removed in v0.3.0. An overrides file written by an older version may
        // still carry such entries; drop them (one warning per file, below)
        // instead of failing the whole load.
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.scope === 'secret-path') {
            dropped.count += 1;
            return null;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new LocalOverridesError(file, `${key}[${index}] must be an object`);
        }
        const unknown = Object.keys(entry).filter((field) => !OVERRIDE_FIELDS.has(field));
        if (unknown.length) {
            throw new LocalOverridesError(
                file,
                `${key}[${index}] has unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
            );
        }
        const target = normalizeOverrideTarget(entry.target);
        if (!target) {
            throw new LocalOverridesError(file, `${key}[${index}].target must be a non-empty string`);
        }
        const scope = entry.scope;
        if (scope !== undefined && !OVERRIDE_SCOPES.has(scope)) {
            throw new LocalOverridesError(file, `${key}[${index}].scope is unsupported`);
        }
        if (key === 'deny' && scope !== undefined && !['path', 'rule'].includes(scope)) {
            throw new LocalOverridesError(file, `${key}[${index}].scope ${scope} is only valid for allow entries`);
        }
        for (const field of ['reason', 'actor', 'at', 'transition']) {
            if (entry[field] !== undefined && typeof entry[field] !== 'string') {
                throw new LocalOverridesError(file, `${key}[${index}].${field} must be a string`);
            }
        }
        if (entry.at !== undefined && !isRfc3339DateTime(entry.at)) {
            throw new LocalOverridesError(file, `${key}[${index}].at must be an RFC3339 date-time`);
        }
        for (const field of ['head', 'oldObjectId']) {
            if (entry[field] !== undefined && !OBJECT_ID.test(entry[field])) {
                throw new LocalOverridesError(file, `${key}[${index}].${field} must be a full Git object ID`);
            }
        }
        if (entry.newObjectId !== undefined && entry.newObjectId !== null && !OBJECT_ID.test(entry.newObjectId)) {
            throw new LocalOverridesError(file, `${key}[${index}].newObjectId must be a full Git object ID or null`);
        }
        if (entry.newMode !== undefined && entry.newMode !== null && !REVIEWED_MODE.test(entry.newMode)) {
            throw new LocalOverridesError(file, `${key}[${index}].newMode must be a regular-file Git mode or null`);
        }
        validateOverrideBinding(entry, key, index, file);
        // Entries written before scoped overrides did not carry a scope. Keep
        // that distinction so the engine can infer rule IDs from its catalog;
        // treating every legacy entry as a path changes existing policy.
        const normalized = { ...entry, target };
        for (const field of ['head', 'oldObjectId', 'newObjectId']) {
            if (typeof normalized[field] === 'string') normalized[field] = normalized[field].toLowerCase();
        }
        if (normalized.transition !== 'staged' && typeof normalized.transition === 'string') {
            normalized.transition = normalized.transition.toLowerCase();
        }
        return normalized;
    }).filter((entry) => entry !== null);
}

function isRfc3339DateTime(value) {
    if (!RFC3339_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) return false;
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!date) return false;
    const year = Number(date[1]);
    const month = Number(date[2]);
    const day = Number(date[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
}

function validateOverrideBinding(entry, key, index, file) {
    const label = `${key}[${index}]`;
    const scope = entry.scope;
    const has = (field) => Object.prototype.hasOwnProperty.call(entry, field);
    const reviewFields = ['head', 'transition', 'oldObjectId', 'newObjectId', 'newMode'];

    if (scope === 'reviewed-instruction' || scope === 'reviewed-policy-file') {
        for (const field of ['head', 'transition', 'newObjectId', 'newMode']) {
            if (!has(field)) {
                throw new LocalOverridesError(file, `${label}.${field} is required for ${scope}`);
            }
        }
        if (entry.transition !== 'staged' && !OBJECT_ID.test(entry.transition)) {
            throw new LocalOverridesError(
                file,
                `${label}.transition must be "staged" or a full Git object ID for ${scope}`,
            );
        }
        if (entry.newObjectId !== null && !OBJECT_ID.test(entry.newObjectId || '')) {
            throw new LocalOverridesError(
                file,
                `${label}.newObjectId must be a full Git blob ID or null for ${scope}`,
            );
        }
        if ((entry.newObjectId === null) !== (entry.newMode === null)) {
            throw new LocalOverridesError(
                file,
                `${label}.newObjectId and .newMode must both describe a blob or both be null for ${scope}`,
            );
        }
        for (const field of ['oldObjectId']) {
            if (has(field)) {
                throw new LocalOverridesError(file, `${label}.${field} is only valid for policy-migration`);
            }
        }
        return;
    }

    if (scope === 'policy-migration') {
        if (key !== 'allow') {
            throw new LocalOverridesError(file, `${label}.scope policy-migration is only valid for allow entries`);
        }
        if (normalizeOverrideTarget(entry.target) !== '.aimhooman.json') {
            throw new LocalOverridesError(file, `${label}.target must be .aimhooman.json for policy-migration`);
        }
        for (const field of ['head', 'transition', 'oldObjectId', 'newObjectId', 'newMode']) {
            if (!has(field)) {
                throw new LocalOverridesError(file, `${label}.${field} is required for policy-migration`);
            }
        }
        if (entry.transition !== 'staged' && !OBJECT_ID.test(entry.transition)) {
            throw new LocalOverridesError(
                file,
                `${label}.transition must be "staged" or a full Git object ID`,
            );
        }
        if ((entry.newObjectId === null) !== (entry.newMode === null)) {
            throw new LocalOverridesError(
                file,
                `${label}.newObjectId and .newMode must both describe a blob or both be null for policy-migration`,
            );
        }
        return;
    }

    for (const field of reviewFields) {
        if (has(field)) {
            throw new LocalOverridesError(file, `${label}.${field} requires a review-bound scope`);
        }
    }
}

function atomicWriteJson(file, value) {
    let text;
    try {
        text = JSON.stringify(value, null, 2) + '\n';
    } catch (error) {
        throw new TypeError(`cannot serialize "${file}": ${error.message}`, { cause: error });
    }

    mkdirSync(dirname(file), { recursive: true });
    atomicWrite(file, text);
}
