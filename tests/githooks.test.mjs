import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    chmodSync,
    copyFileSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    statSync,
    writeFileSync,
    appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import {
    hookDiagnostics,
    hookFileExecutable,
    hookPathForShell,
    installGlobalHooks,
    installHooks,
    installedHooks,
    pathCommandReachable,
    uninstallGlobalHooks,
    uninstallHooks,
} from '../src/githooks.mjs';
import { openRepo } from '../src/gitx.mjs';

const CLI = join(process.cwd(), 'bin/aimhooman.mjs');

function windowsCommands(name) {
    try {
        return execFileSync('where.exe', [name], { encoding: 'utf8' })
            .split(/\r?\n/)
            .filter(Boolean);
    } catch {
        return [];
    }
}

function resolveHookShell() {
    if (process.platform !== 'win32') return '/bin/sh';
    for (const gitPath of windowsCommands('git.exe')) {
        const gitDirectory = dirname(gitPath);
        const root = ['bin', 'cmd'].includes(basename(gitDirectory).toLowerCase())
            ? dirname(gitDirectory)
            : gitDirectory;
        for (const candidate of [join(root, 'bin', 'sh.exe'), join(root, 'usr', 'bin', 'sh.exe')]) {
            if (existsSync(candidate)) return candidate;
        }
    }
    const direct = windowsCommands('sh.exe').find((path) => existsSync(path));
    if (direct) return direct;
    throw new Error('Git for Windows sh.exe is required to execute generated hook tests');
}

const HOOK_SHELL = resolveHookShell();

function shellArgumentPath(path) {
    return process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

function comparableHookPath(path) {
    const normalized = String(path).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(base) {
    const root = join(base, 'repo');
    mkdirSync(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'README.md'), 'initial\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-q', '-m', 'initial']);
    return root;
}

function isolatedGitConfig(base, fn) {
    const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
    const oldNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
        return fn();
    } finally {
        if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
        if (oldNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = oldNoSystem;
    }
}

test('linked worktree uses common hooks and preserves/restores an existing hook', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-worktree-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const linked = join(base, 'linked');
            git(root, ['worktree', 'add', '-q', '-b', 'linked-test', linked]);

            const repo = openRepo(linked);
            const effective = git(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            const oldHook = '#!/bin/sh\necho existing\n';
            mkdirSync(effective, { recursive: true });
            writeFileSync(join(effective, 'pre-commit'), oldHook, { mode: 0o644 });
            chmodSync(join(effective, 'pre-commit'), 0o644);
            const originalMode = statSync(join(effective, 'pre-commit')).mode & 0o777;

            const installed = installHooks(repo, '/tmp/aimhooman-cli.mjs');
            assert.deepEqual(installed.installed, ['commit-msg', 'pre-commit', 'pre-merge-commit', 'reference-transaction']);
            assert.deepEqual(installed.chained, ['pre-commit']);
            assert.equal(hookFileExecutable(statSync(join(effective, 'pre-commit'))), true);
            assert.ok(existsSync(join(root, '.git/hooks/pre-commit')));
            assert.equal(existsSync(join(repo.gitDir, 'hooks/pre-commit')), false);
            assert.equal(
                readFileSync(join(root, '.git/aimhooman/chained/pre-commit'), 'utf8'),
                oldHook
            );
            assert.equal(
                statSync(join(root, '.git/aimhooman/chained/pre-commit')).mode & 0o777,
                originalMode,
            );

            const uninstalled = uninstallHooks(repo);
            assert.deepEqual(uninstalled.removed, ['commit-msg', 'pre-commit', 'pre-merge-commit', 'reference-transaction']);
            assert.deepEqual(uninstalled.restored, ['pre-commit']);
            assert.equal(readFileSync(join(effective, 'pre-commit'), 'utf8'), oldHook);
            assert.equal(
                hookFileExecutable(statSync(join(effective, 'pre-commit'))),
                process.platform === 'win32',
            );
            assert.equal(statSync(join(effective, 'pre-commit')).mode & 0o777, originalMode);
            assert.equal(existsSync(join(effective, 'commit-msg')), false);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('uninstall --purge-state keeps state when a chained predecessor backup is unrestored', () => {
    // Guards the data-loss path: a per-hook restore failure leaves the user's
    // original hook existing only in <stateDir>/chained, so --purge-state must
    // NOT wipe stateDir or the original is destroyed irrecoverably.
    const base = mkdtempSync(join(tmpdir(), 'aim-purge-guard-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = join(root, '.git', 'hooks');
            mkdirSync(hooks, { recursive: true });
            const foreign = '#!/bin/sh\necho foreign\n';
            writeFileSync(join(hooks, 'pre-commit'), foreign, { mode: 0o755 });
            execFileSync(process.execPath, [CLI, 'init'], { cwd: root });
            const chainedPre = join(root, '.git', 'aimhooman', 'chained', 'pre-commit');
            assert.ok(existsSync(chainedPre), 'chained backup created on install');
            // Simulate the post-failure state: the live aimhooman dispatcher is
            // gone while the chained backup remains, so the only copy of the
            // user's original hook is that backup. uninstallHooks skips the
            // missing live hook, leaving the backup orphaned.
            rmSync(join(hooks, 'pre-commit'), { force: true });
            const result = spawnSync(process.execPath, [CLI, 'uninstall', '--purge-state'], {
                cwd: root, encoding: 'utf8',
            });
            assert.equal(result.status, 30);
            assert.match(result.stderr, /state NOT purged/);
            assert.match(result.stderr, /unrestored/);
            // The user's original hook (the chained backup) survives the purge.
            assert.ok(existsSync(chainedPre), 'chained backup preserved, not purged');
            assert.equal(readFileSync(chainedPre, 'utf8'), foreign);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('installedHooks executable and reachable filters are load-bearing', () => {
    // A mutation dropping `&& hook.executable && hook.reachable` from
    // installedHooks would let a strict repo commit past a non-executable or
    // unreachable dispatcher (the strict PreToolUse guard treats a hook listed
    // by installedHooks as present). Pin both filters.
    const base = mkdtempSync(join(tmpdir(), 'aim-installed-filters-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            assert.ok(installedHooks(openRepo(root)).includes('pre-commit'));
            // (a) POSIX honors execute bits; Windows treats a regular hook file
            // as executable because its filesystem does not preserve that mode.
            if (process.platform === 'win32') {
                assert.ok(installedHooks(openRepo(root)).includes('pre-commit'));
            } else {
                chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o644);
                assert.ok(
                    !installedHooks(openRepo(root)).includes('pre-commit'),
                    'a non-executable dispatcher must not count as installed',
                );
            }
            // (b) a dispatcher whose embedded cliPath is unreachable is not installed
            const root2 = join(base, 'repo2');
            mkdirSync(root2);
            git(root2, ['init', '-q']);
            git(root2, ['config', 'user.email', 'test@example.com']);
            git(root2, ['config', 'user.name', 'Test']);
            writeFileSync(join(root2, 'README.md'), 'x\n');
            git(root2, ['add', 'README.md']);
            git(root2, ['commit', '-q', '-m', 'x']);
            installHooks(openRepo(root2), '/does/not/exist/aimhooman.mjs');
            assert.ok(
                !installedHooks(openRepo(root2)).includes('pre-commit'),
                'a dispatcher with an unreachable cliPath must not count as installed',
            );
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('install/uninstall honors a local-scope core.hooksPath once it is excluded', () => {
    // A team may set core.hooksPath at local scope to a worktree hooks dir.
    // Since B2, a worktree hooks path is repository content in waiting (the next
    // `git add` would stage the dispatcher's machine-local paths), so install
    // refuses until the path is excluded — proving the team intends it to stay
    // local. Once excluded, install writes dispatchers there (not .git/hooks),
    // status finds them, and uninstall removes them.
    const base = mkdtempSync(join(tmpdir(), 'aim-local-hookspath-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const custom = join(root, '.team-hooks');
            mkdirSync(custom, { recursive: true });
            git(root, ['config', '--local', 'core.hooksPath', custom]);

            // Before exclude: refused, treated as worktree content that Git will
            // track. No dispatcher written; the worktree stays clean.
            const refused = installHooks(openRepo(root), CLI);
            assert.equal(refused.shared, true, 'untracked worktree hooksPath is shared until excluded');
            assert.deepEqual(refused.installed, []);
            assert.equal(existsSync(join(custom, 'pre-commit')), false);
            assert.match(refused.warnings.join('\n'), /worktree/);

            // Exclude it, then install proceeds.
            appendFileSync(join(root, '.git', 'info', 'exclude'), '.team-hooks/\n');
            installHooks(openRepo(root), CLI);
            assert.ok(existsSync(join(custom, 'pre-commit')), 'dispatcher written to the excluded hooksPath');
            assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false);
            assert.ok(installedHooks(openRepo(root)).includes('pre-commit'));
            const uninstalled = uninstallHooks(openRepo(root));
            assert.deepEqual(uninstalled.removed, ['commit-msg', 'pre-commit', 'pre-merge-commit', 'reference-transaction']);
            assert.equal(existsSync(join(custom, 'pre-commit')), false);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// B10-F2: an UNTRACKED worktree hooksPath (a freshly created `.husky` before the
// first commit) is repository content in waiting — the next `git add` would
// stage the dispatcher's machine-local absolute CLI/Node/PATH into history.
// aimhooman must refuse to install into it until the team excludes the path.
// Before B2, the guard only checked whether the path was already tracked, so an
// untracked `.husky` got a dispatcher and B10a6's `git add -A && git commit`
// landed machine-local paths in the repo.
test('an untracked worktree hooksPath is refused until excluded', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-untracked-hookspath-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const custom = join(root, '.husky');
            mkdirSync(custom, { recursive: true });
            git(root, ['config', '--local', 'core.hooksPath', custom]);

            // Refused: worktree content, not excluded. No dispatcher, clean tree.
            const refused = installHooks(openRepo(root), CLI);
            assert.equal(refused.shared, true, 'untracked worktree hooksPath is shared until excluded');
            assert.deepEqual(refused.installed, []);
            assert.equal(existsSync(join(custom, 'pre-commit')), false);
            assert.match(refused.warnings.join('\n'), /worktree/);
            assert.equal(git(root, ['status', '--short']), '', 'refusal must not dirty the worktree');

            // A subsequent `git add -A` must not stage any dispatcher, because none
            // was written. This is the B10a6 leak shape — it must not recur.
            git(root, ['add', '-A']);
            assert.equal(git(root, ['status', '--short', '--untracked-files=all']), '');
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

const MANAGED_NAMES = ['commit-msg', 'pre-commit', 'pre-merge-commit', 'reference-transaction'];

test('a renamed repository still owns the dispatchers inside its own .git', () => {
    // The dispatcher bakes absolute paths, so moving the repository changes the
    // baked CHAINED value. The SHA-256 fingerprint still proves the file is ours,
    // and no second repository can own a file under this .git, so a stale path
    // string must not overrule it. Renaming a directory is ordinary work.
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-moved-repo-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            installHooks(openRepo(root), CLI);
            const moved = join(base, 'moved');
            renameSync(root, moved);

            const repo = openRepo(moved);
            assert.deepEqual(installedHooks(repo), MANAGED_NAMES, 'a moved repo still recognises its own guard');

            // init must be able to re-pin: it is the remedy every message names.
            const reinstalled = installHooks(openRepo(moved), CLI);
            assert.deepEqual(reinstalled.installed, MANAGED_NAMES);
            assert.deepEqual(reinstalled.warnings, []);

            const rep = uninstallHooks(openRepo(moved));
            assert.deepEqual(rep.removed, MANAGED_NAMES, 'a moved repo can still let itself out');
            assert.deepEqual(rep.warnings, []);
            const hooks = git(moved, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            for (const name of MANAGED_NAMES) {
                assert.equal(existsSync(join(hooks, name)), false, name);
            }
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('a tracked hooks directory is treated as shared and never modified', () => {
    // husky and the vanilla .githooks pattern commit their hook scripts. Writing
    // a dispatcher into one stages this machine's absolute CLI, Node, and PATH
    // for the whole team: the hook dies for everyone else, and the PATH alone
    // discloses the developer's home directory and installed tooling.
    const base = mkdtempSync(join(tmpdir(), 'aim-tracked-hookspath-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const custom = join(root, '.husky');
            const teamHook = '#!/bin/sh\necho team pre-commit\n';
            mkdirSync(custom, { recursive: true });
            writeFileSync(join(custom, 'pre-commit'), teamHook);
            git(root, ['add', '-A', '.husky']);
            git(root, ['commit', '-q', '-m', 'add team hooks']);
            git(root, ['config', '--local', 'core.hooksPath', custom]);

            const result = installHooks(openRepo(root), CLI);
            assert.equal(result.shared, true, 'a tracked hooks directory is not ours to write to');
            assert.deepEqual(result.installed, []);
            assert.match(result.warnings.join('\n'), /tracked/);
            assert.equal(readFileSync(join(custom, 'pre-commit'), 'utf8'), teamHook);
            assert.equal(existsSync(join(custom, 'reference-transaction')), false);
            assert.equal(git(root, ['status', '--short']), '', 'init must not dirty the worktree');
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('local install and uninstall never modify a globally configured hooks path', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-global-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const shared = join(base, 'shared-hooks');
            mkdirSync(shared);
            const dispatcher = '#!/bin/sh\n# aimhooman-managed hook (pre-commit)\necho global\n';
            writeFileSync(join(shared, 'pre-commit'), dispatcher, { mode: 0o755 });
            git(root, ['config', '--global', 'core.hooksPath', shared]);

            const repo = openRepo(root);
            const installed = installHooks(repo, '/tmp/local-cli.mjs');
            assert.deepEqual(installed.installed, []);
            assert.match(installed.warnings.join('\n'), /global scope.*not modified/);
            assert.equal(readFileSync(join(shared, 'pre-commit'), 'utf8'), dispatcher);
            assert.equal(existsSync(join(shared, 'commit-msg')), false);
            assert.deepEqual(installedHooks(repo), []);

            const uninstalled = uninstallHooks(repo);
            assert.deepEqual(uninstalled.removed, []);
            assert.match(uninstalled.warnings.join('\n'), /global scope.*not modified/);
            assert.equal(readFileSync(join(shared, 'pre-commit'), 'utf8'), dispatcher);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('managed hook integrity and command reachability are verified', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-integrity-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            installHooks(repo, CLI);

            assert.deepEqual(installedHooks(repo), ['commit-msg', 'pre-commit', 'pre-merge-commit', 'reference-transaction']);
            for (const diagnostic of hookDiagnostics(repo)) {
                assert.equal(diagnostic.managed, true, diagnostic.reason);
                assert.equal(diagnostic.reachable, true, diagnostic.reason);
                assert.equal(diagnostic.version, 2);
                assert.equal(diagnostic.nodePath, process.execPath);
                assert.match(diagnostic.fingerprint, /^[a-f0-9]{64}$/);
            }

            const precommit = join(hooks, 'pre-commit');
            writeFileSync(precommit, readFileSync(precommit, 'utf8') + 'if then\n');
            chmodSync(precommit, 0o755);
            assert.deepEqual(installedHooks(repo), ['commit-msg', 'pre-merge-commit', 'reference-transaction']);
            assert.match(
                hookDiagnostics(repo).find((hook) => hook.name === 'pre-commit').reason,
                /fingerprint/
            );

            writeFileSync(
                precommit,
                '#!/bin/sh\n# aimhooman-managed hook (pre-commit)\nexit 0\n',
                { mode: 0o755 }
            );
            chmodSync(precommit, 0o755);
            assert.deepEqual(installedHooks(repo), ['commit-msg', 'pre-merge-commit', 'reference-transaction']);
            assert.equal(
                hookDiagnostics(repo).find((hook) => hook.name === 'pre-commit').managed,
                false
            );
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('a self-consistent unknown hook format is preserved as foreign content', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-unknown-format-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            const placeholder = '0'.repeat(64);
            const template = `#!/bin/sh -p\n` +
                '# aimhooman-managed hook (pre-commit)\n' +
                '# aimhooman-hook-version: 999\n' +
                `# aimhooman-hook-fingerprint: ${placeholder}\n` +
                '# aimhooman-cli-base64url: L3RtcC9mb3JlaWdu\n' +
                'exit 0\n';
            const fingerprint = createHash('sha256').update(template).digest('hex');
            const foreign = template.replace(placeholder, fingerprint);
            writeFileSync(join(hooks, 'pre-commit'), foreign, { mode: 0o755 });
            chmodSync(join(hooks, 'pre-commit'), 0o755);

            const report = installHooks(repo, CLI);
            assert.deepEqual(report.chained, ['pre-commit']);
            assert.equal(
                readFileSync(join(repo.stateDir, 'chained', 'pre-commit'), 'utf8'),
                foreign,
            );
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('Windows treats a regular managed hook as executable without POSIX mode bits', () => {
    const regularWithoutExecuteBits = { isFile: () => true, mode: 0o644 };
    assert.equal(hookFileExecutable(regularWithoutExecuteBits, 'win32'), true);
    assert.equal(hookFileExecutable(regularWithoutExecuteBits, 'linux'), false);
    assert.equal(hookFileExecutable({ isFile: () => false, mode: 0o755 }, 'win32'), false);
});

test('Windows hook PATH values are rendered for Git Bash without trusting runtime PATH', () => {
    assert.equal(
        hookPathForShell(
            'C:\\Program Files\\Git\\cmd;D:\\tool chain\\bin;\\\\server\\share\\bin;/usr/bin',
            'win32',
        ),
        '/c/Program Files/Git/cmd:/d/tool chain/bin://server/share/bin:/usr/bin',
    );
    assert.equal(
        hookPathForShell('\\\\?\\C:\\trusted\\bin;\\\\?\\UNC\\host\\share\\bin', 'win32'),
        '/c/trusted/bin://host/share/bin',
    );
    assert.equal(hookPathForShell('/usr/local/bin:/usr/bin', 'linux'), '/usr/local/bin:/usr/bin');
});

test('Windows Git reachability does not accept shell-only batch shims', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aim-hooks-win-git-path-'));
    try {
        for (const name of ['git', 'git.cmd', 'git.bat']) writeFileSync(join(directory, name), '');
        assert.equal(pathCommandReachable('git', directory, 'win32'), false);
        writeFileSync(join(directory, 'git.exe'), '');
        assert.equal(pathCommandReachable('git', directory, 'win32'), true);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('generated dispatchers use builtin ref capture and accept safe Git updates', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-shell-path-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            const referenceHook = readFileSync(join(hooks, 'reference-transaction'), 'utf8');
            assert.match(referenceHook, /while IFS= read -r AIMHOOMAN_REF_UPDATE/);
            assert.doesNotMatch(referenceHook, /while AIMHOOMAN_REF_UPDATE=/);
            assert.doesNotMatch(referenceHook, /PATH="\$AIMHOOMAN_PATH" cat/);
            // committed/aborted short-circuit before the Node spawn, so an ordinary
            // commit does not pay a cold start for a phase refcheck only no-ops.
            assert.match(referenceHook, /case "\$1" in committed\|aborted\) exit 0 ;; esac/);
            // The dispatcher exports a V8 compile cache rooted in per-install
            // state, so repeated hook spawns skip module recompilation and
            // --purge-state removes the cache along with the rest of the state.
            const compileCache = join(openRepo(root).stateDir, 'compile-cache');
            assert.ok(
                referenceHook.includes(`AIMHOOMAN_COMPILE_CACHE='${compileCache}'`),
                'reference-transaction dispatcher must point NODE_COMPILE_CACHE at the state directory',
            );
            assert.match(referenceHook, /NODE_COMPILE_CACHE=\$AIMHOOMAN_COMPILE_CACHE/);

            writeFileSync(join(root, 'safe.txt'), 'safe\n');
            git(root, ['add', 'safe.txt']);
            const commit = spawnSync('git', ['commit', '-m', 'safe update'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.equal(commit.status, 0, commit.stderr);
            assert.doesNotMatch(commit.stderr, /command not found/);
            // The hook spawns above prove the export works end to end: Node
            // created the cache directory and filled it on a plain commit.
            assert.ok(existsSync(compileCache), 'hook spawns must create the compile cache directory');

            const update = spawnSync('git', [
                'update-ref', 'refs/tags/shell-path-smoke', 'HEAD',
            ], { cwd: root, encoding: 'utf8' });
            assert.equal(update.status, 0, update.stderr);
            assert.doesNotMatch(update.stderr, /command not found/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('local hook installation rolls back dispatchers and chained backups on write failure', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-rollback-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            const original = '#!/bin/sh\necho original\n';
            writeFileSync(join(hooks, 'pre-commit'), original, { mode: 0o755 });
            let writes = 0;
            assert.throws(() => installHooks(repo, CLI, {
                writeHook(path, content, options) {
                    writes += 1;
                    if (writes === 3) throw new Error('injected hook write failure');
                    writeFileSync(path, content, { mode: options.mode });
                },
            }), /injected hook write failure/);
            assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), original);
            assert.equal(existsSync(join(hooks, 'pre-merge-commit')), false);
            assert.equal(existsSync(join(hooks, 'commit-msg')), false);
            assert.equal(existsSync(join(repo.stateDir, 'chained', 'pre-commit')), false);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('global hook installation removes partial dispatchers on write failure', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-global-hooks-rollback-'));
    try {
        const hooks = join(base, 'hooks');
        let writes = 0;
        assert.throws(() => installGlobalHooks(CLI, {
            dir: hooks,
            writeHook(path, content, options) {
                writes += 1;
                if (writes === 2) throw new Error('injected global write failure');
                writeFileSync(path, content, { mode: options.mode });
            },
        }), /injected global write failure/);
        assert.equal(existsSync(join(hooks, 'pre-commit')), false);
        assert.equal(existsSync(join(hooks, 'pre-merge-commit')), false);
        assert.equal(existsSync(join(hooks, 'commit-msg')), false);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('foreign hook backups preserve non-UTF-8 bytes through install and uninstall', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-bytes-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hook = join(root, '.git', 'hooks', 'pre-commit');
            const original = Buffer.from([35, 33, 47, 98, 105, 110, 47, 115, 104, 10, 35, 255, 10, 101, 120, 105, 116, 32, 48, 10]);
            writeFileSync(hook, original, { mode: 0o755 });

            const installed = installHooks(repo, CLI);
            assert.ok(installed.chained.includes('pre-commit'));
            assert.deepEqual(
                readFileSync(join(repo.stateDir, 'chained', 'pre-commit')),
                original,
            );
            const removed = uninstallHooks(repo);
            assert.ok(removed.restored.includes('pre-commit'));
            assert.deepEqual(readFileSync(hook), original);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('local hooksPath outside the repository is treated as shared and never modified', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-external-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const shared = join(base, 'shared-hooks');
            mkdirSync(shared);
            const foreign = '#!/bin/sh\necho shared\n';
            writeFileSync(join(shared, 'pre-commit'), foreign, { mode: 0o755 });
            git(root, ['config', '--local', 'core.hooksPath', shared]);

            const installed = installHooks(openRepo(root), CLI);
            assert.equal(installed.shared, true);
            assert.deepEqual(installed.installed, []);
            assert.match(installed.warnings.join('\n'), /outside this repository/);
            assert.equal(readFileSync(join(shared, 'pre-commit'), 'utf8'), foreign);
            assert.equal(existsSync(join(shared, 'commit-msg')), false);

            const removed = uninstallHooks(openRepo(root));
            assert.deepEqual(removed.removed, []);
            assert.equal(readFileSync(join(shared, 'pre-commit'), 'utf8'), foreign);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('one hooks-directory lock serializes concurrent nested-repository installs', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-shared-race-'));
    const outer = join(base, 'outer');
    const inner = join(outer, 'inner');
    // shared lives inside inner (and thus inside outer's worktree too), so both
    // repos consider it inside their worktree. Since B2, a worktree hooksPath is
    // repository content in waiting unless excluded — and a shared hooks dir
    // used by two nested repos is exactly the "kept local" case that the exclude
    // opt-in covers, so both repos exclude it before pointing core.hooksPath at
    // it. This test is about lock contention between two repos on one hooks dir,
    // not about committed hooks.
    const shared = join(inner, 'shared-hooks');
    const marker = join(base, 'first-writing');
    const globalConfig = join(base, 'global.gitconfig');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const init = (root) => {
        mkdirSync(root, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root, env });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, env });
        writeFileSync(join(root, 'README.md'), 'fixture\n');
        execFileSync('git', ['add', 'README.md'], { cwd: root, env });
        execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root, env });
    };
    const script = `
import { writeFileSync } from 'node:fs';
import { installHooks } from ${JSON.stringify(new URL('../src/githooks.mjs', import.meta.url).href)};
import { atomicWrite } from ${JSON.stringify(new URL('../src/atomic-write.mjs', import.meta.url).href)};
import { openRepo } from ${JSON.stringify(new URL('../src/gitx.mjs', import.meta.url).href)};
const [cli, marker, delay] = process.argv.slice(1);
let first = true;
const repo = openRepo();
const result = installHooks(repo, cli, delay === 'yes' ? {
  writeHook(path, data, options) {
    if (first) {
      first = false;
      writeFileSync(marker, 'writing');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    atomicWrite(path, data, options);
  },
} : {});
process.stdout.write(JSON.stringify({ result, stateDir: repo.stateDir }));
`;
    const launch = (cwd, delay) => spawn(process.execPath, [
        '--input-type=module', '-e', script, CLI, marker, delay ? 'yes' : 'no',
    ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = (child) => new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    try {
        init(outer);
        init(inner);
        mkdirSync(shared);
        // Exclude the shared hooks dir in both repos so B2's worktree-content
        // guard treats it as intentionally local (the lock-contention scenario
        // is about shared local plumbing, not committed hooks).
        appendFileSync(join(outer, '.git', 'info', 'exclude'), 'inner/shared-hooks/\n');
        appendFileSync(join(inner, '.git', 'info', 'exclude'), 'shared-hooks/\n');
        execFileSync('git', ['config', '--local', 'core.hooksPath', shared], { cwd: outer, env });
        execFileSync('git', ['config', '--local', 'core.hooksPath', shared], { cwd: inner, env });

        const first = launch(outer, true);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !existsSync(marker)) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        assert.equal(existsSync(marker), true);
        const second = launch(inner, false);
        const [a, b] = await Promise.all([result(first), result(second)]);
        assert.equal(a.code, 0, a.stderr);
        assert.equal(b.code, 0, b.stderr);
        const firstInstall = JSON.parse(a.stdout);
        const secondInstall = JSON.parse(b.stdout);
        assert.deepEqual(firstInstall.result.installed, Object.keys({
            'commit-msg': 1,
            'pre-commit': 1,
            'pre-merge-commit': 1,
            'reference-transaction': 1,
        }).sort());
        assert.deepEqual(secondInstall.result.installed, []);
        assert.match(secondInstall.result.warnings.join('\n'), /another repository/);
        const dispatcher = comparableHookPath(readFileSync(join(shared, 'pre-commit'), 'utf8'));
        assert.ok(dispatcher.includes(comparableHookPath(
            join(firstInstall.stateDir, 'chained', 'pre-commit'),
        )));
        assert.ok(!dispatcher.includes(comparableHookPath(
            join(secondInstall.stateDir, 'chained', 'pre-commit'),
        )));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('global uninstall propagates dispatcher removal failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-global-uninstall-fault-'));
    try {
        installGlobalHooks(CLI, { dir });
        assert.throws(
            () => uninstallGlobalHooks({
                dir,
                unlinkHook() { throw Object.assign(new Error('read-only hooks directory'), { code: 'EACCES' }); },
            }),
            /read-only hooks directory/,
        );
        assert.ok(existsSync(join(dir, 'pre-commit')));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('commit-msg evaluates policy from the immutable would-be tree', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-tree-policy-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            writeFileSync(
                join(hooks, 'commit-msg'),
                '#!/bin/sh\ngit restore --staged .aimhooman.json\n',
                { mode: 0o755 },
            );
            writeFileSync(
                join(root, '.aimhooman.json'),
                JSON.stringify({ schema_version: 1, profile: 'strict' }) + '\n',
            );
            git(root, ['add', '.aimhooman.json']);
            execFileSync(process.execPath, [CLI, 'init'], { cwd: root });
            execFileSync(process.execPath, [CLI, 'review', '.aimhooman.json', '--head', 'HEAD'], { cwd: root });
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'Safe subject\n\nGenerated with Codex'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(commit.stderr, /attribution\.generated-with/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('commit-msg ignores a policy added to the live index after the would-be tree was captured', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-tree-add-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hook = join(root, '.git', 'hooks', 'commit-msg');
            writeFileSync(
                hook,
                '#!/bin/sh\nprintf \'{"schema_version":1,"profile":"strict"}\\n\' > .aimhooman.json\ngit add .aimhooman.json\n',
                { mode: 0o755 },
            );
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            writeFileSync(join(root, 'safe.txt'), 'safe\n');
            git(root, ['add', 'safe.txt']);

            const commit = spawnSync('git', ['commit', '-m', 'Safe subject\n\nGenerated with Codex'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.equal(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['log', '-1', '--format=%B']), 'Safe subject');
            assert.throws(() => git(root, ['show', 'HEAD:.aimhooman.json']));
            assert.match(git(root, ['diff', '--cached', '--name-only']), /\.aimhooman\.json/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('commit-msg ignores a strict policy replacement staged by its predecessor', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-tree-replace-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            writeFileSync(
                join(root, '.aimhooman.json'),
                JSON.stringify({ schema_version: 1, profile: 'strict' }) + '\n',
            );
            git(root, ['add', '.aimhooman.json']);
            git(root, ['commit', '-q', '-m', 'strict baseline']);
            const hook = join(root, '.git', 'hooks', 'commit-msg');
            writeFileSync(
                hook,
                '#!/bin/sh\nprintf \'{"schema_version":1,"profile":"clean"}\\n\' > .aimhooman.json\ngit add .aimhooman.json\n',
                { mode: 0o755 },
            );
            execFileSync(process.execPath, [CLI, 'init'], { cwd: root });
            writeFileSync(join(root, 'safe.txt'), 'safe\n');
            git(root, ['add', 'safe.txt']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'Generated with Codex'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(commit.stderr, /attribution\.generated-with/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('commit-msg performs the full captured-tree scan when pre-commit is missing', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-no-precommit-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            rmSync(join(root, '.git', 'hooks', 'pre-commit'));
            writeFileSync(join(root, '.env'), 'SECRET=bad\n');
            git(root, ['add', '-f', '.env']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'safe message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(commit.stderr, /secret\.dotenv/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('reference transaction rejects forbidden commits from cherry-pick, revert, am, and rebase', async (t) => {
    await t.test('cherry-pick', () => {
        const base = mkdtempSync(join(tmpdir(), 'aim-ref-cherry-'));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                const main = git(root, ['branch', '--show-current']);
                git(root, ['checkout', '-q', '-b', 'bad-side']);
                writeFileSync(join(root, '.env'), 'SECRET=bad\n');
                git(root, ['add', '-f', '.env']);
                git(root, ['commit', '-q', '-m', 'bad side']);
                const bad = git(root, ['rev-parse', 'HEAD']);
                git(root, ['checkout', '-q', main]);
                execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
                const before = git(root, ['rev-parse', 'HEAD']);
                const result = spawnSync('git', ['cherry-pick', bad], { cwd: root, encoding: 'utf8' });
                assert.notEqual(result.status, 0, result.stderr);
                assert.equal(git(root, ['rev-parse', 'HEAD']), before);
                assert.match(result.stderr, /secret\.dotenv|rejected before refs changed/);
                spawnSync('git', ['cherry-pick', '--abort'], { cwd: root });
            });
        } finally { rmSync(base, { recursive: true, force: true }); }
    });

    await t.test('revert', () => {
        const base = mkdtempSync(join(tmpdir(), 'aim-ref-revert-'));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                writeFileSync(join(root, '.env'), 'SECRET=bad\n');
                git(root, ['add', '-f', '.env']);
                git(root, ['commit', '-q', '-m', 'add secret']);
                git(root, ['rm', '-q', '.env']);
                git(root, ['commit', '-q', '-m', 'remove secret']);
                const removal = git(root, ['rev-parse', 'HEAD']);
                execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
                const before = git(root, ['rev-parse', 'HEAD']);
                const result = spawnSync('git', ['revert', '--no-edit', removal], { cwd: root, encoding: 'utf8' });
                assert.notEqual(result.status, 0, result.stderr);
                assert.equal(git(root, ['rev-parse', 'HEAD']), before);
                assert.match(result.stderr, /secret\.dotenv|rejected before refs changed/);
                spawnSync('git', ['revert', '--abort'], { cwd: root });
            });
        } finally { rmSync(base, { recursive: true, force: true }); }
    });

    await t.test('am', () => {
        const base = mkdtempSync(join(tmpdir(), 'aim-ref-am-'));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                const main = git(root, ['branch', '--show-current']);
                git(root, ['checkout', '-q', '-b', 'patch-side']);
                writeFileSync(join(root, '.env'), 'SECRET=bad\n');
                git(root, ['add', '-f', '.env']);
                git(root, ['commit', '-q', '-m', 'mail secret']);
                const patch = execFileSync('git', ['format-patch', '-1', '--stdout'], { cwd: root });
                git(root, ['checkout', '-q', main]);
                execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
                const before = git(root, ['rev-parse', 'HEAD']);
                const result = spawnSync('git', ['am'], { cwd: root, input: patch, encoding: 'utf8' });
                assert.notEqual(result.status, 0, result.stderr);
                assert.equal(git(root, ['rev-parse', 'HEAD']), before);
                assert.match(result.stderr, /secret\.dotenv|rejected before refs changed/);
                spawnSync('git', ['am', '--abort'], { cwd: root });
            });
        } finally { rmSync(base, { recursive: true, force: true }); }
    });

    await t.test('rebase', () => {
        const base = mkdtempSync(join(tmpdir(), 'aim-ref-rebase-'));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                const main = git(root, ['branch', '--show-current']);
                git(root, ['checkout', '-q', '-b', 'feature']);
                writeFileSync(join(root, '.env'), 'SECRET=bad\n');
                git(root, ['add', '-f', '.env']);
                git(root, ['commit', '-q', '-m', 'feature secret']);
                const featureBefore = git(root, ['rev-parse', 'refs/heads/feature']);
                git(root, ['checkout', '-q', main]);
                writeFileSync(join(root, 'upstream.txt'), 'upstream\n');
                git(root, ['add', 'upstream.txt']);
                git(root, ['commit', '-q', '-m', 'upstream']);
                git(root, ['checkout', '-q', 'feature']);
                execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
                const result = spawnSync('git', ['rebase', main], { cwd: root, encoding: 'utf8' });
                assert.notEqual(result.status, 0, result.stderr);
                assert.equal(git(root, ['rev-parse', 'refs/heads/feature']), featureBefore);
                assert.match(result.stderr, /secret\.dotenv|rejected before refs changed/);
                spawnSync('git', ['rebase', '--abort'], { cwd: root });
            });
        } finally { rmSync(base, { recursive: true, force: true }); }
    });
});

test('reference transaction scans old-to-new delta even when an ignored tag already reaches the commit', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-ref-poison-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            const before = git(root, ['rev-parse', 'HEAD']);
            writeFileSync(join(root, '.env'), 'SECRET=bad\n');
            git(root, ['add', '-f', '.env']);
            const tree = git(root, ['write-tree']);
            const commit = execFileSync('git', ['commit-tree', tree, '-p', before, '-m', 'poison'], {
                cwd: root,
                encoding: 'utf8',
            }).trim();
            git(root, ['update-ref', 'refs/tags/poison', commit]);
            const update = spawnSync('git', ['update-ref', `refs/heads/${git(root, ['branch', '--show-current'])}`, commit, before], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(update.status, 0, update.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(update.stderr, /secret\.dotenv|rejected before refs changed/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

function refcheckPrepared(root, input) {
    return spawnSync(process.execPath, [CLI, 'refcheck', 'prepared'], {
        cwd: root,
        input,
        encoding: 'utf8',
    });
}

// The reference-transaction tests below drive this scan through a real installed hook,
// and none of it reaches the coverage report: the generated hook unsets NODE_V8_COVERAGE
// before exec'ing the CLI, and inheriting that variable is how a profile gets collected
// at all. The scrub stays, because the guard must not honour Node environment handed to
// it by its caller. So drive the same command directly instead, with the reference-update
// lines Git writes to the hook's stdin.
test('refcheck prepared scans proposed updates and stops on input it cannot parse', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-refcheck-direct-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const before = git(root, ['rev-parse', 'HEAD']);
            mkdirSync(join(root, '.claude'));
            writeFileSync(join(root, '.claude', 'session.json'), '{"session":"local"}\n');
            git(root, ['add', '-f', '.claude/session.json']);
            git(root, ['commit', '--no-verify', '-q', '-m', 'session state']);
            const after = git(root, ['rev-parse', 'HEAD']);
            const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });

            const rejected = refcheckPrepared(root, `${before} ${after} refs/heads/${branch}\n`);
            assert.equal(rejected.status, 10, rejected.stderr);
            assert.match(rejected.stderr, /claude\.session-state/);
            assert.ok(
                rejected.stderr.includes(`proposed commit ${after} was rejected before refs changed`),
                rejected.stderr,
            );

            // A deletion carries an all-zero new object ID and introduces no commit, so
            // it scans nothing and still reaches the closing dispatcher check.
            const deletion = refcheckPrepared(root, `${after} ${'0'.repeat(40)} refs/heads/${branch}\n`);
            assert.equal(deletion.status, 0, deletion.stderr);

            const malformed = refcheckPrepared(root, 'garbage\n');
            assert.equal(malformed.status, 30, malformed.stderr);
            assert.match(malformed.stderr, /malformed reference-transaction input/);

            const badObject = refcheckPrepared(root, `zzz ${after} refs/heads/${branch}\n`);
            assert.equal(badObject.status, 30, badObject.stderr);
            assert.match(badObject.stderr, /malformed object ID in reference transaction/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('final reference scan uses enforcement state changed during the transaction', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-attestation-state-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = join(root, '.git', 'hooks');
            writeFileSync(
                join(hooks, 'reference-transaction'),
                `#!/bin/sh\ncat >/dev/null\nif [ "$1" = prepared ]; then\n  ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} deny safe.txt --reason changed-during-transaction >/dev/null\nfi\n`,
                { mode: 0o755 },
            );
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            writeFileSync(join(root, 'safe.txt'), 'checked before state change\n');
            git(root, ['add', 'safe.txt']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'same message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(commit.stderr, /safe\.txt|rejected before refs changed/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('final reference scan rechecks an identical no-verify retry from another Git process', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-attestation-stale-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = join(root, '.git', 'hooks');
            writeFileSync(
                join(hooks, 'reference-transaction'),
                '#!/bin/sh\ncat >/dev/null\n[ "$1" != prepared ] || exit 1\n',
                { mode: 0o755 },
            );
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            writeFileSync(join(root, 'safe.txt'), 'same tree\n');
            git(root, ['add', 'safe.txt']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const first = spawnSync('git', ['commit', '-m', 'same message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(first.status, 0, first.stderr);
            execFileSync(process.execPath, [CLI, 'deny', 'safe.txt', '--reason', 'new policy'], { cwd: root });
            const chained = join(root, '.git', 'aimhooman', 'chained', 'reference-transaction');
            writeFileSync(chained, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
            chmodSync(chained, 0o755);
            const retry = spawnSync('git', ['commit', '--no-verify', '-m', 'same message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(retry.status, 0, retry.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(retry.stderr, /safe\.txt|rejected before refs changed/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('final reference scan judges a commit by what it changes, while audit still flags legacy tracked secrets', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-ref-change-snapshot-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            writeFileSync(join(root, '.env'), 'SECRET=already-tracked\n');
            git(root, ['add', '-f', '.env']);
            git(root, ['commit', '--no-verify', '-q', '-m', 'legacy tracked file']);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            writeFileSync(
                join(root, '.aimhooman.json'),
                JSON.stringify({ schema_version: 1, profile: 'strict' }) + '\n',
            );
            git(root, ['add', '.aimhooman.json']);
            execFileSync(process.execPath, [
                CLI, 'review', '.aimhooman.json', '--head', 'HEAD', '--reason', 'enable strict',
            ], { cwd: root });
            const before = git(root, ['rev-parse', 'HEAD']);

            // A commit that does not touch the legacy .env is no longer held
            // hostage to it: the file already lives in history, and blocking an
            // unrelated commit could not remove it. The commit lands.
            const enabling = spawnSync('git', ['commit', '-m', 'enable strict'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.equal(enabling.status, 0, enabling.stderr);
            assert.notEqual(git(root, ['rev-parse', 'HEAD']), before);

            // The legacy secret is not silently forgotten: a tracked audit still
            // names it, so the team is told to clean it up without being bricked.
            const audit = spawnSync(process.execPath, [CLI, 'check', '--tracked'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(audit.status, 0, audit.stderr);
            assert.match(audit.stderr, /secret\.dotenv/);

            // A commit that introduces a NEW secret path is still stopped at the
            // final guard, even with --no-verify, because the path is in the
            // change set the guard scans.
            writeFileSync(join(root, '.env.fresh'), 'SECRET=brand-new\n');
            git(root, ['add', '-f', '.env.fresh']);
            const smuggling = spawnSync('git', ['commit', '--no-verify', '-m', 'smuggle fresh'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(smuggling.status, 0, smuggling.stderr);
            assert.match(smuggling.stderr, /secret\.dotenv|rejected before refs changed/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// `gh pr checkout` and `git fetch` import other people's commits. Their messages
// are not the local developer's to edit, so an AI co-author trailer on a fetched
// commit can no longer veto the checkout. A locally-authored commit keeps its
// message scanned, so --no-verify cannot smuggle attribution past the final guard.
test('reference transaction ignores attribution on imported commits but still scans local ones', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-ref-imported-message-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });

            // A commit carrying AI attribution, authored out-of-band (as a PR
            // commit would be) and imported into a new branch for review.
            const before = git(root, ['rev-parse', 'HEAD']);
            const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
            const imported = execFileSync(
                'git',
                ['commit-tree', tree, '-p', before, '-m', 'fix\n\nCo-authored-by: Claude <noreply@anthropic.com>'],
                { cwd: root, encoding: 'utf8' },
            ).trim();
            const fetchBranch = 'pr-under-review';
            const fetched = spawnSync(
                'git',
                ['fetch', '.', `${imported}:refs/heads/${fetchBranch}`],
                { cwd: root, encoding: 'utf8' },
            );
            assert.equal(fetched.status, 0, fetched.stderr);
            assert.equal(
                git(root, ['rev-parse', `refs/heads/${fetchBranch}`]),
                imported,
                'the imported branch must land so the PR can be reviewed',
            );

            // A locally-authored commit that smuggles the same trailer past
            // commit-msg with --no-verify is still stopped at the final guard.
            writeFileSync(join(root, 'note.md'), 'review\n');
            git(root, ['add', 'note.md']);
            const localBefore = git(root, ['rev-parse', 'HEAD']);
            const local = spawnSync(
                'git',
                ['commit', '--no-verify', '-m', 'local\n\nCo-authored-by: Claude <noreply@anthropic.com>'],
                { cwd: root, encoding: 'utf8' },
            );
            assert.notEqual(local.status, 0, local.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), localBefore);
            assert.match(local.stderr, /attribution\.claude-coauthor|rejected before refs changed/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// A secret path allowed in once (then un-allowed) used to block every later
// commit on the branch, because the full-tree scan re-tried the inherited file
// on each new commit. Judging by the change set instead means an unrelated edit
// lands; the secret stays visible to a tracked audit for cleanup.
test('removing a secret-path override no longer blocks unrelated later commits', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-ref-override-removal-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            writeFileSync(join(root, '.env.local'), 'TOKEN=fixture\n');
            git(root, ['add', '-f', '.env.local']);
            execFileSync(process.execPath, [
                CLI, 'allow', '.env.local', '--scope', 'secret-path', '--reason', 'fixture',
            ], { cwd: root });
            git(root, ['commit', '-q', '-m', 'add fixture env']);
            execFileSync(process.execPath, [CLI, 'override', 'reset', '--all'], { cwd: root });

            // Override is gone, but a commit that does not re-stage .env.local
            // must still land: the file is already history, blocking will not
            // remove it.
            writeFileSync(join(root, 'README.md'), 'changed\n');
            git(root, ['add', 'README.md']);
            const after = spawnSync('git', ['commit', '-m', 'unrelated edit'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.equal(after.status, 0, after.stderr);

            // Re-staging the secret path is still caught, so the override removal
            // is not a way to add more of the same secret.
            writeFileSync(join(root, '.env.local'), 'TOKEN=changed\n');
            git(root, ['add', '-f', '.env.local']);
            const restage = spawnSync('git', ['commit', '-m', 'touch fixture'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(restage.status, 0, restage.stderr);
            assert.match(restage.stderr, /secret\.dotenv|rejected before refs changed/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('final reference scan carries an exact staged instruction review into the direct tip', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-ref-staged-review-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            writeFileSync(join(root, 'AGENTS.md'), '# Maintainer reviewed\n');
            git(root, ['add', 'AGENTS.md']);
            execFileSync(process.execPath, [
                CLI, 'review', 'AGENTS.md', '--head', 'HEAD', '--reason', 'maintainer review',
            ], { cwd: root });

            const commit = spawnSync('git', ['commit', '-m', 'add reviewed instructions'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.equal(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['show', 'HEAD:AGENTS.md']), '# Maintainer reviewed');
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('final reference scan carries an exact staged policy migration into the direct tip', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-ref-staged-policy-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            writeFileSync(
                join(root, '.aimhooman.json'),
                JSON.stringify({ schema_version: 1, profile: 'strict' }) + '\n',
            );
            git(root, ['add', '.aimhooman.json']);
            git(root, ['commit', '--no-verify', '-q', '-m', 'strict baseline']);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            const oldObject = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);
            writeFileSync(
                join(root, '.aimhooman.json'),
                JSON.stringify({ schema_version: 1, profile: 'clean' }) + '\n',
            );
            git(root, ['add', '.aimhooman.json']);
            const newObject = git(root, ['rev-parse', ':.aimhooman.json']);
            execFileSync(process.execPath, [
                CLI, 'policy-review', '--head', 'HEAD', '--staged',
                '--old', oldObject, '--new', newObject, '--reason', 'approved migration',
            ], { cwd: root });

            const commit = spawnSync('git', ['commit', '-m', 'approved policy migration'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.equal(commit.status, 0, commit.stderr);
            assert.equal(
                JSON.parse(git(root, ['show', 'HEAD:.aimhooman.json'])).profile,
                'clean',
            );
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('final staged review mapping rejects changed blobs, mode flips, and intermediate commits', async (t) => {
    const runScenario = (name, build) => {
        const base = mkdtempSync(join(tmpdir(), `aim-ref-review-${name}-`));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
                const before = git(root, ['rev-parse', 'HEAD']);
                writeFileSync(join(root, 'AGENTS.md'), '# Reviewed bytes\n');
                git(root, ['add', 'AGENTS.md']);
                execFileSync(process.execPath, [
                    CLI, 'review', 'AGENTS.md', '--head', 'HEAD', '--reason', 'maintainer review',
                ], { cwd: root });
                const proposed = build(root, before);
                const branch = git(root, ['branch', '--show-current']);
                const update = spawnSync('git', [
                    'update-ref', `refs/heads/${branch}`, proposed, before,
                ], { cwd: root, encoding: 'utf8' });
                assert.notEqual(update.status, 0, update.stderr);
                assert.equal(git(root, ['rev-parse', 'HEAD']), before);
                assert.match(update.stderr, /generic\.agent-instructions|rejected before refs changed/);
            });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    };

    await t.test('changed blob', () => runScenario('blob', (root, before) => {
        writeFileSync(join(root, 'AGENTS.md'), '# Changed after review\n');
        git(root, ['add', 'AGENTS.md']);
        const tree = git(root, ['write-tree']);
        return git(root, ['commit-tree', tree, '-p', before, '-m', 'changed blob']);
    }));

    await t.test('same blob with symlink mode', () => runScenario('mode', (root, before) => {
        const oid = git(root, ['rev-parse', ':AGENTS.md']);
        git(root, ['update-index', '--add', '--cacheinfo', `120000,${oid},AGENTS.md`]);
        const tree = git(root, ['write-tree']);
        return git(root, ['commit-tree', tree, '-p', before, '-m', 'mode flip']);
    }));

    await t.test('reviewed path first appears in an intermediate commit', () => (
        runScenario('intermediate', (root, before) => {
            const tree = git(root, ['write-tree']);
            const intermediate = git(root, [
                'commit-tree', tree, '-p', before, '-m', 'intermediate instructions',
            ]);
            return git(root, ['commit-tree', tree, '-p', intermediate, '-m', 'proposed tip']);
        })
    ));
});

test('generated hook allows the operation when its embedded CLI cannot run', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-missing-cli-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            installHooks(repo, join(base, 'missing-cli.mjs'));
            const out = spawnSync(HOOK_SHELL, [shellArgumentPath(join(hooks, 'pre-commit'))], {
                cwd: root,
                encoding: 'utf8',
                env: { ...process.env, PATH: '' },
            });
            assert.equal(out.status, 0, out.stderr);
            assert.match(out.stderr, /guard unavailable/);
            assert.match(out.stderr, /allowing this operation without protection/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// A dispatcher whose pinned interpreter has moved: `brew upgrade node`, an nvm
// switch, an fnm or volta shim all relocate the process.execPath that init pins.
// The CLI file is still there, but a .mjs file is inert without an interpreter,
// so what the dispatcher may do next depends entirely on whether any Node exists.
function repoWithMovedNodePin(base) {
    const root = makeRepo(base);
    const repo = openRepo(root);
    const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    const cli = join(base, 'cli.mjs');
    writeFileSync(cli, '');
    installHooks(repo, cli);
    const hookPath = join(hooks, 'pre-commit');
    writeFileSync(hookPath, readFileSync(hookPath, 'utf8')
        .replace(/^AIMHOOMAN_NODE=.*$/m, `AIMHOOMAN_NODE='${join(base, 'gone', 'node')}'`));
    return { root, hookPath };
}

test('a moved Node pin stops the operation while a Node exists to run the remedy', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-moved-node-'));
    try {
        isolatedGitConfig(base, () => {
            const { root, hookPath } = repoWithMovedNodePin(base);
            // PATH carries a Node, so `aimhooman init` and `aimhooman uninstall`
            // both run: stopping here costs one command and is recoverable.
            const out = spawnSync(HOOK_SHELL, [shellArgumentPath(hookPath)], {
                cwd: root,
                encoding: 'utf8',
                env: { ...process.env, PATH: dirname(process.execPath) },
            });
            assert.notEqual(out.status, 0, 'a guard that could run must not allow the commit');
            assert.match(out.stderr, /pinned Node interpreter is missing/);
            assert.match(out.stderr, /aimhooman init/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('a moved Node pin allows the operation when no Node exists to run the remedy', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-no-node-'));
    try {
        isolatedGitConfig(base, () => {
            const { root, hookPath } = repoWithMovedNodePin(base);
            // No Node anywhere: 'init' and 'uninstall' are both Node programs, so
            // refusing would leave the repository unusable with no supported way
            // to remove these hooks. Degrading is the only honest answer.
            const out = spawnSync(HOOK_SHELL, [shellArgumentPath(hookPath)], {
                cwd: root,
                encoding: 'utf8',
                env: { ...process.env, PATH: '' },
            });
            assert.equal(out.status, 0, 'refusing here would trap the repository');
            assert.match(out.stderr, /no Node interpreter found/);
            assert.match(out.stderr, /without protection/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('chained hook failure is returned without running the final guard', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-status-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
            chmodSync(join(hooks, 'pre-commit'), 0o755);
            installHooks(repo, CLI);

            const out = spawnSync(
                HOOK_SHELL,
                [shellArgumentPath(join(hooks, 'pre-commit'))],
                { cwd: root, encoding: 'utf8' },
            );
            assert.equal(out.status, 23);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// W5 pre-commit/commit-msg marker dedup. After a clean, complete pre-commit
// scan, pre-commit records the staged tree sha so commit-msg can skip its
// duplicate tree scan. These tests verify the marker is written on a clean
// commit, NOT written when pre-commit blocks, and that a --no-verify commit
// (no marker) still gets its staged content scanned by commit-msg (fallback).
test('pre-commit records a clean-tree marker that commit-msg can reuse', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-marker-clean-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: root });
            const markerPath = join(root, '.git', 'aimhooman', 'precommit-clean.json');

            // A clean commit: pre-commit scans, finds nothing, records the marker.
            writeFileSync(join(root, 'README.md'), 'changed\n');
            git(root, ['add', 'README.md']);
            assert.equal(existsSync(markerPath), false, 'no marker before the first clean commit');
            const commit = spawnSync('git', ['commit', '-m', 'clean change'], { cwd: root, encoding: 'utf8' });
            assert.equal(commit.status, 0, `clean commit failed: ${commit.stderr}`);
            assert.equal(existsSync(markerPath), true, 'clean pre-commit must record the marker for commit-msg');
            const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
            assert.equal(marker.complete, true);
            assert.ok(typeof marker.tree === 'string' && marker.tree.length > 0, 'marker carries the tree sha');
            assert.equal(marker.profile, 'clean');
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('pre-commit does not record a marker when it blocks (commit-msg must still scan)', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-marker-block-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            const markerPath = join(root, '.git', 'aimhooman', 'precommit-clean.json');

            // Stage a secret. pre-commit blocks and must NOT record a marker, so
            // commit-msg (if it ran) would fall back to the full scan.
            writeFileSync(join(root, '.env'), 'TOKEN=secretvalue\n');
            git(root, ['add', '-f', '.env']);
            const commit = spawnSync('git', ['commit', '-m', 'secret'], { cwd: root, encoding: 'utf8' });
            assert.notEqual(commit.status, 0, 'a staged secret must block the commit');
            assert.equal(existsSync(markerPath), false, 'a blocking pre-commit must not record a clean marker');
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('a --no-verify commit with a staged secret is still blocked by commit-msg (no marker fallback)', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-marker-noverify-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            const markerPath = join(root, '.git', 'aimhooman', 'precommit-clean.json');

            // --no-verify skips pre-commit entirely, so no marker is written.
            // commit-msg must still scan the staged tree and block the secret.
            writeFileSync(join(root, '.env'), 'TOKEN=secretvalue\n');
            git(root, ['add', '-f', '.env']);
            const commit = spawnSync('git', ['commit', '--no-verify', '-m', 'secret'], { cwd: root, encoding: 'utf8' });
            assert.notEqual(commit.status, 0, '--no-verify must not bypass commit-msg tree scan');
            assert.equal(existsSync(markerPath), false, 'no marker when pre-commit was skipped');
            assert.match(commit.stderr, /secret\.dotenv/, 'commit-msg must still catch the staged secret');
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// B10-F1: a chained predecessor that resolves sibling scripts via
// $(dirname "$0") — the dominant pattern in husky and vanilla .githooks —
// broke after `aim init`, because the dispatcher invoked the predecessor as
// "$CHAINED" "$@", setting the predecessor's $0 to the backup path inside
// .git/aimhooman/chained/, where the sibling scripts do not live. The
// dispatcher now sources the predecessor in a subshell, which inherits the
// dispatcher's $0 (the original hook path Git invoked), so $(dirname "$0")
// resolves to the real hooks directory again.
test('a chained predecessor sees the original $0, so $(dirname "$0") resolves to its real directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-chained-zero-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            // The predecessor records $0 and $(dirname "$0") to a probe file, then
            // sources a sibling helper (the husky pattern) that appends its own
            // marker. Both live in the ORIGINAL hooks dir, not the chained backup.
            writeFileSync(
                join(hooks, 'pre-commit'),
                '#!/bin/sh\n'
                + 'printf \'$0=%s\\n\' "$0" > "$0".probe\n'
                + 'printf \'dirname=%s\\n\' "$(dirname -- "$0")" >> "$0".probe\n'
                + '. "$(dirname -- "$0")/helper.sh"\n',
                { mode: 0o755 },
            );
            chmodSync(join(hooks, 'pre-commit'), 0o755);
            writeFileSync(join(hooks, 'helper.sh'), '#!/bin/sh\nprintf \'helper=ran\\n\' >> "$0".probe\n', { mode: 0o755 });
            chmodSync(join(hooks, 'helper.sh'), 0o755);

            installHooks(repo, CLI);
            // After install, the predecessor lives in the chained backup dir, but
            // helper.sh is NOT copied there — only the managed-hook set is chained.
            // So sourcing the predecessor must resolve $(dirname "$0") to the
            // original hooks dir for helper.sh to be found.
            const probePath = `${join(hooks, 'pre-commit')}.probe`;
            const out = spawnSync(
                HOOK_SHELL,
                [shellArgumentPath(join(hooks, 'pre-commit'))],
                { cwd: root, encoding: 'utf8' },
            );
            assert.equal(out.status, 0, `dispatcher failed: ${out.stderr}`);
            assert.ok(existsSync(probePath), 'predecessor ran and wrote the probe');
            const probe = readFileSync(probePath, 'utf8');
            // $0 must be the ORIGINAL hook path (the dispatcher Git invoked), not
            // the .git/aimhooman/chained/ backup path. This is the core fix.
            const probeLines = probe.split('\n');
            const zeroLine = probeLines.find((line) => line.startsWith('$0='));
            const dirLine = probeLines.find((line) => line.startsWith('dirname='));
            assert.ok(zeroLine, `probe missing $0 line: ${probe}`);
            assert.ok(dirLine, `probe missing dirname line: ${probe}`);
            const observedZero = zeroLine.slice('$0='.length);
            const observedDir = dirLine.slice('dirname='.length);
            // Normalise to forward slashes before comparing: Git Bash reports $0
            // with forward slashes even on Windows (C:/.../pre-commit), while
            // Node's path.join produces backslashes there (C:\...\pre-commit).
            // Without normalisation the strictEqual fails on Windows purely on
            // the separator, not on the path itself.
            const norm = (p) => p.replaceAll('\\', '/');
            assert.equal(
                norm(observedZero), norm(join(hooks, 'pre-commit')),
                `predecessor $0 must be the original hook path, got: ${observedZero}`,
            );
            assert.equal(
                norm(observedDir), norm(hooks),
                `$(dirname "$0") must resolve to the original hooks dir, got: ${observedDir}`,
            );
            // The sibling helper ran, proving the relative resolution works.
            assert.match(probe, /helper=ran/, `helper.sh was not sourced from the original dir: ${probe}`);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('real commit scans files staged by a chained pre-commit hook', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-stage-'));
    try {
        isolatedGitConfig(base, () => {
            const parent = join(base, "owner's workspace");
            mkdirSync(parent);
            const root = makeRepo(parent);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            writeFileSync(
                join(hooks, 'pre-commit'),
                "#!/bin/sh\nprintf 'SECRET=value\\n' > .env\ngit add -f .env\n",
                { mode: 0o755 }
            );
            chmodSync(join(hooks, 'pre-commit'), 0o755);
            execFileSync('node', [CLI, 'init', '--profile', 'strict'], { cwd: root });
            writeFileSync(join(root, 'README.md'), 'changed\n');
            git(root, ['add', 'README.md']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'safe message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(git(root, ['diff', '--cached', '--name-only']), /\.env/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('real commit scans a marker injected into a safe file by a chained pre-commit hook', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-marker-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            // The predecessor stages a brand-new source file containing an AI
            // corner-cut marker. A path-only scan would miss it; the final guard
            // must rescan staged content after the chained hook mutates the index.
            writeFileSync(
                join(hooks, 'pre-commit'),
                "#!/bin/sh\nprintf '// ponytail: deferred cleanup\\n' > code.js\ngit add -f code.js\n",
                { mode: 0o755 },
            );
            chmodSync(join(hooks, 'pre-commit'), 0o755);
            execFileSync('node', [CLI, 'init', '--profile', 'strict'], { cwd: root });
            writeFileSync(join(root, 'README.md'), 'changed\n');
            git(root, ['add', 'README.md']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'safe message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(git(root, ['diff', '--cached', '--name-only']), /code\.js/);
            assert.match(commit.stderr, /marker\.corner-cut/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('real commit scans attribution appended by a chained commit-msg hook', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-message-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            writeFileSync(
                join(hooks, 'commit-msg'),
                "#!/bin/sh\nprintf '\\nCo-authored-by: Claude <noreply@anthropic.com>\\n' >> \"$1\"\n",
                { mode: 0o755 }
            );
            chmodSync(join(hooks, 'commit-msg'), 0o755);
            execFileSync('node', [CLI, 'init', '--profile', 'strict'], { cwd: root });
            writeFileSync(join(root, 'README.md'), 'changed\n');
            git(root, ['add', 'README.md']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'safe message'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(readFileSync(join(root, '.git', 'COMMIT_EDITMSG'), 'utf8'), /Co-authored-by: Claude/);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('strict pre-commit stops when its predecessor removes the downstream message guard', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-downstream-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            writeFileSync(
                join(hooks, 'pre-commit'),
                '#!/bin/sh\nrm -f "$(git rev-parse --git-path hooks)/commit-msg"\n',
                { mode: 0o755 },
            );
            chmodSync(join(hooks, 'pre-commit'), 0o755);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            writeFileSync(join(root, 'README.md'), 'safe staged content\n');
            git(root, ['add', 'README.md']);
            const before = git(root, ['rev-parse', 'HEAD']);

            const commit = spawnSync('git', ['commit', '-m', 'Generated with Codex'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.match(commit.stderr, /strict Git guards changed.*commit-msg.*unavailable/s);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('clean and compliance stop immediately when a predecessor removes downstream guards', () => {
    for (const profile of ['clean', 'compliance']) {
        const base = mkdtempSync(join(tmpdir(), `aim-hooks-downstream-${profile}-`));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
                writeFileSync(
                    join(hooks, 'pre-commit'),
                    '#!/bin/sh\nhooks=$(git rev-parse --git-path hooks)\nrm -f "$hooks/commit-msg" "$hooks/reference-transaction"\n',
                    { mode: 0o755 },
                );
                chmodSync(join(hooks, 'pre-commit'), 0o755);
                execFileSync(process.execPath, [CLI, 'init', '--profile', profile], { cwd: root });
                writeFileSync(join(root, 'README.md'), `${profile} staged content\n`);
                git(root, ['add', 'README.md']);
                const before = git(root, ['rev-parse', 'HEAD']);

                const commit = spawnSync('git', ['commit', '-m', 'Generated with Codex'], {
                    cwd: root,
                    encoding: 'utf8',
                });
                assert.notEqual(commit.status, 0, `${profile}: ${commit.stderr}`);
                assert.equal(git(root, ['rev-parse', 'HEAD']), before);
                assert.match(
                    commit.stderr,
                    /required Git guards changed.*commit-msg.*reference-transaction.*unavailable/s,
                );
            });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    }
});

test('final reference predecessor cannot remove the last guard in either veto phase', () => {
    for (const profile of ['clean', 'strict']) {
        const base = mkdtempSync(join(tmpdir(), `aim-hooks-ref-removal-${profile}-`));
        try {
            isolatedGitConfig(base, () => {
                const root = makeRepo(base);
                const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
                writeFileSync(
                    join(hooks, 'reference-transaction'),
                    '#!/bin/sh\ncat >/dev/null\ncase "$1" in preparing|prepared) rm -f "$(git rev-parse --git-path hooks)/reference-transaction";; esac\n',
                    { mode: 0o755 },
                );
                execFileSync(process.execPath, [CLI, 'init', '--profile', profile], { cwd: root });
                writeFileSync(join(root, 'safe.txt'), `${profile} safe content\n`);
                git(root, ['add', 'safe.txt']);
                const before = git(root, ['rev-parse', 'HEAD']);

                const commit = spawnSync('git', ['commit', '-m', 'safe message'], {
                    cwd: root,
                    encoding: 'utf8',
                });
                assert.notEqual(commit.status, 0, `${profile}: ${commit.stderr}`);
                assert.equal(git(root, ['rev-parse', 'HEAD']), before);
                assert.match(
                    commit.stderr,
                    /(?:strict|final) Git guards changed.*reference-transaction.*unavailable/s,
                );
            });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    }
});

test('generated guard ignores injected Node runtime and PATH commands while preserving chained environment', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-runtime-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            const chainedEnvironment = join(root, 'chained-environment.txt');
            writeFileSync(
                join(hooks, 'pre-commit'),
                `#!/bin/sh\nprintf '%s' "$NODE_OPTIONS" > '${chainedEnvironment}'\n`,
                { mode: 0o755 },
            );
            chmodSync(join(hooks, 'pre-commit'), 0o755);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });
            const commitGuard = readFileSync(join(hooks, 'commit-msg'), 'utf8');
            const installedPath = String(process.env.PATH || '')
                .split(delimiter)
                .filter((directory) => directory && isAbsolute(directory))
                .join(delimiter);
            const installedPathMetadata = commitGuard.match(
                /^# aimhooman-path-base64url: (\S+)$/m,
            );
            assert.ok(installedPathMetadata);
            assert.equal(
                Buffer.from(installedPathMetadata[1], 'base64url').toString('utf8'),
                installedPath,
            );
            assert.match(
                commitGuard,
                /AIMHOOMAN_COMMIT_TREE=\$\(PATH="\$AIMHOOMAN_PATH" git write-tree\)/,
            );

            writeFileSync(join(root, '.env'), 'SECRET=blocked\n');
            git(root, ['add', '-f', '.env']);
            const before = git(root, ['rev-parse', 'HEAD']);
            const preloadMarker = join(root, 'preload-ran.txt');
            const preload = join(root, 'preload.cjs');
            writeFileSync(
                preload,
                `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'loaded');\n` +
                "process.argv.splice(2, process.argv.length - 2, 'version');\n",
            );
            const fakeBin = join(root, 'fake-bin');
            const pathCommands = process.platform === 'win32'
                ? ['node', 'aimhooman']
                : ['node', 'aimhooman', 'git'];
            mkdirSync(fakeBin);
            if (process.platform === 'win32') {
                const commandInterpreter = process.env.ComSpec;
                assert.ok(commandInterpreter && existsSync(commandInterpreter));
                copyFileSync(commandInterpreter, join(fakeBin, 'node.exe'));
                copyFileSync(commandInterpreter, join(fakeBin, 'aimhooman.exe'));
            } else {
                for (const name of pathCommands) {
                    const marker = shellArgumentPath(join(root, `${name}-from-path.txt`));
                    writeFileSync(
                        join(fakeBin, name),
                        `#!/bin/sh\nprintf used > '${marker}'\nexit 0\n`,
                        { mode: 0o755 },
                    );
                    chmodSync(join(fakeBin, name), 0o755);
                }
            }
            const nodeOptions = `--require=${preload}`;
            const realGit = process.platform === 'win32'
                ? windowsCommands('git.exe').find((path) => existsSync(path))
                : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
            assert.ok(realGit, 'real Git executable must be resolved before PATH injection');
            const injectedEnvironment = {
                ...process.env,
                NODE_OPTIONS: nodeOptions,
                NODE_PATH: fakeBin,
                PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
            };
            const pathProbe = spawnSync(HOOK_SHELL, [
                '-c',
                `for name in ${pathCommands.join(' ')}; do command -v "$name"; done`,
            ], {
                cwd: root,
                encoding: 'utf8',
                env: {
                    ...injectedEnvironment,
                    PATH: hookPathForShell(injectedEnvironment.PATH),
                },
            });
            assert.equal(pathProbe.status, 0, pathProbe.stderr);
            const commandSuffix = process.platform === 'win32' ? '.exe' : '';
            const comparableCommandPath = (path) => {
                const normalized = comparableHookPath(path);
                return process.platform === 'win32'
                    ? normalized.replace(/\.exe$/i, '')
                    : normalized;
            };
            assert.deepEqual(
                pathProbe.stdout.trim().split(/\r?\n/).map(comparableCommandPath),
                pathCommands.map((name) => comparableCommandPath(
                    hookPathForShell(join(fakeBin, `${name}${commandSuffix}`)),
                )),
                'the injected shell PATH must resolve every guarded command',
            );
            const commit = spawnSync(realGit, ['commit', '-m', 'safe message'], {
                cwd: root,
                encoding: 'utf8',
                env: injectedEnvironment,
            });
            assert.notEqual(commit.status, 0, commit.stderr);
            assert.match(commit.stderr, /secret\.dotenv/);
            assert.equal(git(root, ['rev-parse', 'HEAD']), before);
            assert.equal(readFileSync(chainedEnvironment, 'utf8'), nodeOptions);
            assert.equal(existsSync(preloadMarker), false);
            if (process.platform !== 'win32') {
                for (const name of pathCommands) {
                    assert.equal(existsSync(join(root, `${name}-from-path.txt`)), false);
                }
            }
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('pre-merge guard blocks forbidden content introduced by a real non-fast-forward merge', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-merge-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const main = git(root, ['branch', '--show-current']);
            const baseline = git(root, ['rev-parse', 'HEAD']);
            git(root, ['checkout', '-q', '-b', 'feature']);
            writeFileSync(join(root, '.env'), 'SECRET=from-merge\n');
            git(root, ['add', '-f', '.env']);
            git(root, ['commit', '--no-verify', '-q', '-m', 'feature content']);
            git(root, ['checkout', '-q', main]);
            writeFileSync(join(root, 'README.md'), 'main changed\n');
            git(root, ['add', 'README.md']);
            git(root, ['commit', '--no-verify', '-q', '-m', 'main content']);
            const beforeMerge = git(root, ['rev-parse', 'HEAD']);
            assert.notEqual(beforeMerge, baseline);
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: root });

            const merge = spawnSync('git', ['merge', '--no-ff', '-m', 'merge feature', 'feature'], {
                cwd: root,
                encoding: 'utf8',
            });
            assert.notEqual(merge.status, 0, merge.stderr);
            assert.equal(git(root, ['rev-parse', 'HEAD']), beforeMerge);
            assert.match(merge.stderr, /\.env|secret\.env-file/);
            git(root, ['merge', '--abort']);
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('install and uninstall refuse to follow hook symlinks', () => {
    const base = mkdtempSync(join(tmpdir(), 'aim-hooks-symlink-'));
    try {
        isolatedGitConfig(base, () => {
            const root = makeRepo(base);
            const repo = openRepo(root);
            const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
            const target = join(base, 'foreign-pre-commit');
            const original = '#!/bin/sh\necho foreign\n';
            writeFileSync(target, original, { mode: 0o755 });
            symlinkSync(target, join(hooks, 'pre-commit'));

            const installed = installHooks(repo, '/tmp/aimhooman-cli.mjs');
            assert.deepEqual(installed.installed, []);
            assert.match(installed.warnings.join('\n'), /pre-commit is a symlink/);
            assert.equal(readFileSync(target, 'utf8'), original);
            assert.deepEqual(installedHooks(repo), []);

            const uninstalled = uninstallHooks(repo);
            assert.deepEqual(uninstalled.removed, []);
            assert.match(uninstalled.warnings.join('\n'), /pre-commit is a symlink/);
            assert.equal(readFileSync(target, 'utf8'), original);
            assert.ok(existsSync(join(hooks, 'pre-commit')));
        });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});
