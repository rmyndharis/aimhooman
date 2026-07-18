import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function atomicWrite(file, data, options = {}) {
    const directory = dirname(file);
    const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    const mode = options.mode ?? existingMode(file) ?? 0o600;
    const operations = {
        open: openSync,
        write: writeFileSync,
        sync: fsyncSync,
        close: closeSync,
        rename: renameSync,
        remove: rmSync,
        openDirectory: openSync,
        syncDirectory: fsyncSync,
        closeDirectory: closeSync,
        ...options.operations,
    };
    let descriptor;
    try {
        descriptor = operations.open(temporary, 'wx', mode);
        operations.write(descriptor, data);
        operations.sync(descriptor);
        operations.close(descriptor);
        descriptor = undefined;
        renameWithRetry(operations, temporary, file, options.renameRetries);
        try {
            syncDirectory(directory, operations);
        } catch (error) {
            throw new Error(
                `replaced "${file}" but could not sync its directory; durability is uncertain: ${error.message}`,
                { cause: error },
            );
        }
    } catch (error) {
        if (descriptor !== undefined) {
            try { operations.close(descriptor); } catch { /* keep the write error */ }
        }
        try { operations.remove(temporary, { force: true }); } catch { /* keep the write error */ }
        throw error;
    }
}

// Windows fails a rename with EPERM/EACCES/EBUSY while another handle is open on
// either path — an antivirus or indexer scanning the file aimhooman just wrote is
// enough, and it clears within milliseconds. Observed on CI as a lock contender
// dying at its ticket publication, which then read as a lifecycle-queue timeout.
// The rename is the atomic commit point, so a retry either lands the complete
// file or leaves the original untouched; it can never publish a partial write.
// A non-transient error (and every code on other platforms) still throws at once.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameWithRetry(operations, temporary, file, retries = 20) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            operations.rename(temporary, file);
            return;
        } catch (error) {
            const retryable = process.platform === 'win32'
                && TRANSIENT_RENAME_CODES.has(error?.code)
                && attempt + 1 < retries;
            if (!retryable) throw error;
            waitForLock(5);
        }
    }
}

function existingMode(file) {
    try {
        return statSync(file).mode & 0o777;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function syncDirectory(directory, operations) {
    let descriptor;
    let failure = null;
    try {
        descriptor = operations.openDirectory(directory, 'r');
        operations.syncDirectory(descriptor);
    } catch (error) {
        failure = error;
    }
    let closeFailure = null;
    if (descriptor !== undefined) {
        try { operations.closeDirectory(descriptor); }
        catch (error) { closeFailure = error; }
    }
    if (failure && !['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM'].includes(failure.code)) {
        throw failure;
    }
    if (closeFailure) throw closeFailure;
}

const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const IDENTITY_PROBE_TIMEOUT_MS = 5_000;

function waitForLock(milliseconds) {
    if (milliseconds > 0) Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, milliseconds);
}

function processIdentity(pid) {
    try {
        if (process.platform === 'linux') {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            const startTicks = afterName[19];
            return startTicks ? `linux:${startTicks}` : null;
        }
        if (process.platform === 'win32') {
            // Node has no direct Windows process-start identity API. Starting
            // PowerShell for every lock contender can take longer than the lock
            // retry window under load. Keep the PID-only fallback: a dead owner
            // is removable, while a reused live PID conservatively retains the
            // stale candidate instead of risking two writers in one lock.
            return null;
        }
        if (process.platform !== 'win32') {
            const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                // This is the only spawn on the lock path, and it runs on macOS
                // and BSD alone: Linux reads /proc and Windows returns early.
                // The retry loop below budgets milliseconds per attempt, so a
                // probe that stalls must lose rather than stretch the loop. A
                // timeout throws into the catch below, which fails safe.
                timeout: IDENTITY_PROBE_TIMEOUT_MS,
            }).trim();
            return started ? `ps:${started}` : null;
        }
    } catch {
        // A missing process or an unavailable platform probe is handled by the
        // kill(0) check below. Unknown identity fails safe as an active owner.
    }
    return null;
}

function lockOwnerIsActive(owner) {
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
        return false;
    }
    try {
        process.kill(owner.pid, 0);
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
    if (typeof owner.processIdentity === 'string') {
        const activeIdentity = processIdentity(owner.pid);
        // If the platform cannot prove identity, retain the lock. A mismatch is
        // proof that the PID was reused after the recorded holder exited.
        if (activeIdentity && activeIdentity !== owner.processIdentity) return false;
    }
    return true;
}

const LOCK_CANDIDATE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;

function readCandidate(path, token) {
    let candidate;
    try {
        candidate = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`malformed state lock candidate "${path}"`, { cause: error });
    }
    const valid = candidate
        && candidate.version === 1
        && candidate.token === token
        && Number.isSafeInteger(candidate.pid)
        && candidate.pid > 0
        && (candidate.processIdentity === null || typeof candidate.processIdentity === 'string')
        && typeof candidate.choosing === 'boolean'
        && (candidate.choosing
            ? candidate.ticket === null
            : Number.isSafeInteger(candidate.ticket) && candidate.ticket > 0);
    if (!valid) throw new Error(`malformed state lock candidate "${path}"`);
    return { ...candidate, path };
}

function removeDeadCandidate(candidate, staleMs) {
    let age;
    try {
        age = Date.now() - statSync(candidate.path).mtimeMs;
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
    }
    if (age < staleMs || lockOwnerIsActive(candidate)) return false;
    // Candidate names are random UUIDs and are never reused. Once its exact
    // process identity is dead, no conforming writer can replace this path, so
    // deleting it has none of the check-then-unlink race of a shared lockfile.
    try {
        unlinkSync(candidate.path);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return true;
}

function queueCandidates(queueDir, staleMs) {
    const candidates = [];
    for (const entry of readdirSync(queueDir, { withFileTypes: true })) {
        const match = entry.isFile() && LOCK_CANDIDATE.exec(entry.name);
        if (!match) continue;
        const candidate = readCandidate(join(queueDir, entry.name), match[1]);
        if (!candidate || removeDeadCandidate(candidate, staleMs)) continue;
        candidates.push(candidate);
    }
    return candidates;
}

function precedes(left, right) {
    return left.ticket < right.ticket
        || (left.ticket === right.ticket && left.token.localeCompare(right.token) < 0);
}

function publishCandidate(path, candidate, operations) {
    atomicWrite(path, `${JSON.stringify(candidate)}\n`, { operations });
}

// withLock uses a Lamport bakery queue. Each contender owns one never-reused
// UUID path, so stale cleanup and release only unlink that contender's path;
// neither operation can remove a replacement lock at a shared pathname.
export function withLock(lockPath, fn, options = {}) {
    const retries = options.retries ?? 50;
    const staleMs = options.staleMs ?? 60000;
    const retryDelayMs = options.retryDelayMs ?? 10;
    mkdirSync(dirname(lockPath), { recursive: true });
    const queueDir = `${lockPath}.queue`;
    mkdirSync(queueDir, { recursive: true });
    const token = randomUUID();
    const candidatePath = join(queueDir, `${token}.json`);
    const candidate = {
        version: 1,
        pid: process.pid,
        token,
        processIdentity: processIdentity(process.pid),
        choosing: true,
        ticket: null,
    };
    let held = false;
    let published = false;
    let primaryError = null;
    // Between the mkdir above and the first publication below this contender owns
    // no file in the queue, so a concurrent cleanup that removes empty queue
    // directories — `aimhooman uninstall` sweeps them — can delete it out from
    // under us. The gap is wide enough to lose: building the candidate probes the
    // process identity, which spawns `ps` on macOS and BSD. Recreate and retry
    // once rather than failing the caller with a bare ENOENT. Once a candidate is
    // published the directory is no longer empty, so no cleanup can remove it.
    const publish = () => {
        try {
            publishCandidate(candidatePath, candidate, options.candidateOperations);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            mkdirSync(queueDir, { recursive: true });
            publishCandidate(candidatePath, candidate, options.candidateOperations);
        }
    };
    try {
        // Own the UUID pathname before publication begins. If the rename lands
        // but its directory fsync fails, finally still removes the candidate;
        // unlinking ENOENT is harmless when publication failed earlier.
        published = true;
        publish();
        const observed = queueCandidates(queueDir, staleMs);
        candidate.ticket = observed.reduce((maximum, peer) => (
            peer.ticket === null ? maximum : Math.max(maximum, peer.ticket)
        ), 0) + 1;
        candidate.choosing = false;
        publish();

        for (let attempt = 0; attempt < retries; attempt += 1) {
            // A file at the pre-queue lock path may belong to a concurrently
            // running older aimhooman version. It cannot be removed safely, so
            // an upgrade waits/fails closed until that legacy holder releases.
            const legacyHolder = existsSync(lockPath);
            const peers = queueCandidates(queueDir, staleMs);
            const own = peers.find((peer) => peer.token === token);
            if (!own) throw new Error(`state lock candidate "${candidatePath}" disappeared`);
            const blocked = legacyHolder || peers.some((peer) => (
                peer.token !== token && (peer.choosing || precedes(peer, own))
            ));
            if (!blocked) {
                held = true;
                break;
            }
            if (attempt + 1 < retries) waitForLock(retryDelayMs);
        }
        if (!held) {
            // Name the queue, not just the lock. This scheme writes no file at lockPath;
            // only the legacy holder checked above would, so a reader of this error
            // usually goes looking for a path that is not there. What blocks is a
            // candidate in the queue directory, retained because its owner cannot be
            // disproved, and a holder killed outright never reaches the finally below
            // that would have removed its own.
            throw new Error(
                `cannot acquire state lock "${lockPath}" after ${retries} attempts. Contenders `
                + `queue in "${queueDir}"; if no other aimhooman command is running, a candidate `
                + 'there outlived the process that published it, and removing that directory clears it',
            );
        }
        return fn();
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        if (published) {
            try { (options.unlinkCandidate || unlinkSync)(candidatePath); }
            catch (error) {
                if (error?.code !== 'ENOENT') {
                    if (primaryError) {
                        throw new AggregateError(
                            [primaryError, error],
                            `${primaryError.message}; also failed to release state lock: ${error.message}`,
                            { cause: primaryError },
                        );
                    }
                    throw error;
                }
            }
        }
    }
}
