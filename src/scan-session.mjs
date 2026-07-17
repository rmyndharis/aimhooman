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
    };
    const candidates = [];
    let selectedBytes = 0;

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
            increment(stats.skipped, 'size-limit');
            continue;
        }
        if (selectedBytes + entry.size > limits.maxTotalBytes) {
            increment(stats.skipped, 'total-byte-limit');
            continue;
        }
        selectedBytes += entry.size;
        candidates.push(entry);
    }

    const objectIds = [...new Set(candidates.map((entry) => entry.oid))];
    const batch = readObjects(repo, objectIds, selectedBytes);
    stats.objects_read = batch.objects.size;
    for (const failure of batch.failures) increment(stats.skipped, failure.reason);

    const findings = [];
    for (const entry of candidates) {
        const blob = batch.objects.get(entry.oid);
        // A missing blob is already counted in batch.failures above (with a more
        // specific reason); just skip it here.
        if (!blob) continue;
        // Binary detection still reads the blob. Count every examined byte so
        // later commits cannot reset the total budget merely by using NUL data.
        stats.bytes_scanned += blob.length;
        let matched;
        if (isBinary(blob)) {
            increment(stats.skipped, 'binary');
            // Binary classification only skips text-oriented policy rules. Secret
            // signatures are ASCII byte sequences, so latin1 preserves a
            // one-byte-to-one-code-unit view and prevents one NUL from hiding
            // credential material while keeping the existing byte limits.
            matched = engine.checkContent(entry.path, blob.toString('latin1'), {
                categories: ['secret'],
            });
        } else {
            stats.files_scanned += 1;
            matched = engine.checkContent(entry.path, blob.toString('utf8'));
        }
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
        'metadata-unavailable', 'size-limit', 'total-byte-limit', 'object-read-failed',
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

function increment(record, key) {
    record[key] = (record[key] || 0) + 1;
}

function isBinary(buffer) {
    const length = Math.min(buffer.length, 8000);
    for (let index = 0; index < length; index++) if (buffer[index] === 0) return true;
    return false;
}
