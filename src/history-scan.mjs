import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRevisionError, gitBuf, parseRawDiff } from './gitx.mjs';
import { gitEnvironment, GIT_TIMEOUT_MS } from './git-environment.mjs';

export const EMPTY_HISTORY_OID = '0'.repeat(40);

// History scans stream whole-commit diffs and trees, which can outgrow gitx's
// 64 MiB staged-view default, so every wrapper here widens maxBuffer.
const HISTORY_MAX_BUFFER = 128 * 1024 * 1024;

function gitBuffer(repo, args, input) {
    return gitBuf(args, repo.root, input, HISTORY_MAX_BUFFER);
}

function gitString(repo, args) {
    return gitBuffer(repo, args).toString('utf8').trim();
}

// Not folded into gitString: encoding 'utf8' makes a failed spawn throw with
// string (not Buffer) stdout/stderr, and collapsing the two would change that
// error shape for callers that wrap and rethrow it.
function gitStringQuiet(repo, args) {
    return execFileSync('git', args, {
        cwd: repo.root,
        env: gitEnvironment(),
        encoding: 'utf8',
        maxBuffer: HISTORY_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

// Deliberately stricter than gitx's assertRevision: history revisions arrive
// from the command line, so control characters are rejected as well.
function assertRevision(value, label) {
    if (typeof value !== 'string' || !value || value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} must be a non-empty Git revision`);
    }
}

export function parseHistoryRange(value) {
    assertRevision(value, 'range');
    const match = /^(.+?)(\.\.\.?)(.+)$/.exec(value);
    if (!match || match[1].includes('..') || match[3].includes('..')) {
        throw new TypeError('range must contain both endpoints exactly once, for example base..head');
    }
    const [, base, operator, head] = match;
    assertRevision(base, 'range base');
    assertRevision(head, 'range head');
    return { base, head, operator };
}

export function resolveCommit(repo, revision) {
    assertRevision(revision, 'commit');
    let commit;
    try {
        commit = gitStringQuiet(repo, [
            'rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`,
        ]);
    } catch (error) {
        if (error?.status === 1) {
            throw new GitRevisionError(revision, 'does not resolve to a commit', error);
        }
        throw error;
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
        throw new GitRevisionError(revision, 'Git returned an invalid commit object ID');
    }
    return commit;
}

export function commitMessage(repo, revision, resolvedCommit) {
    const commit = resolvedCommit || resolveCommit(repo, revision);
    const object = gitBuffer(repo, ['cat-file', 'commit', commit]);
    const separator = object.indexOf(Buffer.from('\n\n'));
    return {
        commit,
        message: separator < 0 ? '' : object.subarray(separator + 2).toString('utf8'),
    };
}

export function commitParents(repo, revision) {
    const commit = resolveCommit(repo, revision);
    const line = gitString(repo, ['rev-list', '--parents', '-n', '1', commit]);
    const [, ...parents] = line.split(' ');
    return { commit, parents, shallowBoundary: isShallowBoundary(repo, commit) };
}

export function commitChanges(repo, revision, resolvedCommit, resolvedParents) {
    // `resolvedParents || []` conflated "omitted" with "root commit": a merge
    // passed via the 3-arg form would diff against nothing and silently scan as
    // empty. Re-derive parents when the caller passed a commit but no parents.
    const { commit, parents } = resolvedCommit
        ? { commit: resolvedCommit, parents: resolvedParents ?? commitParents(repo, revision).parents }
        : commitParents(repo, revision);
    const comparisons = parents.length ? parents : [null];
    const grouped = new Map();

    for (const parent of comparisons) {
        const args = [
            'diff-tree', '--no-commit-id', '--raw', '--no-abbrev', '-r', '-z',
            '--find-renames', '--diff-filter=ACMRTD',
        ];
        if (!parent) args.push('--root', commit);
        else args.push(parent, commit);
        args.push('--');
        for (const entry of parseCommitDiff(gitBuffer(repo, args))) {
            const key = [entry.path, entry.sourcePath || '', entry.oid || '', entry.mode || '', entry.status].join('\0');
            const current = grouped.get(key);
            if (current) {
                if (parent && !current.parents.includes(parent)) current.parents.push(parent);
            } else {
                grouped.set(key, {
                    ...entry,
                    commit,
                    parents: parent ? [parent] : [],
                });
            }
        }
    }

    const entries = [...grouped.values()].sort(compareEntries);
    const sizes = objectSizes(repo, entries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid));
    for (const entry of entries) entry.size = entry.type === 'blob' ? sizes.get(entry.oid) ?? null : null;
    return {
        commit,
        parents,
        entries,
    };
}

export function commitSnapshot(repo, revision) {
    const { commit, parents, shallowBoundary } = commitParents(repo, revision);
    const records = gitBuffer(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--'])
        .toString('utf8').split('\0').filter(Boolean);
    const entries = records.map((record) => {
        const tab = record.indexOf('\t');
        const match = /^(\d+) (\w+) ([0-9a-f]+)$/.exec(record.slice(0, tab));
        if (tab < 0 || !match) throw new Error('unexpected output from git ls-tree');
        return {
            mode: match[1],
            type: match[2],
            oid: match[3],
            path: record.slice(tab + 1),
            status: 'S',
            commit,
            parents,
        };
    });
    const sizes = objectSizes(repo, entries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid));
    for (const entry of entries) entry.size = entry.type === 'blob' ? sizes.get(entry.oid) ?? null : null;
    const { message } = commitMessage(repo, commit, commit);
    const changes = commitChanges(repo, commit, commit, parents).entries;
    return { commit, parents, shallowBoundary, message, entries, changes };
}

export function historyRange(repo, value) {
    const parsed = parseHistoryRange(value);
    const bootstrap = isZeroObjectId(parsed.base);
    const baseCommit = bootstrap ? parsed.base : resolveCommit(repo, parsed.base);
    const headCommit = resolveCommit(repo, parsed.head);
    let scanBase = baseCommit;
    if (!bootstrap && parsed.operator === '...') {
        try {
            scanBase = gitStringQuiet(repo, ['merge-base', baseCommit, headCommit]);
        } catch (error) {
            if (error?.status === 1) {
                throw new GitRevisionError(value, 'range endpoints do not share a merge base', error);
            }
            throw error;
        }
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(scanBase)) {
            throw new GitRevisionError(value, 'Git returned an invalid merge base');
        }
    }
    const revision = bootstrap ? headCommit : `${scanBase}..${headCommit}`;
    const lines = gitString(repo, ['rev-list', '--reverse', '--topo-order', '--parents', revision]);
    // rev-list --parents emits "<commit> <parent1> <parent2> ..." per line, so
    // each commit's parents arrive with the walk at no extra cost. Commit bodies
    // (changes, message) are fetched lazily by the scanner per commit rather
    // than held in memory for the whole range up front.
    const commits = lines ? lines.split('\n').map((line) => {
        const [commit, ...parents] = line.split(' ');
        return { commit, parents };
    }) : [];
    // A shallow clone (e.g. CI fetch-depth: 1) may not contain every commit in
    // the range, so completeness cannot be proven. Callers warn or fail closed.
    const shallow = gitStringQuiet(repo, ['rev-parse', '--is-shallow-repository']) === 'true';
    const reversed = !bootstrap
        && baseCommit !== headCommit
        && commits.length === 0
        && isAncestor(repo, headCommit, scanBase);
    return {
        input: value,
        operator: parsed.operator,
        base: baseCommit,
        scanBase,
        head: headCommit,
        bootstrap,
        shallow,
        reversed,
        commits,
    };
}

function isShallowBoundary(repo, commit) {
    if (gitStringQuiet(repo, ['rev-parse', '--is-shallow-repository']) !== 'true') return false;
    let contents;
    try {
        contents = readFileSync(join(repo.commonDir, 'shallow'), 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('Git reports a shallow repository but its shallow boundary file is missing', {
                cause: error,
            });
        }
        throw error;
    }
    return contents.split(/\r?\n/).includes(commit);
}

function isAncestor(repo, ancestor, descendant) {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
            cwd: repo.root,
            env: gitEnvironment(),
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: GIT_TIMEOUT_MS,
        });
        return true;
    } catch (error) {
        if (error?.status === 1) return false;
        throw error;
    }
}

function isZeroObjectId(value) {
    return /^(?:0{40}|0{64})$/.test(value);
}

// The raw-diff grammar parser is shared with gitx. Entries here additionally
// start with size: null, which commitChanges backfills with real blob sizes
// from one batched cat-file per commit.
function parseCommitDiff(buffer) {
    return parseRawDiff(buffer, 'diff-tree').map((entry) => ({ ...entry, size: null }));
}

function objectSizes(repo, objectIds) {
    const unique = [...new Set(objectIds)];
    if (!unique.length) return new Map();
    const lines = gitBuffer(
        repo,
        ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
        Buffer.from(unique.join('\n') + '\n'),
    ).toString('utf8').trimEnd().split('\n');
    const sizes = new Map();
    for (let index = 0; index < unique.length; index++) {
        const fields = (lines[index] || '').split(' ');
        if (fields[1] === 'blob' && /^\d+$/.test(fields[2])) sizes.set(unique[index], Number(fields[2]));
    }
    return sizes;
}

function compareEntries(left, right) {
    return compareText(left.path, right.path)
        || compareText(String(left.oid), String(right.oid))
        || compareText(left.status, right.status);
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
