import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    accessSync,
    chmodSync,
    constants,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitConfig } from './gitx.mjs';
import { atomicWrite, withLock } from './atomic-write.mjs';

const MARKER = '# aimhooman-managed hook';
const HOOK_FORMAT_VERSION = 2;
const FINGERPRINT_PLACEHOLDER = '0'.repeat(64);
const MANAGED = {
    'pre-commit': 'precommit',
    'pre-merge-commit': 'precommit',
    'commit-msg': 'commitmsg "$1"',
    'reference-transaction': 'refcheck "$1"',
};
const LEGACY_MANAGED = {
    'pre-commit': 'precommit',
    'commit-msg': 'commitmsg "$1"',
};

function hooksDir(repo) {
    const hp = gitConfig(repo.root, 'core.hooksPath');
    const dir = effectiveHooksDir(repo);
    if (!hp) return { dir, shared: false, warnings: [] };

    const scope = configScope(repo, 'core.hooksPath');
    const localScope = ['local', 'worktree'].includes(scope);
    const repositoryOwned = localScope && repositoryOwnsPath(repo, dir);
    const shared = !repositoryOwned || resolve(dir) === resolve(globalHooksDir());
    if (shared) {
        const where = scope ? `${scope} scope` : 'a non-local scope';
        const reason = localScope && !repositoryOwned
            ? `${where}, outside this repository`
            : where;
        return {
            dir,
            shared: true,
            warnings: [
                `core.hooksPath is set to "${hp}" at ${reason}; local hooks were not modified`,
            ],
        };
    }
    return {
        dir,
        shared: false,
        warnings: [`core.hooksPath is set to "${hp}"; hooks installed there`],
    };
}

function repositoryOwnsPath(repo, path) {
    const candidate = canonicalPath(path);
    return [repo.root, repo.commonDir, repo.gitDir]
        .filter(Boolean)
        .map(canonicalPath)
        .some((root) => {
            const rel = relative(root, candidate);
            return rel === '' || (!rel.startsWith(`..${sep}`)
                && rel !== '..' && !isAbsolute(rel));
        });
}

function canonicalPath(path) {
    let current = resolve(path);
    const tail = [];
    for (;;) {
        try {
            return resolve(realpathSync(current), ...tail);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            const parent = dirname(current);
            if (parent === current) return resolve(path);
            tail.unshift(basename(current));
            current = parent;
        }
    }
}

// Ask Git for the path it actually uses. In a linked worktree this resolves to
// the common repository hooks directory, not <gitDir>/hooks.
function effectiveHooksDir(repo) {
    try {
        return execFileSync(
            'git',
            ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
            { cwd: repo.root, encoding: 'utf8' }
        ).trim();
    } catch {
        try {
            const path = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
                cwd: repo.root,
                encoding: 'utf8',
            }).trim();
            return isAbsolute(path) ? path : resolve(repo.root, path);
        } catch {
            return join(repo.commonDir || repo.gitDir, 'hooks');
        }
    }
}

function configScope(repo, key) {
    try {
        const line = execFileSync('git', ['config', '--show-scope', '--get', key], {
            cwd: repo.root,
            encoding: 'utf8',
        }).trim();
        return line.split(/\s/, 1)[0];
    } catch {
        // Older Git versions do not support --show-scope. Only classify a
        // value as local when we can prove it; the conservative fallback keeps
        // a global dispatcher from being overwritten.
        try {
            execFileSync('git', ['config', '--local', '--get', key], {
                cwd: repo.root,
                stdio: ['ignore', 'ignore', 'ignore'],
            });
            return 'local';
        } catch {
            return '';
        }
    }
}

function entry(path) {
    try {
        return lstatSync(path);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function snapshotFile(path) {
    const stat = entry(path);
    if (!stat) return { path, existed: false };
    if (!stat.isFile()) throw new Error(`cannot snapshot non-file hook path "${path}"`);
    return {
        path,
        existed: true,
        content: readFileSync(path),
        mode: stat.mode & 0o777,
    };
}

function rollbackFiles(snapshots, originalError) {
    const failures = [];
    for (const snapshot of [...snapshots].reverse()) {
        try {
            const current = entry(snapshot.path);
            if (current?.isSymbolicLink()) {
                throw new Error('path became a symlink during installation');
            }
            if (snapshot.existed) {
                atomicWrite(snapshot.path, snapshot.content, { mode: snapshot.mode });
                chmodSync(snapshot.path, snapshot.mode);
            } else if (current) {
                if (!current.isFile()) throw new Error('path became a non-file during installation');
                unlinkSync(snapshot.path);
            }
        } catch (error) {
            failures.push(`${snapshot.path}: ${error.message}`);
        }
    }
    if (failures.length) {
        throw new Error(
            `${originalError.message}; hook rollback also failed: ${failures.join('; ')}`,
            { cause: originalError },
        );
    }
    throw originalError;
}

function symlinkWarning(name) {
    return `${name} is a symlink; refusing to follow or overwrite it`;
}

function chainDir(repo) {
    // Chained predecessors live in common repository state (shared by linked
    // worktrees). repo.stateDir is always join(commonDir, 'aimhooman'), so this
    // resolves to <commonDir>/aimhooman/chained regardless of the hooks dir.
    // Global hooks (installGlobalHooks) keep their chained backups in the hooks
    // dir itself; hookDiagnostics special-cases that path.
    return join(repo.stateDir, 'chained');
}

// unrestoredChainedBackups lists predecessor hook backups still on disk after
// an uninstall attempt. A non-empty result means restore did not finish for
// those hooks (a per-hook failure left the user's original hook existing only
// in the backup), so the caller must NOT purge stateDir or the originals would
// be destroyed. Only managed hook names count; other files are ignored.
export function unrestoredChainedBackups(repo) {
    let entries;
    try {
        entries = readdirSync(chainDir(repo));
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    return entries.filter((name) => Object.prototype.hasOwnProperty.call(MANAGED, name)).sort();
}

// globalHooksDir is the aimhooman global hooks path (~/.aimhooman/hooks).
export function globalHooksDir() {
    return join(homedir(), '.aimhooman', 'hooks');
}

// installGlobalHooks writes aimhooman dispatchers to ~/.aimhooman/hooks for global use.
export function installGlobalHooks(cliPath, options = {}) {
    const dir = options.dir || globalHooksDir();
    mkdirSync(dir, { recursive: true });
    const installed = [];
    const skipped = [];
    const warnings = [];
    for (const name of Object.keys(MANAGED)) {
        const dest = join(dir, name);
        const current = entry(dest);
        if (current?.isSymbolicLink()) {
            skipped.push(name);
            warnings.push(symlinkWarning(name));
        } else if (current && !ownedHook(readFileSync(dest, 'utf8'), name)) {
            skipped.push(name);
            warnings.push(`${name} already exists and is not managed by aimhooman; refusing to overwrite it`);
        }
    }
    // Preflight every destination so installation is all-or-nothing.
    if (skipped.length) return { dir, installed, skipped: skipped.sort(), warnings };
    const destinations = Object.keys(MANAGED).map((name) => join(dir, name));
    const snapshots = destinations.map(snapshotFile);
    const writeHook = options.writeHook || atomicWrite;
    try {
        for (const [name, cmd] of Object.entries(MANAGED)) {
            const dest = join(dir, name);
            writeHook(dest, hookScript(name, cmd, cliPath, join(dir, 'chained', name)), { mode: 0o755 });
            chmodSync(dest, 0o755);
            installed.push(name);
        }
    } catch (error) {
        rollbackFiles(snapshots, error);
    }
    return { dir, installed: installed.sort(), skipped: skipped.sort(), warnings };
}

// uninstallGlobalHooks removes aimhooman-managed dispatchers from the global
// hooks dir. Filesystem errors propagate so callers cannot report a partial
// removal as success; the directory itself is left in place.
export function uninstallGlobalHooks(options = {}) {
    const dir = options.dir || globalHooksDir();
    const readHook = options.readHook || readFileSync;
    const unlinkHook = options.unlinkHook || unlinkSync;
    const removed = [];
    const warnings = [];
    for (const name of Object.keys(MANAGED)) {
        const dest = join(dir, name);
        if (entry(dest)?.isSymbolicLink()) {
            warnings.push(symlinkWarning(name));
            continue;
        }
        const current = entry(dest);
        if (!current) continue;
        if (ownedHook(readHook(dest, 'utf8'), name)) {
            unlinkHook(dest);
            removed.push(name);
        }
    }
    return { dir, removed: removed.sort(), warnings };
}

// installHooks writes aimhooman dispatchers, chaining any existing foreign hooks.
export function installHooks(repo, cliPath, options = {}) {
    const { dir, shared, warnings } = hooksDir(repo);
    if (shared) return { installed: [], chained: [], warnings, shared: true };
    return withLock(join(dir, '.aimhooman-hooks.lock'), () => (
        installHooksLocked(repo, cliPath, options, dir, warnings)
    ));
}

function installHooksLocked(repo, cliPath, options, dir, warnings) {
    mkdirSync(dir, { recursive: true });
    const chainedDir = chainDir(repo);
    const installed = [];
    const chained = [];
    let unsafe = false;
    for (const name of Object.keys(MANAGED)) {
        const dest = join(dir, name);
        const current = entry(dest);
        const chainedPath = join(chainedDir, name);
        if (current?.isSymbolicLink()) {
            warnings.push(symlinkWarning(name));
            unsafe = true;
            continue;
        }
        if (entry(chainedPath)?.isSymbolicLink()) {
            warnings.push(`${name} chained backup is a symlink; refusing to use it`);
            unsafe = true;
            continue;
        }
        if (current && ownedHook(readFileSync(dest, 'utf8'), name)
            && !ownedForChain(readFileSync(dest, 'utf8'), name, chainedPath)) {
            warnings.push(`${name} is managed for another repository; refusing to overwrite it`);
            unsafe = true;
        }
    }
    // Do not leave a repository with only part of the policy hook set.
    if (unsafe) return { installed, chained, warnings, shared: false };

    const paths = Object.keys(MANAGED).flatMap((name) => [
        join(dir, name),
        join(chainedDir, name),
    ]);
    const snapshots = paths.map(snapshotFile);
    const writeHook = options.writeHook || atomicWrite;
    try {
        for (const [name, cmd] of Object.entries(MANAGED)) {
            const dest = join(dir, name);
            const current = entry(dest);
            if (current) {
                const cur = readFileSync(dest);
                if (!ownedHook(cur, name)) {
                    mkdirSync(chainedDir, { recursive: true });
                    const chainedPath = join(chainedDir, name);
                    const predecessorMode = current.mode & 0o777;
                    writeHook(chainedPath, cur, { mode: predecessorMode });
                    chmodSync(chainedPath, predecessorMode);
                    chained.push(name);
                }
            }
            writeHook(dest, hookScript(name, cmd, cliPath, join(chainedDir, name)), { mode: 0o755 });
            chmodSync(dest, 0o755);
            installed.push(name);
        }
    } catch (error) {
        rollbackFiles(snapshots, error);
    }
    return { installed: installed.sort(), chained: chained.sort(), warnings, shared: false };
}

// uninstallHooks removes aimhooman hooks and restores any chained originals.
// Best-effort and atomic across the hook set: a filesystem error on one hook
// is recorded as a failure and the remaining hooks are still processed, so a
// re-run self-heals (already-processed hooks are skipped via ownedHook).
export function uninstallHooks(repo) {
    const { dir, shared, warnings } = hooksDir(repo);
    if (shared) return { removed: [], restored: [], warnings, failures: [] };
    return withLock(join(dir, '.aimhooman-hooks.lock'), () => (
        uninstallHooksLocked(repo, dir, warnings)
    ));
}

function uninstallHooksLocked(repo, dir, warnings) {
    const chainedDir = chainDir(repo);
    const removed = [];
    const restored = [];
    const failures = [];
    for (const name of Object.keys(MANAGED)) {
        const dest = join(dir, name);
        let current;
        try {
            current = entry(dest);
        } catch (error) {
            failures.push(`${name}: cannot inspect hook: ${error.message}`);
            continue;
        }
        if (!current) continue;
        if (current.isSymbolicLink()) {
            warnings.push(symlinkWarning(name));
            continue;
        }
        try {
            const chained = join(chainedDir, name);
            const content = readFileSync(dest, 'utf8');
            if (!ownedHook(content, name)) continue;
            if (!ownedForChain(content, name, chained)) {
                warnings.push(`${name} is managed for another repository; refusing to remove it`);
                continue;
            }
            const predecessor = entry(chained);
            if (predecessor?.isSymbolicLink()) {
                warnings.push(`${name} chained backup is a symlink; refusing to restore it`);
                continue;
            }
            if (predecessor) {
                const predecessorMode = predecessor.mode & 0o777;
                atomicWrite(dest, readFileSync(chained), { mode: predecessorMode });
                chmodSync(dest, predecessorMode);
                unlinkSync(chained);
                restored.push(name);
            } else {
                unlinkSync(dest);
            }
            removed.push(name);
        } catch (error) {
            failures.push(`${name}: ${error.message}`);
        }
    }
    return { removed: removed.sort(), restored: restored.sort(), warnings, failures };
}

// hookDiagnostics reports both dispatcher integrity and whether its configured
// command can be reached from the current environment.
export function hookDiagnostics(repo) {
    const { dir, shared } = hooksDir(repo);
    // Global hooks (installGlobalHooks) keep chained backups in the hooks dir
    // itself; local hooks keep them in repo state via chainDir. Diagnose the
    // path the dispatcher actually embeds, not the repo-relative default.
    const globalDir = globalHooksDir();
    const chained = resolve(dir) === resolve(globalDir)
        ? join(globalDir, 'chained')
        : chainDir(repo);
    return Object.keys(MANAGED).sort().map((name) => {
        const path = join(dir, name);
        const base = { name, path, chainedPath: join(chained, name), shared };
        let stat;
        try {
            stat = entry(path);
        } catch (error) {
            return {
                ...base,
                managed: false,
                reachable: false,
                reason: `cannot inspect hook: ${error.message}`,
            };
        }
        if (!stat) return { ...base, managed: false, reachable: false, reason: 'missing' };
        if (stat.isSymbolicLink()) {
            return { ...base, managed: false, reachable: false, reason: 'symlink' };
        }
        let content;
        try {
            content = readFileSync(path, 'utf8');
        } catch (error) {
            return {
                ...base,
                managed: false,
                reachable: false,
                reason: `unreadable: ${error.message}`,
            };
        }
        const inspected = inspectHook(content, name);
        const executable = hookFileExecutable(stat);
        if (!inspected.valid) {
            return {
                ...base,
                managed: false,
                reachable: false,
                executable,
                reason: inspected.reason,
            };
        }
        if (!ownedForChain(content, name, base.chainedPath)) {
            return {
                ...base,
                managed: false,
                reachable: false,
                executable,
                reason: 'managed for another repository',
            };
        }
        const nodeReachable = regularExecutableFile(inspected.nodePath);
        const embeddedReachable = regularReadableFile(inspected.cliPath);
        const gitReachable = pathCommandReachable('git', inspected.pathValue);
        let chainedSafe = true;
        try {
            chainedSafe = !entry(base.chainedPath)?.isSymbolicLink();
        } catch {
            chainedSafe = false;
        }
        const reachable = nodeReachable
            && embeddedReachable
            && gitReachable
            && chainedSafe
            && inspected.shellPathCompatible;
        return {
            ...base,
            managed: true,
            reachable,
            executable,
            version: inspected.version,
            fingerprint: inspected.fingerprint,
            cliPath: inspected.cliPath,
            nodePath: inspected.nodePath,
            embeddedReachable,
            nodeReachable,
            gitReachable,
            chainedSafe,
            shellPathCompatible: inspected.shellPathCompatible,
            reason: !executable
                ? 'not executable'
                : reachable
                    ? ''
                    : !chainedSafe
                        ? 'chained predecessor is a symlink'
                        : !inspected.shellPathCompatible
                            ? 'dispatcher PATH is incompatible with the Git shell; run aimhooman init again'
                            : 'aimhooman command is not reachable',
        };
    });
}

// installedHooks lists current, executable dispatchers whose fingerprint and
// command reachability have both been verified.
export function installedHooks(repo) {
    return hookDiagnostics(repo)
        .filter((hook) => hook.managed && hook.executable && hook.reachable)
        .map((hook) => hook.name)
        .sort();
}

// activeGitHook reports whether Git can execute an unmanaged hook that runs
// outside aimhooman's dispatcher chain.
export function activeGitHook(repo, name) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(name))) throw new Error('invalid Git hook name');
    const path = join(effectiveHooksDir(repo), name);
    try {
        const stat = statSync(path);
        return { name, path, active: hookFileExecutable(stat) };
    } catch (error) {
        if (error?.code === 'ENOENT') return { name, path, active: false };
        throw error;
    }
}

function hookScript(name, cmd, cliPath, chainedPath) {
    const resolvedCliPath = resolve(String(cliPath));
    const cliMetadata = Buffer.from(resolvedCliPath, 'utf8').toString('base64url');
    const nodePath = process.execPath;
    const pathValue = String(process.env.PATH || '')
        .split(delimiter)
        .filter((directory) => directory && isAbsolute(directory))
        .join(delimiter);
    const shellPathValue = hookPathForShell(pathValue);
    const nodeMetadata = Buffer.from(nodePath, 'utf8').toString('base64url');
    const pathMetadata = Buffer.from(pathValue, 'utf8').toString('base64url');
    const captureTree = name === 'commit-msg'
        ? `AIMHOOMAN_COMMIT_TREE=$(PATH="$AIMHOOMAN_PATH" git write-tree) || {
  echo "aimhooman: cannot snapshot the would-be commit tree" >&2
  exit 30
}
`
        : '';
    const captureTransaction = name === 'reference-transaction'
        ? `AIMHOOMAN_REF_UPDATES=$(
  while IFS= read -r AIMHOOMAN_REF_UPDATE || [ -n "$AIMHOOMAN_REF_UPDATE" ]; do
    printf '%s\\n' "$AIMHOOMAN_REF_UPDATE" || exit $?
  done
) || exit $?
`
        : '';
    const chainedInvocation = name === 'reference-transaction'
        ? `  printf '%s\\n' "$AIMHOOMAN_REF_UPDATES" | "$CHAINED" "$@" || exit $?`
        : `  "$CHAINED" "$@" || exit $?`;
    const aimCommand = name === 'commit-msg'
        ? 'commitmsg "$1" --tree "$AIMHOOMAN_COMMIT_TREE"'
        : name === 'reference-transaction'
            ? 'refcheck "$1"'
            : cmd;
    const aimInvocation = name === 'reference-transaction'
        ? `printf '%s\\n' "$AIMHOOMAN_REF_UPDATES" | run_aimhooman ${aimCommand} || exit $?`
        : `run_aimhooman ${aimCommand} || exit $?`;
    const template = `#!/bin/sh -p
${MARKER} (${name})
# aimhooman-hook-version: ${HOOK_FORMAT_VERSION}
# aimhooman-hook-fingerprint: ${FINGERPRINT_PLACEHOLDER}
# aimhooman-cli-base64url: ${cliMetadata}
# aimhooman-node-base64url: ${nodeMetadata}
# aimhooman-path-base64url: ${pathMetadata}
# Managed by aimhooman. Remove with: aimhooman uninstall
AIMHOOMAN_CLI=${shq(resolvedCliPath)}
AIMHOOMAN_NODE=${shq(nodePath)}
AIMHOOMAN_PATH=${shq(shellPathValue)}
${captureTree}${captureTransaction}run_aimhooman() {
  if [ ! -f "$AIMHOOMAN_CLI" ] || [ ! -f "$AIMHOOMAN_NODE" ]; then
    echo "aimhooman: guard unavailable (aimhooman CLI or Node is missing); allowing this operation without protection. Reinstall aimhooman or remove the managed hooks." >&2
    return 0
  fi
  (
    unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_EXTRA_CA_CERTS
    unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_V8_COVERAGE NODE_DEBUG
    unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
    unset DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
    unset BASH_ENV ENV CDPATH
    PATH=$AIMHOOMAN_PATH
    AIMHOOMAN_ACTIVE_HOOK=${shq(name)}
    export PATH
    export AIMHOOMAN_ACTIVE_HOOK
    "$AIMHOOMAN_NODE" "$AIMHOOMAN_CLI" "$@"
  )
}
CHAINED=${shq(chainedPath)}
if [ -L "$CHAINED" ]; then
  echo "aimhooman: chained hook is a symlink; run 'aimhooman init' after restoring the original hook" >&2
  exit 126
fi
if [ -x "$CHAINED" ]; then
${chainedInvocation}
fi
${aimInvocation}
`;
    const fingerprint = hookFingerprint(template);
    return template.replace(FINGERPRINT_PLACEHOLDER, fingerprint);
}

function inspectHook(content, expectedName) {
    const text = String(content);
    const header = new RegExp(
        `^#!\\/bin\\/sh(?: -p)?\\n${escapeRegExp(MARKER)} \\(${escapeRegExp(expectedName)}\\)\\n` +
        `# aimhooman-hook-version: (\\d+)\\n` +
        '# aimhooman-hook-fingerprint: ([a-f0-9]{64})\\n' +
        '# aimhooman-cli-base64url: ([A-Za-z0-9_-]*)\\n' +
        '(?:# aimhooman-node-base64url: ([A-Za-z0-9_-]*)\\n)?' +
        '(?:# aimhooman-path-base64url: ([A-Za-z0-9_-]*)\\n)?'
    );
    const match = text.match(header);
    if (!match) return { valid: false, reason: 'managed header is missing or malformed' };
    const version = Number(match[1]);
    const fingerprint = match[2];
    const normalized = text.replace(
        `# aimhooman-hook-fingerprint: ${fingerprint}`,
        `# aimhooman-hook-fingerprint: ${FINGERPRINT_PLACEHOLDER}`
    );
    if (hookFingerprint(normalized) !== fingerprint) {
        return { valid: false, reason: 'managed hook fingerprint does not match' };
    }
    if (version !== HOOK_FORMAT_VERSION) {
        return {
            valid: false,
            version,
            fingerprint,
            reason: `unsupported managed hook version ${match[1]}`,
        };
    }
    const cliPath = decodeMetadata(match[3]);
    const nodePath = decodeMetadata(match[4]);
    const pathValue = decodeMetadata(match[5]);
    if (cliPath === null || nodePath === null || pathValue === null) {
        return { valid: false, reason: 'managed CLI metadata is invalid' };
    }
    const nativePathAssignment = `AIMHOOMAN_PATH=${shq(pathValue)}\n`;
    const shellPathAssignment = `AIMHOOMAN_PATH=${shq(hookPathForShell(pathValue))}\n`;
    const shellPathCompatible = text.includes(shellPathAssignment);
    if (
        !isAbsolute(cliPath)
        || !isAbsolute(nodePath)
        || !text.includes(`AIMHOOMAN_CLI=${shq(cliPath)}\n`)
        || !text.includes(`AIMHOOMAN_NODE=${shq(nodePath)}\n`)
        || (!shellPathCompatible && !text.includes(nativePathAssignment))
    ) {
        return { valid: false, reason: 'managed CLI metadata does not match the dispatcher' };
    }
    return {
        valid: true,
        owned: true,
        version,
        fingerprint,
        cliPath,
        nodePath,
        pathValue,
        shellPathCompatible,
    };
}

// Git executes hooks with a POSIX shell even on Windows. Keep the native PATH
// in authenticated metadata for diagnostics, but render drive and UNC entries
// in the form Git for Windows' shell accepts. MSYS converts the exported value
// back to a native PATH when the dispatcher starts the embedded Node binary.
export function hookPathForShell(pathValue, platform = process.platform) {
    const value = String(pathValue || '');
    if (platform !== 'win32') return value;
    return value.split(';').filter(Boolean).map((directory) => {
        const normalized = directory.replace(/\\/g, '/');
        const extendedUnc = normalized.match(/^\/\/\?\/UNC\/(.+)$/i);
        if (extendedUnc) return `//${extendedUnc[1]}`;
        const drive = normalized.match(/^(?:\/\/\?\/)?([A-Za-z]):(?:\/(.*))?$/);
        if (drive) {
            return `/${drive[1].toLowerCase()}${drive[2] === undefined ? '' : `/${drive[2]}`}`;
        }
        return normalized.startsWith('/') ? normalized : '';
    }).filter(Boolean).join(':');
}

function hookFingerprint(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function ownedHook(content, name) {
    const inspected = inspectHook(content, name);
    return inspected.valid || legacyHook(content, name);
}

function ownedForChain(content, name, chainedPath) {
    if (!ownedHook(content, name)) return false;
    return assignmentValue(content, 'CHAINED') === String(chainedPath);
}

function decodeMetadata(value) {
    if (typeof value !== 'string') return null;
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return Buffer.from(decoded, 'utf8').toString('base64url') === value ? decoded : null;
}

// Recognize only the exact pre-fingerprint dispatcher so an existing install
// can be upgraded without treating an arbitrary copied marker as ownership.
function legacyHook(content, name) {
    if (!Object.hasOwn(LEGACY_MANAGED, name)) return false;
    const cli = assignmentValue(content, 'AIMHOOMAN_CLI');
    const chained = assignmentValue(content, 'CHAINED');
    if (cli === null || chained === null) return false;
    return content === legacyHookScript(name, LEGACY_MANAGED[name], cli, chained);
}

function assignmentValue(content, key) {
    const match = String(content).match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (!match || !match[1].startsWith("'") || !match[1].endsWith("'")) return null;
    return match[1].slice(1, -1).split("'\\''").join("'");
}

function legacyHookScript(name, cmd, cliPath, chainedPath) {
    return `#!/bin/sh
${MARKER} (${name})
# Managed by aimhooman. Remove with: aimhooman uninstall
AIMHOOMAN_CLI=${shq(cliPath)}
run_aimhooman() {
  if [ -f "$AIMHOOMAN_CLI" ] && command -v node >/dev/null 2>&1; then
    node "$AIMHOOMAN_CLI" "$@"
  elif command -v aimhooman >/dev/null 2>&1; then
    aimhooman "$@"
  else
    echo "aimhooman: not found; skipping guard (npm i -g @rmyndharis/aimhooman)" >&2
    return 0
  fi
}
run_aimhooman ${cmd} || exit $?
CHAINED=${shq(chainedPath)}
if [ -x "$CHAINED" ]; then
  "$CHAINED" "$@" || exit $?
fi
`;
}

function regularReadableFile(path) {
    try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function regularExecutableFile(path) {
    try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function pathCommandReachable(
    command,
    pathValue = process.env.PATH,
    platform = process.platform,
) {
    // Node launches Git without a command shell. Windows batch files listed in
    // PATHEXT are therefore not valid substitutes for git.exe, even though a
    // shell lookup would find them.
    const extensions = platform === 'win32' ? ['.exe'] : [''];
    const pathDelimiter = platform === 'win32' ? ';' : delimiter;
    for (const directory of String(pathValue || '').split(pathDelimiter).filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = join(directory, command + extension);
            try {
                if (!statSync(candidate).isFile()) continue;
                accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
                return true;
            } catch {
                /* keep looking */
            }
        }
    }
    return false;
}

export function hookFileExecutable(stat, platform = process.platform) {
    if (!stat?.isFile?.()) return false;
    // Bit-mask approximation (any exec bit set). This diverges from git's
    // euid-aware access(X_OK) only for group/world-only exec modes (e.g. 0o770
    // set by a sharing tool) in shared-ownership repos — out of scope for this
    // tool, which writes 0o755 hooks for individual developers. git enforces the
    // real exec check at hook time; this is a diagnostic only. regularExecutableFile
    // uses accessSync(X_OK) where a live path is available.
    return platform === 'win32' || Boolean(stat.mode & 0o111);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shq(s) {
    return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}
