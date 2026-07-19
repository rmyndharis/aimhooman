import { execFileSync } from 'node:child_process';
import { gitEnvironment, GIT_TIMEOUT_MS } from './git-environment.mjs';

export const DEFAULT_SCAN_LIMITS = Object.freeze({
    maxFileBytes: 2 << 20,
    maxTotalBytes: 64 << 20,
    maxFindings: 1000,
});

export function scanEntries(repo, engine, entries, options = {}) {
    const limits = { ...DEFAULT_SCAN_LIMITS, ...options };
    const stats = {
        entries: entries.length,
        blob_files: 0,
        objects_read: 0,
        files_scanned: 0,
        bytes_scanned: 0,
        findings_total: 0,
        findings_returned: 0,
        skipped: {},
        skippedPaths: {},
    };
    const candidates = [];
    let selectedBytes = 0;
    const oversized = [];

    for (const entry of entries) {
        if (entry.type !== 'blob') {
            if (entry.type && entry.type !== 'deleted') increment(stats.skipped, `type:${entry.type}`);
            continue;
        }
        stats.blob_files += 1;
        if (!entry.oid || !Number.isSafeInteger(entry.size) || entry.size < 0) {
            increment(stats.skipped, 'metadata-unavailable');
            continue;
        }
        if (entry.size === 0) {
            increment(stats.skipped, 'empty');
            continue;
        }
        if (entry.size > limits.maxFileBytes) {
            oversized.push(entry);
            continue;
        }
        if (selectedBytes + entry.size > limits.maxTotalBytes) {
            increment(stats.skipped, 'total-byte-limit');
            appendPath(stats.skippedPaths, 'total-byte-limit', entry.path, entry.size);
            continue;
        }
        selectedBytes += entry.size;
        candidates.push(entry);
    }

    // Oversized files: probe the first 8 KB to separate binary from text.
    // A binary file (PSD, WOFF, PNG) holds no text lines the content rules
    // could match, so it skips as 'binary' (complete). A text file that
    // exceeds the budget is a genuine 'size-limit' skip (incomplete) and the
    // caller must raise the limit to cover it.
    // Cap probing at 16 MiB: cat-file --batch reads the full blob into memory,
    // so probing a 500 MB file just to check for NULs is wasteful. Files above
    // the cap are classified as size-limit without probing.
    const PROBE_CAP = 16 * 1024 * 1024;
    const probeable = oversized.filter((entry) => entry.size <= PROBE_CAP);
    const tooBig = oversized.filter((entry) => entry.size > PROBE_CAP);
    for (const entry of tooBig) {
        increment(stats.skipped, 'size-limit');
        appendPath(stats.skippedPaths, 'size-limit', entry.path, entry.size);
    }
    if (probeable.length) {
        const probeOids = [...new Set(probeable.map((entry) => entry.oid))];
        const probes = probeObjects(repo, probeOids, probeable);
        for (const entry of probeable) {
            const header = probes.get(entry.oid);
            if (header && isBinary(header)) {
                increment(stats.skipped, 'binary');
                appendPath(stats.skippedPaths, 'binary', entry.path, entry.size);
            } else {
                increment(stats.skipped, 'size-limit');
                appendPath(stats.skippedPaths, 'size-limit', entry.path, entry.size);
            }
        }
    }

    const objectIds = [...new Set(candidates.map((entry) => entry.oid))];
    const batch = readObjects(repo, objectIds, selectedBytes);
    stats.objects_read = batch.objects.size;
    for (const failure of batch.failures) increment(stats.skipped, failure.reason);

    // Precompute changed-line ranges for all text candidates in ONE batched
    // diff per (commit, parent) pair (W4 + perf). A missing path key means
    // "scan the whole blob" (staged/snapshot/root entries, or a diff failure).
    const lineRanges = collectLineRanges(repo, candidates);

    const findings = [];
    for (const entry of candidates) {
        const blob = batch.objects.get(entry.oid);
        // A missing blob is already counted in batch.failures above (with a more
        // specific reason); just skip it here.
        if (!blob) continue;
        // Binary detection still reads the blob. Count every examined byte so
        // later commits cannot reset the total budget merely by using NUL data.
        stats.bytes_scanned += blob.length;
        if (isBinary(blob)) {
            // Content rules match text lines, so a binary blob carries nothing
            // they could fire on. Skipping it loses no coverage: the skip is
            // recorded as 'binary', which does not mark the scan incomplete.
            increment(stats.skipped, 'binary');
            appendPath(stats.skippedPaths, 'binary', entry.path, blob.length);
            continue;
        }
        stats.files_scanned += 1;
        const ranges = lineRanges.get(entry.path);
        const matched = engine.checkContent(entry.path, blob.toString('utf8'),
            ranges && ranges.length ? { lineRanges: ranges } : {});
        stats.findings_total += matched.length;
        for (const finding of matched) {
            if (findings.length >= limits.maxFindings) continue;
            findings.push({
                ...finding,
                objectId: entry.oid,
                ...(entry.commit ? { commit: entry.commit } : {}),
                ...(entry.parents?.length ? { parents: entry.parents } : {}),
                ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
                ...(entry.status ? { status: entry.status } : {}),
            });
        }
    }
    stats.findings_returned = findings.length;
    if (stats.findings_total > findings.length) increment(stats.skipped, 'finding-limit');
    for (const [reason, count] of Object.entries(engine.takeSkipped?.() || {})) {
        stats.skipped[reason] = (stats.skipped[reason] || 0) + count;
    }

    const incompleteReasons = new Set([
        'metadata-unavailable', 'size-limit', 'total-byte-limit',
        'missing-object', 'unexpected-object', 'finding-limit', 'local-input-limit',
    ]);
    const complete = !Object.keys(stats.skipped).some((reason) => incompleteReasons.has(reason));
    return { findings, complete, stats };
}

function readObjects(repo, objectIds, expectedBytes = 0) {
    const unique = [...new Set(objectIds.filter(Boolean))];
    if (!unique.length) return { objects: new Map(), failures: [] };
    const output = execFileSync('git', ['cat-file', '--batch'], {
        cwd: repo.root,
        env: gitEnvironment(),
        input: Buffer.from(unique.join('\n') + '\n'),
        encoding: 'buffer',
        maxBuffer: Math.max(2 * 1024 * 1024, expectedBytes + unique.length * 256 + 1024),
        timeout: GIT_TIMEOUT_MS,
        // Same reason as gitBuf in gitx.mjs: without an explicit stdio,
        // execFileSync echoes the child's stderr before it checks the exit
        // status, so git's raw output reaches the terminal even on success.
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const objects = new Map();
    const failures = [];
    let offset = 0;
    for (const requested of unique) {
        const newline = output.indexOf(0x0a, offset);
        if (newline < 0) throw new Error('unexpected truncated output from git cat-file --batch');
        const header = output.subarray(offset, newline).toString('utf8');
        offset = newline + 1;
        const fields = header.split(' ');
        if (fields[1] === 'missing') {
            failures.push({ oid: requested, reason: 'missing-object' });
            continue;
        }
        if (fields.length !== 3 || fields[1] !== 'blob' || !/^\d+$/.test(fields[2])) {
            failures.push({ oid: requested, reason: 'unexpected-object' });
            continue;
        }
        const size = Number(fields[2]);
        const end = offset + size;
        if (end > output.length || output[end] !== 0x0a) {
            throw new Error('unexpected object framing from git cat-file --batch');
        }
        objects.set(requested, output.subarray(offset, end));
        offset = end + 1;
    }
    return { objects, failures };
}

// probeObjects reads the first 8000 bytes of each blob to decide whether it is
// binary (contains a NUL). cat-file --batch outputs full blobs, so the buffer
// must accommodate total blob sizes, but we only inspect the leading bytes.
function probeObjects(repo, objectIds, entries) {
    const unique = [...new Set(objectIds.filter(Boolean))];
    if (!unique.length) return new Map();
    const PROBE_BYTES = 8000;
    // Sum the actual sizes so the buffer can hold the full output.
    const sizeByOid = new Map();
    for (const entry of entries) {
        if (entry.oid && entry.size > 0) sizeByOid.set(entry.oid, Math.max(sizeByOid.get(entry.oid) || 0, entry.size));
    }
    const totalExpected = unique.reduce((sum, oid) => sum + (sizeByOid.get(oid) || 0), 0);
    const output = execFileSync('git', ['cat-file', '--batch'], {
        cwd: repo.root,
        env: gitEnvironment(),
        input: Buffer.from(unique.join('\n') + '\n'),
        encoding: 'buffer',
        maxBuffer: Math.max(2 * 1024 * 1024, totalExpected + unique.length * 256 + 1024),
        timeout: GIT_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const probes = new Map();
    let offset = 0;
    for (const requested of unique) {
        const newline = output.indexOf(0x0a, offset);
        if (newline < 0) break;
        const header = output.subarray(offset, newline).toString('utf8');
        offset = newline + 1;
        const fields = header.split(' ');
        if (fields[1] === 'missing' || fields.length !== 3 || fields[1] !== 'blob') continue;
        const size = Number(fields[2]);
        const end = offset + size;
        if (end > output.length || output[end] !== 0x0a) break;
        probes.set(requested, output.subarray(offset, offset + Math.min(size, PROBE_BYTES)));
        offset = end + 1;
    }
    return probes;
}

function increment(record, key) {
    record[key] = (record[key] || 0) + 1;
}

function appendPath(record, reason, path, size) {
    if (!record[reason]) record[reason] = [];
    if (record[reason].length < 10) record[reason].push({ path, size });
}

function isBinary(buffer) {
    const length = Math.min(buffer.length, 8000);
    for (let index = 0; index < length; index++) if (buffer[index] === 0) return true;
    return false;
}

// collectLineRanges builds a Map<path, ranges[]> for all entries whose content
// scan can be narrowed to changed hunks (W4, bug 12d-F1). It batches the work
// into ONE `git diff --unified=0` per (commit, parent) pair rather than one diff
// per file — a commit touching 50 files would otherwise pay ~650ms of per-file
// git subprocess startup. Entries are grouped by their first parent; a normal
// commit (single parent) is a single diff call covering every file.
//
// Entries without commit/parents (tracked snapshots, staged views, root
// commits) are omitted from the map; the caller treats a missing key as "scan
// the whole blob" — the safe side is to scan MORE, not less, so a failure to
// compute hunks falls back to the pre-W4 behaviour.
function collectLineRanges(repo, entries) {
    // Group text-candidate entries by their first parent to batch the diffs.
    // Key by `${commit}\0${parent}` so a merge with multiple parents produces
    // one diff per distinct (commit, parent) pair.
    const groups = new Map();
    for (const entry of entries) {
        if (entry.type === 'blob' && !entry.commit) continue; // staged/snapshot: no diff
        const parent = entry.parents?.[0];
        if (!entry.commit || !parent) continue; // root commit or no parent: whole-blob
        const key = `${entry.commit}\0${parent}`;
        if (!groups.has(key)) groups.set(key, { commit: entry.commit, parent });
    }
    const byPath = new Map();
    for (const { commit, parent } of groups.values()) {
        let output;
        try {
            output = execFileSync('git', [
                '-c', 'core.quotePath=false',
                'diff', '--unified=0', '--no-color', '--no-prefix',
                parent, commit,
            ], {
                cwd: repo.root,
                env: gitEnvironment(),
                encoding: 'utf8',
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: 16 * 1024 * 1024,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch {
            continue; // diff failed → those paths stay absent → whole-blob scan
        }
        // Parse the multi-file diff: track the current file from the `+++ path`
        // line, and attribute each `@@` hunk header to it. core.quotePath=false
        // keeps spaces and non-ASCII paths literal so they match entry.path (which
        // comes from git diff --raw -z, also unquoted). Paths containing newlines
        // are not handled, but they fall back to a whole-blob scan (safe).
        let currentPath = null;
        for (const line of output.split('\n')) {
            // With --no-prefix the +++ line is `+++ path` (no b/ prefix).
            const plusMatch = /^\+\+\+ (.+)$/.exec(line);
            if (plusMatch) {
                currentPath = plusMatch[1] === '/dev/null' ? null : plusMatch[1];
                continue;
            }
            const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!match || !currentPath) continue;
            const start = Number(match[1]);
            const count = match[2] === undefined ? 1 : Number(match[2]);
            if (start === 0 || count === 0) continue; // pure deletion, no new content
            const range = { start, end: start + count - 1 };
            const existing = byPath.get(currentPath);
            if (existing) existing.push(range);
            else byPath.set(currentPath, [range]);
        }
    }
    return byPath;
}
