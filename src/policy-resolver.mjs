import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBlob, readCommitPath, readStagedPath } from './gitx.mjs';
import { loadConfig, parseProjectPolicy, ProjectPolicyError } from './state.mjs';

const POLICY_PATH = '.aimhooman.json';
const PROFILES = new Set(['clean', 'strict', 'compliance']);

class PolicyTargetError extends Error {
    constructor(detail) {
        super(`policy target: ${detail}`);
        this.name = 'PolicyTargetError';
    }
}

export class PolicyProfileError extends Error {
    constructor(requested, required, invalid = false) {
        super(invalid
            ? `explicit profile "${requested}" must be clean, strict, or compliance`
            : (
                `explicit profile "${requested}" cannot lower target profile "${required}"; ` +
                'it may only match the target or escalate it to strict'
            ));
        this.name = 'PolicyProfileError';
        this.requested = requested;
        this.required = required;
    }
}

// resolvePolicy takes exactly one canonical option shape:
//   { target: 'worktree' | 'staged' | 'commit', revision?, profile?, strictFloor? }
// with `revision` required for (and only for) a commit target, `profile` an
// explicit profile that may only match or escalate to strict, and `strictFloor`
// the floor's source string when a floor applies. Every internal caller spells
// the call this way; alternate spellings once accepted here were dead
// flexibility that added branches to test without adding capability.
export function resolvePolicy(repo, options = {}) {
    if (!repo?.root || !repo?.stateDir) {
        throw new TypeError('repo must be an open repository');
    }
    const { target = 'worktree', revision, profile, strictFloor } = options;
    let resolved;
    if (target === 'worktree') {
        resolved = resolveWorktreePolicy(repo);
    } else if (target === 'staged') {
        resolved = resolveGitPolicy(repo, readStagedPath(repo, POLICY_PATH), 'staged-policy');
    } else if (target === 'commit') {
        if (typeof revision !== 'string' || !revision) {
            throw new PolicyTargetError('commit target needs a revision');
        }
        resolved = resolveGitPolicy(
            repo,
            readCommitPath(repo, revision, POLICY_PATH),
            'commit-policy',
        );
    } else {
        throw new PolicyTargetError('must be worktree, staged, or commit');
    }

    if (strictFloor) {
        if (typeof strictFloor !== 'string') {
            throw new TypeError('strictFloor must be the floor source string');
        }
        resolved = applyStrictFloor(resolved, strictFloor);
    }
    return applyExplicitProfile(resolved, profile);
}

export function applyExplicitProfile(resolved, explicitProfile) {
    if (explicitProfile === undefined || explicitProfile === null || explicitProfile === '') {
        return resolved;
    }
    if (!PROFILES.has(explicitProfile)) {
        throw new PolicyProfileError(explicitProfile, resolved.profile, true);
    }
    if (explicitProfile === resolved.profile) return resolved;
    if (explicitProfile !== 'strict') {
        throw new PolicyProfileError(explicitProfile, resolved.profile);
    }
    return {
        ...resolved,
        profile: 'strict',
        source: `${resolved.source}+explicit-strict`,
    };
}

export function applyStrictFloor(resolved, source = 'strict-floor') {
    if (resolved.profile === 'strict') return resolved;
    if (typeof source !== 'string' || !source) {
        throw new TypeError('strict floor source must be a non-empty string');
    }
    return { ...resolved, profile: 'strict', source };
}

function resolveWorktreePolicy(repo) {
    const file = join(repo.root, POLICY_PATH);
    let stat;
    try {
        stat = lstatSync(file);
    } catch (error) {
        if (error?.code === 'ENOENT') return localFallback(repo, 'worktree');
        throw new ProjectPolicyError(file, `cannot inspect file: ${error.message}`, error);
    }
    if (!stat.isFile()) {
        throw new ProjectPolicyError(file, 'must be a regular file, not a symlink or special file');
    }
    let content;
    try {
        content = readFileSync(file);
    } catch (error) {
        throw new ProjectPolicyError(file, `cannot read file: ${error.message}`, error);
    }
    const policy = parseProjectPolicy(content.toString('utf8'), file);
    return {
        profile: policy.profile,
        source: 'worktree-policy',
        target: 'worktree',
        policy_object_id: hashBlob(repo, content),
        policy_mode: '100644',
    };
}

function resolveGitPolicy(repo, result, source) {
    if (result.status === 'missing') return localFallback(repo, result.target);
    if (!['100644', '100755'].includes(result.mode)) {
        throw new ProjectPolicyError(
            `${result.target}:${POLICY_PATH}`,
            `must be a regular Git file, not mode ${result.mode || 'unknown'}`,
        );
    }
    const policy = parseProjectPolicy(
        result.content.toString('utf8'),
        `${result.target}:${POLICY_PATH}`,
    );
    return {
        profile: policy.profile,
        source,
        target: result.target,
        policy_object_id: result.oid,
        policy_mode: result.mode,
    };
}

function localFallback(repo, target) {
    const config = loadConfig(repo.stateDir);
    return {
        profile: config.profile,
        source: config.source,
        target,
        policy_object_id: null,
        policy_mode: null,
    };
}

