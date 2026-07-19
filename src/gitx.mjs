import { execFileSync } from 'node:child_process';
import {
    cpSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gitEnvironment, GIT_TIMEOUT_MS } from './git-environment.mjs';

export class GitRevisionError extends Error {
    constructor(revision, detail, cause) {
        super(`Git revision "${revision}": ${detail}`);
        this.name = 'GitRevisionError';
        this.revision = revision;
        if (cause) this.cause = cause;
    }
}

export class GitTargetReadError extends Error {
    constructor(target, path, detail, cause) {
        super(`Git target "${target}" path "${path}": ${detail}`);
        this.name = 'GitTargetReadError';
        this.target = target;
        this.path = path;
        if (cause) this.cause = cause;
    }
}

function gitBuf(args, cwd, input) {
    return execFileSync('git', args, {
        cwd,
        env: gitEnvironment(),
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        // Capture stderr into the thrown error (pipe) instead of letting git's
        // raw stderr leak to the user's terminal alongside aimhooman's own
        // diagnostics; stdin is ignored unless input is supplied.
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(input === undefined ? {} : { input }),
    });
}

function gitStr(args, cwd) {
    return gitBuf(args, cwd).toString('utf8').trim();
}

function nulStrings(buf) {
    return buf.toString('utf8').split('\0').filter(Boolean);
}

function assertRevision(revision, label) {
    if (typeof revision !== 'string' || !revision || revision.startsWith('-')) {
        throw new TypeError(`${label} must be a non-empty Git revision`);
    }
}

function assertOid(oid) {
    if (typeof oid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) {
        throw new TypeError('oid must be a full Git object ID');
    }
}

function typeForMode(mode) {
    if (mode === '160000') return 'commit';
    if (mode === '040000') return 'tree';
    return 'blob';
}

function objectMetadata(repo, oids) {
    const unique = [...new Set(oids.filter(Boolean))];
    if (!unique.length) return new Map();
    const output = gitBuf(
        ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
        repo.root,
        Buffer.from(unique.join('\n') + '\n'),
    ).toString('utf8').trimEnd().split('\n');
    const metadata = new Map();

    for (let i = 0; i < unique.length; i++) {
        const fields = (output[i] || '').split(' ');
        if (fields[1] === 'missing') {
            metadata.set(unique[i], { type: null, size: null });
        } else if (fields.length === 3 && /^\d+$/.test(fields[2])) {
            metadata.set(unique[i], { type: fields[1], size: Number(fields[2]) });
        } else {
            throw new Error('unexpected output from git cat-file --batch-check');
        }
    }
    return metadata;
}

function enrichEntries(repo, entries) {
    const metadata = objectMetadata(
        repo,
        entries.filter((entry) => entry.mode !== '160000').map((entry) => entry.oid),
    );
    // Gitlinks (mode 160000) pin a commit of another repository. Enrich them
    // from the local object store when the pin happens to be there, but never
    // let the read fail the scan: in a partial clone asking cat-file about a
    // pin that is not local triggers a promisor fetch that aborts the whole
    // batch ("not our ref"), surfacing as an EPIPE. A failed read leaves the
    // mode-derived type in place with no size.
    try {
        const gitlinks = objectMetadata(
            repo,
            entries.filter((entry) => entry.mode === '160000').map((entry) => entry.oid),
        );
        for (const [oid, object] of gitlinks) metadata.set(oid, object);
    } catch { /* best effort — see above */ }
    return entries.map((entry) => {
        const object = metadata.get(entry.oid) || { type: null, size: null };
        return {
            ...entry,
            type: object.type || entry.type || typeForMode(entry.mode),
            size: object.size,
        };
    });
}

function diffEntries(repo, args, renameThreshold = null) {
    const fields = nulStrings(gitBuf([
        'diff', '--raw', '--no-abbrev',
        renameThreshold === null ? '--find-renames' : `--find-renames=${renameThreshold}`,
        '-z', '--diff-filter=ACMRTD', ...args, '--',
    ], repo.root));
    const entries = [];

    for (let i = 0; i < fields.length;) {
        const header = fields[i++];
        const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([ACMRTD])(\d*)$/.exec(header);
        if (!match || i >= fields.length) {
            throw new Error('unexpected output from git diff --raw');
        }
        const sourcePath = fields[i++];
        let path = sourcePath;
        if (match[5] === 'R' || match[5] === 'C') {
            if (i >= fields.length) throw new Error('unexpected rename output from git diff --raw');
            path = fields[i++];
        }
        const deleted = match[5] === 'D';
        entries.push({
            path,
            ...(path === sourcePath ? {} : { sourcePath }),
            oid: deleted ? null : match[4],
            mode: deleted ? null : match[2],
            type: deleted ? 'deleted' : typeForMode(match[2]),
            status: match[5],
        });
    }

    return enrichEntries(repo, entries);
}

// openRepo resolves the repository containing cwd. Throws if not a repo.
export function openRepo(cwd = process.cwd()) {
    const root = gitStr(['rev-parse', '--show-toplevel'], cwd);
    const gitDir = gitStr(['rev-parse', '--absolute-git-dir'], root);
    let commonDir = gitStr(['rev-parse', '--git-common-dir'], root);
    if (!isAbsolute(commonDir)) commonDir = join(root, commonDir);
    return {
        root,
        gitDir,
        commonDir,
        // Shared by linked worktrees, which is why it hangs off commonDir rather
        // than gitDir. Every released version has written here.
        stateDir: join(commonDir, 'aimhooman'),
        excludeFile: join(commonDir, 'info', 'exclude'),
    };
}

// stagedEntries snapshots index changes, including deletion metadata. Rename
// and copy entries use the destination path; object IDs keep blob reads stable.
export function stagedEntries(repo) {
    return diffEntries(repo, ['--cached']);
}

// stagedPaths is the path-only view of staged index changes. It reads names
// directly (git diff --name-only) so it neither spends a cat-file --batch-check
// round-trip nor throws on an object git cannot resolve — path rules only need
// the path. Rename/copy entries report their destination, matching stagedEntries.
export function stagedPaths(repo) {
    return nulStrings(gitBuf([
        'diff', '--cached', '--name-only', '--find-renames', '-z', '--diff-filter=ACMRTD', '--',
    ], repo.root));
}

// stagedTreeSha writes the index to a tree object and returns its SHA, the same
// value `git write-tree` produces in the commit-msg dispatcher. Used by the
// pre-commit/commit-msg marker dedup (W5): pre-commit records this sha when it
// scans clean, and commit-msg skips its duplicate tree scan when the sha still
// matches. The index is unchanged between the two hooks in a normal commit, so
// the sha is stable; any staging mutation invalidates it automatically.
export function stagedTreeSha(repo) {
    return gitStr(['write-tree'], repo.root);
}

// Unmerged index entries have only stages 1-3 and are omitted by the ordinary
// cached diff. Expose their paths so callers cannot mistake a conflicted index
// for a complete, clean staged snapshot.
export function unmergedPaths(repo) {
    const paths = new Set();
    for (const record of nulStrings(gitBuf(['ls-files', '--unmerged', '-z'], repo.root))) {
        const tab = record.indexOf('\t');
        const metadata = tab < 0 ? '' : record.slice(0, tab);
        const path = tab < 0 ? '' : record.slice(tab + 1);
        if (!/^\d+ [0-9a-f]+ [1-3]$/.test(metadata) || !path) {
            throw new Error('unexpected unmerged index entry');
        }
        paths.add(path);
    }
    return [...paths];
}

// stagedRenameSources identifies low-similarity rename sources for selected
// destinations. Git does not record a rename in the index, so this conservative
// second pass prevents clean-mode repair from leaving only the deletion staged.
export function stagedRenameSources(repo, destinations) {
    const selected = new Set(destinations);
    if (!selected.size) return [];
    const entries = diffEntries(repo, ['--cached'], '1%');
    const sources = new Set(entries
        .filter((entry) => entry.status === 'R' && selected.has(entry.path) && entry.sourcePath)
        .map((entry) => entry.sourcePath));

    // Git stores no rename relation in the index. A zero-similarity rename is
    // indistinguishable from one staged add plus one or more staged deletes, so
    // there is no exact source to recover. When a blocked destination remains an
    // add even at the lowest similarity threshold, conservatively restore every
    // staged deletion. This may unstage an unrelated deletion, but it never lets
    // automatic repair silently commit half of a possible rename. That threshold
    // carries a % sign because git reads a bare 1 as the fraction 0.1, so -M1
    // asks for 10% and leaves a 3%-similar rename here as an add plus a delete.
    if (entries.some((entry) => entry.status === 'A' && selected.has(entry.path))) {
        for (const entry of entries) {
            if (entry.status === 'D') sources.add(entry.path);
        }
    }
    return [...sources];
}

// readStagedPath distinguishes an absent index path from an unreadable index or
// object. The returned object ID pins the bytes used by policy resolution.
export function readStagedPath(repo, path) {
    assertGitPath(path);
    const target = 'staged';
    let records;
    try {
        // The --literal-pathspecs flag rather than :(top,literal) magic: magic
        // parsing is disabled by GIT_LITERAL_PATHSPECS in the environment, which
        // would leave the pathspec a literal filename no repository contains, so
        // git matched nothing and the read reported the policy absent. cwd is
        // already repo.root, which is what the top magic was for.
        records = nulStrings(gitBuf([
            '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', path,
        ], repo.root));
    } catch (error) {
        throw new GitTargetReadError(target, path, gitErrorDetail(error), error);
    }
    if (!records.length) return missingPath(target, path);

    let selected = null;
    let unmerged = false;
    for (const record of records) {
        const tab = record.indexOf('\t');
        const match = /^(\d+) ([0-9a-f]+) ([0-3])$/.exec(record.slice(0, tab));
        if (tab < 0 || !match || record.slice(tab + 1) !== path) {
            throw new GitTargetReadError(target, path, 'unexpected index entry');
        }
        if (match[3] === '0') selected = { mode: match[1], oid: match[2] };
        else unmerged = true;
    }
    if (unmerged || !selected) {
        throw new GitTargetReadError(target, path, 'path has unmerged index stages');
    }
    return presentPath(repo, target, path, selected);
}

// readCommitPath resolves revision to a commit first. Only a missing path is a
// normal fallback; an invalid revision or an object read error is reported.
export function readCommitPath(repo, revision, path) {
    assertGitPath(path);
    let oid;
    try {
        assertRevision(revision, 'revision');
        oid = gitBuf([
            'rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`,
        ], repo.root).toString('utf8').trim();
    } catch (error) {
        if (error instanceof TypeError || error?.status === 1) {
            throw new GitRevisionError(revision, 'does not resolve to a commit', error);
        }
        throw new GitTargetReadError(`commit:${revision}`, path, gitErrorDetail(error), error);
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) {
        throw new GitTargetReadError(`commit:${revision}`, path, 'Git returned an invalid commit object ID');
    }
    const target = `commit:${oid}`;
    let records;
    try {
        records = nulStrings(gitBuf([
            '--literal-pathspecs', 'ls-tree', '--full-tree', '-z', oid, '--', path,
        ], repo.root));
    } catch (error) {
        throw new GitTargetReadError(target, path, gitErrorDetail(error), error);
    }
    if (!records.length) return missingPath(target, path);
    if (records.length !== 1) {
        throw new GitTargetReadError(target, path, 'Git returned more than one tree entry');
    }
    const tab = records[0].indexOf('\t');
    const match = /^(\d+) (\w+) ([0-9a-f]+)$/.exec(records[0].slice(0, tab));
    if (tab < 0 || !match || records[0].slice(tab + 1) !== path) {
        throw new GitTargetReadError(target, path, 'unexpected tree entry');
    }
    if (match[2] !== 'blob') {
        throw new GitTargetReadError(target, path, `expected a blob, found ${match[2]}`);
    }
    return presentPath(repo, target, path, { mode: match[1], oid: match[3] });
}

export function hashBlob(repo, content) {
    let oid;
    try {
        oid = gitBuf(['hash-object', '--stdin'], repo.root, content).toString('utf8').trim();
        assertOid(oid);
    } catch (error) {
        throw new GitTargetReadError('worktree', '.aimhooman.json', gitErrorDetail(error), error);
    }
    return oid;
}

function assertGitPath(path) {
    if (typeof path !== 'string' || !path || path.includes('\0')) {
        throw new TypeError('path must be a non-empty Git path');
    }
}

function missingPath(target, path) {
    return { status: 'missing', target, path, oid: null, content: null };
}

function presentPath(repo, target, path, entry) {
    let content;
    try {
        content = gitBuf(['cat-file', 'blob', entry.oid], repo.root);
    } catch (error) {
        throw new GitTargetReadError(target, path, gitErrorDetail(error), error);
    }
    return {
        status: 'present',
        target,
        path,
        oid: entry.oid,
        mode: entry.mode,
        content,
    };
}

function gitErrorDetail(error) {
    const stderr = Buffer.isBuffer(error?.stderr)
        ? error.stderr.toString('utf8').trim()
        : String(error?.stderr || '').trim();
    return stderr || error?.message || 'Git read failed';
}

// trackedEntries snapshots every index entry. A resolved path has one stage-zero
// entry; an unresolved path keeps all stage 1/2/3 candidates so content scanning
// cannot miss a blob that exists only on one side of a conflict.
export function trackedEntries(repo) {
    const records = nulStrings(gitBuf(['ls-files', '--stage', '-z'], repo.root));
    const entries = [];
    for (const record of records) {
        const tab = record.indexOf('\t');
        const match = /^(\d+) ([0-9a-f]+) ([0-3])$/.exec(record.slice(0, tab));
        if (tab < 0 || !match) throw new Error('unexpected output from git ls-files --stage');
        entries.push({
            path: record.slice(tab + 1),
            oid: match[2],
            mode: match[1],
            type: typeForMode(match[1]),
            stage: Number(match[3]),
        });
    }
    return enrichEntries(repo, entries);
}

// withIndexFromTree exposes an immutable tree through Git's staged-index APIs.
// It is used by commit-msg after the dispatcher snapshots the would-be commit
// tree, so a chained hook cannot switch the policy by mutating the live index.
export function withIndexFromTree(repo, treeOid, fn) {
    assertOid(treeOid);
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const type = gitStr(['cat-file', '-t', treeOid], repo.root);
    if (type !== 'tree') throw new TypeError('treeOid must identify a Git tree');

    mkdirSync(repo.stateDir, { recursive: true });
    const temporary = mkdtempSync(join(repo.stateDir, '.commit-tree-index-'));
    const index = join(temporary, 'index');
    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = index;
    try {
        gitBuf(['read-tree', treeOid], repo.root);
        return fn();
    } finally {
        if (previous === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = previous;
        rmSync(temporary, { recursive: true, force: true });
    }
}

// gatedTips lists the local branch tips this guard has already cleared. Only
// refs/heads/* qualifies, because it is the only namespace cmdRefcheck gates;
// the refs under review are excluded, since Git already publishes them at the
// `committed` phase and a ref must never serve as its own proof.
function gatedTips(repo, reviewing) {
    return gitBuf(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'], repo.root)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
        .filter(([name, oid]) => name && oid && !reviewing.has(name))
        .map(([, oid]) => oid);
}

// introducedCommits returns each commit added by a proposed branch update.
// Reachability through refs/heads/* is trusted because those commits passed this
// same guard when their branch was written; every other namespace is not. Using
// `--not --all` would let an ignored tag or remote ref pre-poison reachability
// and suppress the scan, so tips come from refs/heads/* alone. A newly created
// branch is measured against those tips instead of its full ancestry, which
// would otherwise rescan the entire repository on every `git checkout -b`;
// ordinary updates scan exactly old..new.
export function introducedCommits(repo, updates) {
    const commits = [];
    const seen = new Set();
    const reviewing = new Set(updates.map((update) => update?.ref).filter(Boolean));
    const gated = gatedTips(repo, reviewing);
    for (const update of updates) {
        const oldObjectId = update?.oldObjectId;
        const newObjectId = update?.newObjectId;
        assertOid(oldObjectId);
        assertOid(newObjectId);
        const revisions = /^0+$/.test(oldObjectId)
            ? [newObjectId, ...(gated.length ? ['--not', ...gated] : [])]
            : [newObjectId, `^${oldObjectId}`];
        const resolved = gitBuf(['rev-list', '--reverse', ...revisions], repo.root)
            .toString('utf8')
            .trim()
            .split('\n')
            .filter(Boolean);
        for (const commit of resolved) {
            if (!seen.has(commit)) {
                seen.add(commit);
                commits.push(commit);
            }
        }
    }
    return commits;
}

// gitConfig returns a git config value, or '' if unset.
export function gitConfig(root, key) {
    try {
        return gitStr(['config', '--get', key], root);
    } catch {
        return '';
    }
}

// unstagePaths removes the given paths from the index (non-blocking).
// HEAD-safe: `git restore --staged` needs HEAD, so on the initial commit
// (no HEAD yet) it falls back to `git rm --cached`.
export function unstagePaths(repo, paths) {
    if (!paths.length) return [];
    const pathspecs = Buffer.from(paths.join('\0') + '\0');
    const opts = {
        cwd: repo.root,
        env: gitEnvironment(),
        input: pathspecs,
        timeout: GIT_TIMEOUT_MS,
        stdio: ['pipe', 'ignore', 'pipe'],
    };
    let hasHead = true;
    try {
        // Deliberately not `opts`: rev-parse never reads stdin, so feeding it the
        // pathspec makes git exit before draining the pipe, and a pathspec over the
        // ~64 KiB pipe buffer fails the write with EPIPE. That read as "no HEAD" and
        // sent a repository that has one down the `rm --cached` branch, staging the
        // deletion of every tracked path this was asked to restore.
        execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
            cwd: repo.root,
            env: gitEnvironment(),
            timeout: GIT_TIMEOUT_MS,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
    } catch (error) {
        // Only git's own verdict may select the branch. An unborn HEAD exits 128;
        // a timeout or a missing git carries no exit status, and guessing "no HEAD"
        // there would delete instead of restore. Fail closed and let the caller stop
        // the commit rather than silently rewrite the index.
        if (typeof error?.status !== 'number') throw error;
        hasHead = false;
    }
    if (hasHead) {
        execFileSync('git', [
            '--literal-pathspecs', 'restore', '--staged',
            '--pathspec-from-file=-', '--pathspec-file-nul',
        ], opts);
    } else {
        // -f waives only the check that the staged blob still matches the file
        // on disk. With no HEAD that check has nothing else to pass against, so
        // an artifact appended to between `git add` and `git commit` could never
        // be unstaged. --cached leaves the worktree alone either way, and the
        // sibling `restore --staged` branch enforces no equivalent check.
        execFileSync('git', [
            '--literal-pathspecs', 'rm', '--cached', '-f', '--quiet', '--ignore-unmatch',
            '--pathspec-from-file=-', '--pathspec-file-nul',
        ], opts);
    }
    return paths;
}
