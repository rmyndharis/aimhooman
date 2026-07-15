import test from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseGit, asObject, shellPathIsAmbiguous } from '../src/hook.mjs';

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

function resolveBash() {
    if (process.platform !== 'win32') return '/bin/bash';
    for (const gitPath of windowsCommands('git.exe')) {
        const gitDirectory = dirname(gitPath);
        const root = ['bin', 'cmd'].includes(basename(gitDirectory).toLowerCase())
            ? dirname(gitDirectory)
            : gitDirectory;
        const candidate = join(root, 'bin', 'bash.exe');
        if (existsSync(candidate)) return candidate;
    }
    const direct = windowsCommands('bash.exe').find((path) => existsSync(path));
    if (direct) return direct;
    throw new Error('Git for Windows bash.exe is required for shell integration tests');
}

const BASH = resolveBash();

function shellPath(value) {
    return value.replaceAll('\\', '/');
}

function shellQuote(value) {
    return `'${shellPath(value).replace(/'/g, `'\\''`)}'`;
}

test('parseGit detects commit and add across command forms', () => {
    const cases = [
        ['git commit -m x', true, 0],
        ['git commit --no-verify -m x', true, 0],
        ['git -C /path commit', true, 0],
        ['git -c user.email=x commit -m y', true, 0],
        ['FOO=bar git commit', true, 0],
        ['git add .claude/session.json', false, 1],
        ['git add -f a b', false, 2],
        ['npm test && git commit -m x', true, 0],
        ['git status', false, 0],
        ['echo hi', false, 0],
        // parser-differential hardening: forms a real shell would run as commit/add.
        ['git "commit" -m x', true, 0], // quoted verb
        ["git 'commit' -m x", true, 0], // single-quoted verb
        ['git status\ngit commit -m x', true, 0], // newline is a command separator
        ['/usr/bin/git commit -m x', true, 0], // absolute path to the git binary
        ['./git add .claude/session.json', false, 1], // pathed git still parsed for add
    ];
    for (const [cmd, commit, adds] of cases) {
        const r = parseGit(cmd);
        assert.equal(r.commit, commit, `commit flag for: ${cmd}`);
        assert.equal(r.addPaths.length, adds, `add count for: ${cmd}`);
    }
});

test('parseGit recognizes hook bypasses, wrappers, and quoted paths', () => {
    const repoWithSpaces = join(tmpdir(), 'repo with spaces');
    const strictRepo = join(tmpdir(), 'strict');
    const shellRepoWithSpaces = shellPath(repoWithSpaces);
    const shellStrictRepo = shellPath(strictRepo);
    const nativeBackslashTarget = String.raw`folder\name`;
    for (const command of [
        'git commit --no-verify -m x',
        'git commit -n -m x',
        'env FOO=bar git commit --no-verify',
        'command git commit --no-verify',
        `git -C "${shellRepoWithSpaces}" commit --no-verify`,
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.noVerify, true, command);
    }
    assert.deepEqual(parseGit('git add "dir/file with spaces"').addPaths, ['dir/file with spaces']);
    assert.equal(parseGit('git commit -an -m x').noVerify, true);
    assert.equal(parseGit('git -c core.hooksPath=/dev/null commit -m x').bypassHooks, true);
    assert.equal(parseGit('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x').bypassHooks, true);
    assert.equal(parseGit('env GIT_CONFIG_PARAMETERS=core.hooksPath=/dev/null git commit -m x').bypassHooks, true);
    assert.equal(parseGit('GIT_CONFIG_GLOBAL=/tmp/evil.cfg git commit -m x').bypassHooks, true);
    assert.equal(parseGit('HOME=/tmp/evil-home git commit -m x').bypassHooks, true);
    assert.equal(parseGit('git -c include.path=/tmp/evil.cfg commit -m x').bypassHooks, true);
    assert.equal(parseGit('GIT_CONFIG_COUNT=0 git commit -m x').bypassHooks, true);
    assert.equal(parseGit('GIT_CONFIG_GLOBAL= git commit -m x').bypassHooks, true);
    assert.equal(
        parseGit(`cd "${shellRepoWithSpaces}" && git commit -m x`).commands[0].cwd,
        resolve(repoWithSpaces),
    );
    assert.equal(
        parseGit(`env -C "${shellRepoWithSpaces}" git commit --no-verify`).commands[0].cwd,
        resolve(repoWithSpaces),
    );
    assert.equal(
        parseGit(`env --chdir="${shellStrictRepo}" git commit --no-verify`).commands[0].cwd,
        resolve(strictRepo),
    );
    assert.equal(
        parseGit(String.raw`git -C "folder\name" commit -m x`, strictRepo).commands[0].cwd,
        resolve(strictRepo, nativeBackslashTarget),
    );
    assert.equal(parseGit('env -P /usr/bin git commit --no-verify').commit, true);
    assert.equal(parseGit("env -S 'git commit --no-verify'").uncertainShell, true);
    assert.equal(parseGit('env --unknown value git commit --no-verify').uncertainShell, true);
    assert.equal(parseGit('env --unknown value git commit --no-verify').commit, true);
    for (const command of [
        '(cd /tmp/strict && git commit --no-verify -m x)',
        "bash -lc 'cd /tmp/strict && git commit --no-verify -m x'",
        "bash -O extglob -c 'git commit --no-verify -m x'",
        "bash -C -c 'git commit --no-verify -m x'",
        "zsh -o NO_RCS -c 'git commit --no-verify -m x'",
        'cd /tmp/clean | git commit --no-verify -m x',
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.uncertainShell, true, command);
    }
    for (const command of [
        "bash --rcfile /tmp/rc -c 'git commit --no-verify -m x'",
        "bash -lc 'git commit --no-verify -m x'",
        "fish -C 'cd /tmp/strict' -c 'git commit --no-verify -m x'",
    ]) {
        const candidate = parseGit(command).commands.find((entry) => entry.verb === 'commit');
        assert.ok(candidate, command);
        assert.equal(candidate.targetUncertain, true, command);
    }
    for (const command of [
        "printf '%s\\n' 'git commit --no-verify -m unsafe' | sh",
        "echo 'git commit --no-verify -m unsafe' | bash",
        `python -c "import os; os.system('git commit --no-verify -m unsafe')"`,
        `perl -e "system('git commit --no-verify -m unsafe')"`,
        `node -e "require('child_process').execSync('git commit --no-verify -m unsafe')"`,
        "printf '%s\\n' 'git commit --no-verify -m unsafe' | cat | sh",
        "printf '%s\\n' 'git commit --no-verify -m unsafe' | tee /dev/stderr | sh",
        "printf '%s\\n' 'git commit --no-verify -m unsafe' | sh -c 'cat | sh'",
        `sh -c 'eval "$1"' _ 'git commit --no-verify -m unsafe'`,
        `bash -c '"$@"' _ git commit --no-verify -m unsafe`,
        `powershell -Command "'git commit --no-verify -m unsafe' | Invoke-Expression"`,
        'iex "git commit --no-verify"',
        'Invoke-Expression "git commit --no-verify"',
        `CMD='git -C /tmp/strict commit --no-verify -m unsafe'; eval "$CMD"`,
        `CMD='git -C /tmp/strict commit --no-verify -m unsafe'; sh -c "$CMD"`,
        `set -- git -C /tmp/strict commit --no-verify -m unsafe; "$@"`,
        `f(){ git -C /tmp/strict commit --no-verify -m unsafe; }; f`,
        `function f { git -C /tmp/strict commit --no-verify -m unsafe; }; f`,
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.uncertainShell, true, command);
    }
    assert.equal(parseGit('printf "%s" "left | git commit --no-verify"').commit, false);
    assert.equal(parseGit('git commit -a -m x').commands[0].futureIndex, true);
    assert.equal(parseGit('git commit --include path -m x').commands[0].futureIndex, true);
    assert.equal(parseGit('git commit --pathspec-from-file paths.txt').commands[0].futureIndex, true);
    assert.equal(
        parseGit('git mv harmless.txt .env && git commit --no-verify -m x')
            .commands.at(-1).futureIndex,
        true,
    );
    assert.equal(
        parseGit('git apply --cached change.patch && git commit --no-verify -m x')
            .commands.at(-1).futureIndex,
        true,
    );
    for (const command of [
        'git apply --check change.patch && git commit --no-verify -m x',
        'git restore harmless.txt && git commit --no-verify -m x',
        'git stash list && git commit --no-verify -m x',
        'git submodule status && git commit --no-verify -m x',
    ]) {
        assert.equal(parseGit(command).commands.at(-1).futureIndex, false, command);
    }
    for (const command of [
        'git restore --staged harmless.txt && git commit --no-verify -m x',
        'git stash pop && git commit --no-verify -m x',
        'git submodule add https://example.invalid/repo dep && git commit --no-verify -m x',
    ]) {
        assert.equal(parseGit(command).commands.at(-1).futureIndex, true, command);
    }
    assert.equal(parseGit('git commit -- -notes').noVerify, false);
    assert.equal(parseGit('git commit -mno').noVerify, false);
    assert.equal(parseGit('git commit -mno').commands[0].futureIndex, false);
    assert.equal(parseGit('git commit --no-veri -m x').noVerify, true);
    assert.equal(parseGit('git commit --no-ver -m x').noVerify, false);
    assert.equal(parseGit('git.exe commit -m x').commit, true);
    assert.equal(parseGit('/mingw64/bin/git.exe commit -m x').commit, true);
    assert.equal(parseGit('exec git commit --no-verify -m x').noVerify, true);
    assert.equal(parseGit('command -v git commit').commit, false);
    assert.equal(parseGit('command -p git commit -m x').uncertainShell, true);
    for (const command of [
        'x=git; $x commit --no-verify -m x',
        "eval 'git commit --no-verify -m x'",
        '$(printf git) commit --no-verify -m x',
        'sudo git commit --no-verify -m x',
        'cmd /c git commit --no-verify -m x',
        "Start-Process git -ArgumentList 'commit','--no-verify'",
        'noglob git commit --no-verify -m x',
        'nocorrect git commit --no-verify -m x',
        '- git commit --no-verify -m x',
        'coproc git commit --no-verify -m x',
        'repeat 1 git commit --no-verify -m x',
        "builtin eval 'git commit --no-verify -m x'",
        "builtin -- eval 'git commit --no-verify -m x'",
    ]) {
        assert.equal(parseGit(command).commit, true, command);
    }
    for (const command of [
        'builtin source ./jump.sh && git commit -m x',
        'builtin . ./jump.sh && git commit -m x',
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.commands.at(-1).targetUncertain, true, command);
    }
    assert.equal(parseGit('git "$(printf commit)" -m x').uncertainShell, true);
    assert.equal(parseGit('git "$(printf commit)" -m x').commit, true);
    assert.deepEqual(parseGit('git add ""').addPaths, ['']);
    assert.equal(parseGit('git commit -m ""').commands[0].futureIndex, false);
    assert.equal(parseGit('git commit -m x').classification, 'direct');
    assert.equal(parseGit('git commit').commands[0].editorRisk, true);
    assert.equal(parseGit('git commit -m x').commands[0].editorRisk, false);
    assert.equal(parseGit('git commit -F message.txt').commands[0].editorRisk, false);
    assert.equal(parseGit('git commit -C HEAD').commands[0].editorRisk, false);
    assert.equal(parseGit('git commit -c HEAD').commands[0].editorRisk, true);
    assert.equal(parseGit('git commit --fixup=HEAD').commands[0].editorRisk, false);
    assert.equal(parseGit('git commit --fixup=amend:HEAD').commands[0].editorRisk, true);
    assert.equal(parseGit('git commit --fixup=reword:HEAD').commands[0].editorRisk, true);
    assert.equal(parseGit('git commit --squash=HEAD').commands[0].editorRisk, true);
    assert.equal(parseGit('git commit --fixup=amend:HEAD --no-edit').commands[0].editorRisk, false);
    assert.equal(parseGit('git commit -m x --edit').commands[0].editorRisk, true);
    assert.equal(parseGit('git commit --edit --no-edit').commands[0].editorRisk, false);
    assert.equal(parseGit('git commit --no-veri -m x').classification, 'bypass');
    for (const [command, variable] of [
        ['NODE_OPTIONS=--require=/tmp/inject.cjs git commit -m x', 'NODE_OPTIONS'],
        ['NODE_PATH=/tmp/modules git commit -m x', 'NODE_PATH'],
        ['PATH=/tmp/fake /usr/bin/git commit -m x', 'PATH'],
        ['GIT_DIR=/tmp/other.git git commit -m x', 'GIT_DIR'],
        ['GIT_WORK_TREE=/tmp/other git commit -m x', 'GIT_WORK_TREE'],
        ['LD_PRELOAD=/tmp/inject.so git commit -m x', 'LD_PRELOAD'],
        ['DYLD_INSERT_LIBRARIES=/tmp/inject.dylib git commit -m x', 'DYLD_INSERT_LIBRARIES'],
        ['BASH_ENV=/tmp/inject.sh git commit -m x', 'BASH_ENV'],
        ['ZDOTDIR=/tmp/inject-zsh git commit -m x', 'ZDOTDIR'],
        ['GIT_EDITOR=/tmp/editor git commit', 'GIT_EDITOR'],
        ['GIT_SEQUENCE_EDITOR=/tmp/editor git commit', 'GIT_SEQUENCE_EDITOR'],
        ['VISUAL=/tmp/editor git commit', 'VISUAL'],
        ['EDITOR=/tmp/editor git commit', 'EDITOR'],
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.classification, 'bypass', command);
        assert.ok(parsed.environmentRisk.includes(variable), command);
    }
    assert.deepEqual(
        parseGit('PATH=/tmp/fake; /usr/bin/git commit -m x').environmentRisk,
        ['PATH'],
    );
    assert.deepEqual(
        parseGit('export NODE_OPTIONS=--require=/tmp/inject.cjs && git commit -m x').environmentRisk,
        ['NODE_OPTIONS'],
    );
    assert.deepEqual(
        parseGit('NODE_PATH=/tmp/modules\ngit commit -m x').environmentRisk,
        ['NODE_PATH'],
    );
    assert.deepEqual(
        parseGit('unset GIT_CONFIG_NOSYSTEM; git commit -m x').environmentRisk,
        ['GIT_CONFIG_NOSYSTEM'],
    );
    for (const [command, variable] of [
        ["env GIT_DIR=/tmp/strict/.git bash -c 'git commit --no-verify -m x'", 'GIT_DIR'],
        ["GIT_DIR=/tmp/strict/.git sh -c 'git commit --no-verify -m x'", 'GIT_DIR'],
        ["env CDPATH=/tmp/strict bash -c 'cd repo && git commit --no-verify -m x'", 'CDPATH'],
        ["env PATH=/tmp/fake sh -c 'git commit --no-verify -m x'", 'PATH'],
        ["env BASH_ENV=/tmp/jump bash -c 'git commit --no-verify -m x'", 'BASH_ENV'],
        ["env ZDOTDIR=/tmp/jump zsh -c 'git commit --no-verify -m x'", 'ZDOTDIR'],
    ]) {
        const parsed = parseGit(command, '/tmp/source');
        const candidate = parsed.commands.find((entry) => entry.verb === 'commit');
        assert.ok(candidate, command);
        assert.ok(candidate.environmentRisk.includes(variable), command);
        assert.equal(candidate.bypassHooks, true, command);
        assert.equal(candidate.targetEnvironmentRisk, true, command);
        assert.equal(candidate.targetUncertain, true, command);
    }
    assert.equal(
        parseGit('git replace HEAD alternate && git commit --no-verify -m x')
            .commands.at(-1).policyTransitionRisk,
        true,
    );
    assert.deepEqual(
        parseGit('env --unset=NODE_OPTIONS git commit -m x').environmentRisk,
        ['NODE_OPTIONS'],
    );
    assert.deepEqual(
        parseGit('env -uGIT_DIR git commit -m x').environmentRisk,
        ['GIT_DIR'],
    );
    assert.deepEqual(
        parseGit('export GIT_DIR; git commit -m x').environmentRisk,
        ['GIT_DIR'],
    );
    assert.equal(
        parseGit('rm .git/hooks/pre-commit && git commit -m x').commands.at(-1).prefixRisk,
        true,
    );
    assert.equal(
        parseGit('git config core.hooksPath /tmp/empty && git commit -m x').commands.at(-1).prefixRisk,
        true,
    );
    assert.equal(
        parseGit("printf '#!/bin/sh\\nexit 0\\n' > .git/hooks/pre-commit && git commit -m x").uncertainShell,
        true,
    );
    assert.equal(parseGit('git -c core.editor=/tmp/editor commit').bypassHooks, true);
    assert.equal(parseGit('git -c sequence.editor=/tmp/editor commit').bypassHooks, true);
    assert.equal(parseGit('GIT_DIR=/tmp/strict/.git git commit').commands[0].targetEnvironmentRisk, true);
    assert.equal(parseGit('PATH=/tmp/fake git commit').commands[0].targetEnvironmentRisk, true);
    assert.equal(parseGit('PATH=/tmp/fake /usr/bin/git commit').commands[0].targetEnvironmentRisk, false);
    for (const command of [
        '/usr/bin/env -C "$D" git commit -m x',
        'env.exe -C "$D" git commit -m x',
    ]) {
        const parsed = parseGit(command, strictRepo);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.commands.at(-1).targetUncertain, true, command);
    }
    for (const command of [
        'git -C "$D" commit -m x',
        'env -C "$D" git commit -m x',
        'env -C../repo* git commit -m x',
        'git --git-dir="$D/.git" commit -m x',
        'git -C ../repo* commit -m x',
        'git -C ../{strict,clean} commit -m x',
        'git --work-tree=/tmp/other commit -m x',
        'git --git-dir=/tmp/strict/.git --work-tree=/tmp/other commit -m x',
    ]) {
        assert.equal(
            parseGit(command, strictRepo).commands.at(-1).targetUncertain,
            true,
            command,
        );
    }
});

test('parseGit recognizes wrapper, shell, and interpreter indirection and line-continuation bypass', () => {
    // Local direct-exec wrappers (run git in THIS repo): commit is surfaced as uncertain.
    for (const command of [
        'su -c "git commit --no-verify"',
        'pkexec git commit --no-verify',
        'strace git commit --no-verify',
        'firejail git commit --no-verify',
        'gosu appuser git commit --no-verify',
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.uncertainShell, true, command);
    }
    // Non-POSIX -c shells and eval-flag interpreters that wrap a commit, plus the
    // generic eval-flag fallback for an unknown interpreter using a recognized
    // execution primitive.
    for (const command of [
        'fish -c "git commit --no-verify"',
        'ash -c "git commit --no-verify"',
        'mksh -c "git commit --no-verify"',
        'lua -e "os.execute(\'git commit --no-verify\')"',
        'awk \'BEGIN{system("git commit --no-verify")}\'',
        'expect -c "exec git commit --no-verify"',
        'mylang -e "system(\'git commit --no-verify\')"',
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.uncertainShell, true, command);
    }
    // PowerShell/cmd dynamic-eval forms set uncertainShell even without a recognized commit
    // (the strict guard denies uncertain commands, so these no longer fall through).
    for (const command of [
        'Invoke-Command { git commit --no-verify }',
        '& { git commit --no-verify }',
    ]) {
        assert.equal(parseGit(command).uncertainShell, true, command);
    }
    // Backslash-newline line continuation must NOT hide a bypass flag or config key.
    assert.equal(parseGit('git commit --no-\\\nverify -m x').noVerify, true);
    assert.equal(parseGit('git -c core.hook\\\nsPath=/x commit -m x').bypassHooks, true);
    // False-positive guard: non-executing -e/-c programs must not be flagged as commits.
    for (const command of [
        'grep -e "system git commit" file',
        'sed -e "s/system/git commit/" f',
        'node -e "console.log(1)"',
    ]) {
        assert.equal(parseGit(command).commit, false, command);
    }
});

test('parseGit surfaces POSIX control bodies, directory stacks, and index replacement risk', () => {
    const sourceRepo = join(tmpdir(), 'source');
    const strictRepo = join(tmpdir(), 'strict');
    const shellStrictRepo = shellQuote(strictRepo);
    for (const command of [
        'if true; then git commit --no-verify -m bypass; fi',
        '! git commit --no-verify -m bypass',
        'for x in y; do git commit --no-verify -m bypass; done',
        'while true; do git commit --no-verify -m bypass; done',
    ]) {
        const parsed = parseGit(command, sourceRepo);
        assert.equal(parsed.commit, true, command);
        assert.equal(parsed.noVerify, true, command);
        assert.equal(parsed.uncertainShell, true, command);
    }

    assert.equal(
        parseGit(`pushd ${shellStrictRepo} && git commit --no-verify`, sourceRepo)
            .commands.at(-1).cwd,
        resolve(strictRepo),
    );
    assert.equal(
        parseGit(`builtin pushd ${shellStrictRepo} && git commit --no-verify`, sourceRepo)
            .commands.at(-1).cwd,
        resolve(strictRepo),
    );
    for (const prefix of ['builtin', 'builtin --', 'nocorrect', 'noglob', '-']) {
        assert.equal(
            parseGit(`${prefix} cd ${shellStrictRepo} && git commit -m x`, sourceRepo)
                .commands.at(-1).cwd,
            resolve(strictRepo),
            prefix,
        );
    }
    for (const directoryCommand of ['cd', 'pushd']) {
        for (const command of [
            `(${directoryCommand} ${shellStrictRepo} && true); git commit -m x`,
            `(${directoryCommand} ${shellStrictRepo}) && true; git commit -m x`,
        ]) {
            const parsed = parseGit(command, sourceRepo);
            assert.equal(parsed.commands.at(-1).cwd, resolve(sourceRepo), command);
            assert.equal(parsed.commands.at(-1).targetUncertain, true, command);
        }
    }
    for (const command of [
        `coproc pushd ${shellStrictRepo} && git commit -m x`,
        `repeat 0 pushd ${shellStrictRepo} && git commit -m x`,
    ]) {
        const candidate = parseGit(command, sourceRepo).commands.at(-1);
        assert.equal(candidate.cwd, resolve(sourceRepo), command);
        assert.equal(candidate.targetUncertain, true, command);
    }
    assert.equal(
        parseGit(
            `pushd ${shellStrictRepo} && pushd nested && popd && git commit --no-verify`,
            sourceRepo,
        ).commands.at(-1).cwd,
        resolve(strictRepo),
    );
    assert.equal(
        parseGit(`pushd ${shellStrictRepo}; git commit --no-verify`, sourceRepo)
            .commands.at(-1).targetUncertain,
        true,
    );
    for (const command of [
        'CDPATH=/strict cd repo && git commit -m x',
        'CDPATH=/strict pushd repo && git commit -m x',
        'HOME=/strict cd ~/repo && git commit -m x',
        'cd "$D" && git commit -m x',
        'pushd ../repo* && git commit -m x',
    ]) {
        assert.equal(
            parseGit(command, sourceRepo).commands.at(-1).targetUncertain,
            true,
            command,
        );
    }
    for (const command of [
        `if false; then cd ${shellStrictRepo} && true; fi; git commit -m x`,
        `while false; do cd ${shellStrictRepo}; done; git commit -m x`,
        `test -f missing && cd ${shellStrictRepo} && true; git commit -m x`,
        `true || cd ${shellStrictRepo}; git commit -m x`,
    ]) {
        assert.equal(
            parseGit(command, sourceRepo).commands.at(-1).targetUncertain,
            true,
            command,
        );
    }
    for (const command of [
        'sudo -D /strict git commit --no-verify -m x',
        String.raw`find /strict -execdir git commit --no-verify -m x \;`,
        'chroot /jail git -C /repo commit --no-verify -m x',
        'wsl --cd /strict git commit --no-verify -m x',
        "powershell -Command 'git commit --no-verify -m x'",
        "systemd-run --working-directory=/strict git commit --no-verify -m x",
    ]) {
        const candidate = parseGit(command, sourceRepo).commands
            .find((entry) => entry.verb === 'commit');
        assert.ok(candidate, command);
        assert.equal(candidate.targetUncertain, true, command);
    }
    for (const command of [
        'GIT_DIR=/strict/.git git add .env',
        'CDPATH=/strict; cd repo && git add .env',
        'PATH=/tmp/fake time git commit --no-verify -m x',
        'typeset -x GIT_DIR=/strict/.git; git add .env',
    ]) {
        const candidate = parseGit(command, sourceRepo).commands.at(-1);
        assert.equal(candidate.targetEnvironmentRisk, true, command);
    }
    for (const command of [
        "alias git='git -C /strict'; git add .env",
        'hash -p /tmp/fake/git git; git add .env',
    ]) {
        const candidate = parseGit(command, sourceRepo).commands.at(-1);
        assert.equal(candidate.targetUncertain, true, command);
    }
    const relativeAfterExpansion = parseGit(
        `eval 'git -C "$D" -C nested commit --no-verify -m x'`,
        sourceRepo,
    ).commands.find((entry) => entry.verb === 'commit');
    assert.equal(relativeAfterExpansion.targetUncertain, true);
    const literalEvalTarget = parseGit(
        `eval 'git -C ${shellStrictRepo} commit --no-verify -m x'`,
        sourceRepo,
    ).commands.find((entry) => entry.verb === 'commit');
    assert.equal(literalEvalTarget.cwd, resolve(strictRepo));
    assert.equal(literalEvalTarget.targetUncertain, false);

    const functionEnvironment = parseGit(
        `f(){ GIT_DIR=${shellStrictRepo}/.git git commit --no-verify -m x; }; f`,
        sourceRepo,
    ).commands.find((entry) => entry.verb === 'commit');
    assert.ok(functionEnvironment.environmentRisk.includes('GIT_DIR'));
    assert.equal(functionEnvironment.targetEnvironmentRisk, true);
    for (const command of [
        'CDPATH=/strict; cd repo && git commit -m x',
        'HOME=/strict; cd ~/repo && git commit -m x',
    ]) {
        assert.equal(
            parseGit(command, sourceRepo).commands.at(-1).targetEnvironmentRisk,
            true,
            command,
        );
    }
    assert.equal(
        parseGit('popd && git commit --no-verify', '/tmp/source')
            .commands.at(-1).targetUncertain,
        true,
    );
    for (const command of [
        'cd - && git commit --no-verify',
        'cd -P /tmp/strict && git commit --no-verify',
        'cd -- && git commit --no-verify',
    ]) {
        assert.equal(
            parseGit(command, '/tmp/source').commands.at(-1).targetUncertain,
            true,
            command,
        );
    }
    assert.equal(
        parseGit('cp alternate-index .git/index && git commit --no-verify', '/tmp/source')
            .commands.at(-1).futureIndex,
        true,
    );
    assert.deepEqual(
        parseGit('GIT_INDEX_FILE=alternate git commit --no-verify', '/tmp/source')
            .environmentRisk,
        ['GIT_INDEX_FILE'],
    );
});

test('Windows fails closed for repository targets with ambiguous native or MSYS semantics', () => {
    assert.equal(shellPathIsAmbiguous('/c/work/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('/tmp/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('///c/work/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('////c/work/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('~/work/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('~', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('~other/work/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('C:work/repo', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('C:', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('//', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('//server', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('\\\\server', 'win32'), true);
    assert.equal(shellPathIsAmbiguous('C:/work/repo', 'win32'), false);
    assert.equal(shellPathIsAmbiguous('//server/share/repo', 'win32'), false);
    assert.equal(shellPathIsAmbiguous('\\\\server\\share\\repo', 'win32'), false);
    assert.equal(shellPathIsAmbiguous('/tmp/repo', 'linux'), false);
    assert.equal(shellPathIsAmbiguous('//', 'linux'), true);
    assert.equal(shellPathIsAmbiguous('//server/share/repo', 'linux'), true);
    assert.equal(shellPathIsAmbiguous('///server/share/repo', 'linux'), false);
    assert.equal(shellPathIsAmbiguous('~/work/repo', 'linux'), true);
    assert.equal(shellPathIsAmbiguous('~other/work/repo', 'linux'), true);
    assert.equal(shellPathIsAmbiguous('~+/work/repo', 'linux'), true);
    assert.equal(shellPathIsAmbiguous('~-/work/repo', 'linux'), true);

    const initialCwd = resolve(tmpdir(), 'source');
    for (const command of [
        'cd /c/work/repo && git commit -m x',
        'builtin -- cd /c/work/repo && git commit -m x',
        'pushd /c/work/repo && git commit -m x',
        'env -C /c/work/repo git commit -m x',
        'env -C/c/work/repo git commit -m x',
        'git -C /c/work/repo commit -m x',
        'git --git-dir=/c/work/repo/.git --work-tree=/c/work/repo commit -m x',
        'cd /c/work/repo && cd nested && git commit -m x',
        "cd /c/work/repo && printf '%s\\n' 'git commit --no-verify -m x' | sh",
        "pushd /c/work/repo && printf '%s\\n' 'git commit -m x' | sh",
        "builtin pushd /c/work/repo && printf '%s\\n' 'git commit -m x' | sh",
        "printf '%s\\n' 'env -C /c/work/repo git commit --no-verify -m x' | sh",
        "printf '%s\\n' 'env --chdir=/c/work/repo git commit -m x' | sh",
        "printf '%s\\n' 'env -C/c/work/repo git commit -m x' | sh",
        "f() { cd /c/work/repo && git commit -m x; }; f",
    ]) {
        const candidates = parseGit(command, initialCwd).commands
            .filter((entry) => entry.verb === 'commit');
        assert.ok(candidates.length, command);
        assert.equal(
            candidates.some((candidate) => candidate.pathDialectUncertain),
            process.platform === 'win32',
            command,
        );
    }
    assert.equal(
        parseGit('git -C ~other/work/repo commit -m x', initialCwd)
            .commands.at(-1).pathDialectUncertain,
        true,
    );
    for (const command of [
        "git -C '~' commit -m x",
        'git -C~ commit -m x',
        'env --chdir=~ git commit -m x',
        'cd ~/work/repo && git commit -m x',
        "cd '~' && git commit -m x",
        "pushd '~' && git commit -m x",
    ]) {
        assert.equal(
            parseGit(command, initialCwd).commands.at(-1).pathDialectUncertain,
            true,
            command,
        );
    }

    for (const command of [
        "cd /c/work/repo && f() { git commit -m x; }; f",
        "f() { git commit -m x; }; pushd /c/work/repo && f",
        ". ./jump.sh && f() { git commit -m x; }; f",
        "CMD='git commit -m x'; cd /c/work/repo && eval \"$CMD\"",
        "eval 'cd /c/work/repo' && printf '%s\\n' 'git commit -m x' | sh",
        ". ./jump.sh && printf '%s\\n' 'git commit -m x' | sh",
        "HOME=/strict; printf '%s\\n' 'cd ~ && git commit -m x' | sh",
        "BASH_ENV=/evil; printf '%s\\n' 'git commit -m x' | bash",
    ]) {
        const candidates = parseGit(command, initialCwd).commands
            .filter((entry) => entry.verb === 'commit');
        assert.ok(candidates.length, command);
        assert.ok(candidates.some((candidate) => candidate.targetUncertain), command);
    }
});

test('Windows denies an ambiguous repo path before resolving a Git alias', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('Windows Git Bash path semantics only');
        return;
    }
    const dir = makeHookRepo('strict', 'aim-hook-windows-alias-path-');
    const wrongNativeRepo = mkdtempSync(join(tmpdir(), 'aim-hook-wrong-native-alias-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: wrongNativeRepo });
        execFileSync('git', ['config', 'alias.ci', 'status'], { cwd: wrongNativeRepo });
        // Node resolves a single-root path against the current drive, whereas
        // Git Bash resolves it through the MSYS mount table. Give the native
        // path a harmless alias: resolving aliases before rejecting this path
        // would erase the protected candidate and incorrectly allow execution.
        const rootRelativeTarget = shellPath(wrongNativeRepo).replace(/^[A-Za-z]:/, '');
        assert.equal(resolve(dir, rootRelativeTarget), resolve(wrongNativeRepo));
        for (const command of [
            `git -C "${rootRelativeTarget}" ci`,
            `f() { cd "${rootRelativeTarget}" && git commit -m x; }; f`,
        ]) {
            const decision = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', command);
            assert.match(
                decision.permissionDecisionReason,
                /cannot map a POSIX-root or tilde target path/,
                command,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(wrongNativeRepo, { recursive: true, force: true });
    }
});

test('dynamic and split worktree targets deny before alias or policy lookup', async () => {
    const source = makeHookRepo('strict', 'aim-hook-dynamic-target-source-');
    const literalTarget = join(source, '$D');
    const otherWorktree = makeHookRepo('clean', 'aim-hook-split-worktree-');
    try {
        mkdirSync(literalTarget);
        execFileSync('git', ['init', '-q'], { cwd: literalTarget });
        execFileSync('git', ['config', 'alias.ci', 'status'], { cwd: literalTarget });

        const dynamic = await invokePreToolUse(source, {
            tool_name: 'Bash',
            tool_input: { command: 'git -C "$D" ci' },
        });
        assert.equal(dynamic.permissionDecision, 'deny');
        assert.match(dynamic.permissionDecisionReason, /after shell expansion/);

        const split = await invokePreToolUse(source, {
            tool_name: 'Bash',
            tool_input: {
                command: `git --work-tree=${shellQuote(otherWorktree)} commit -m x`,
            },
        });
        assert.equal(split.permissionDecision, 'deny');
        assert.match(split.permissionDecisionReason, /repository target/);

        const environmentTarget = await invokePreToolUse(source, {
            tool_name: 'Bash',
            tool_input: {
                command: `GIT_DIR=${shellQuote(join(otherWorktree, '.git'))} git add .env`,
            },
        });
        assert.equal(environmentTarget.permissionDecision, 'deny');
        assert.match(environmentTarget.permissionDecisionReason, /target environment assignments/);

        const subshell = await invokePreToolUse(source, {
            tool_name: 'Bash',
            tool_input: {
                command: `(cd ${shellQuote(otherWorktree)} && true); git commit --no-verify -m x`,
            },
        });
        assert.equal(subshell.permissionDecision, 'deny');
        assert.match(subshell.permissionDecisionReason, /dynamic directory change/);
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(otherWorktree, { recursive: true, force: true });
    }
});

test('ambient CDPATH cannot redirect cd or pushd policy lookup to another repository', async () => {
    const source = makeHookRepo('strict', 'aim-hook-cdpath-source-');
    const cdpathRoot = mkdtempSync(join(tmpdir(), 'aim-hook-cdpath-target-'));
    const actualTarget = join(cdpathRoot, 'repo');
    const parserDecoy = join(source, 'repo');
    const previousCdpath = process.env.CDPATH;
    try {
        initializeHookRepo(parserDecoy, 'clean');
        initializeHookRepo(actualTarget, 'strict');
        writeFileSync(join(actualTarget, '.selected-by-cdpath'), 'target\n');
        process.env.CDPATH = cdpathRoot;

        for (const directoryCommand of ['cd', 'pushd']) {
            const command = `${directoryCommand} repo && git commit --no-verify -m x`;
            const probe = spawnSync(
                BASH,
                ['-c', `${directoryCommand} repo >/dev/null && test -f .selected-by-cdpath`],
                { cwd: source, env: { ...process.env, CDPATH: cdpathRoot }, encoding: 'utf8' },
            );
            assert.equal(probe.status, 0, `${directoryCommand}: ${probe.stderr}`);

            const parsed = parseGit(command, source).commands.at(-1);
            assert.equal(parsed.cwd, resolve(parserDecoy), directoryCommand);
            assert.equal(parsed.targetUncertain, true, directoryCommand);

            const decision = await invokePreToolUse(source, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', directoryCommand);
            assert.match(decision.permissionDecisionReason, /dynamic directory change/);
        }

        for (const path of ['./repo', '../repo']) {
            assert.equal(
                parseGit(`cd ${path} && git commit -m x`, source)
                    .commands.at(-1).targetUncertain,
                false,
                path,
            );
        }
    } finally {
        if (previousCdpath === undefined) delete process.env.CDPATH;
        else process.env.CDPATH = previousCdpath;
        rmSync(source, { recursive: true, force: true });
        rmSync(cdpathRoot, { recursive: true, force: true });
    }
});

test('non-POSIX executors fail closed before repository target parsing', async () => {
    const source = makeHookRepo('clean', 'aim-hook-non-posix-target-');
    try {
        for (const [toolName, command] of [
            ['cmd', String.raw`cd C:\strict && git commit -m x`],
            ['powershell', String.raw`git -C C:\strict commit -m x`],
            ['powershell', String.raw`env -C C:\strict git commit -m x`],
            ['powershell', String.raw`sudo git -C C:\strict commit -m x`],
            ['powershell', String.raw`sudo env -C C:\strict git commit -m x`],
            ['pwsh', String.raw`Set-Location C:\strict; git commit -m x`],
            ['mcp__powershell__invoke', String.raw`Set-Location C:\strict; git commit -m x`],
            ['powershell', String.raw`$env:GIT_DIR = 'C:\strict\.git'; git add .env`],
            ['cmd', String.raw`set GIT_DIR=C:\strict\.git && git add .env`],
            ['fish', 'set -x GIT_DIR /strict/.git; git add .env'],
            ['fish', 'cd (pwd)/strict; git commit -m x'],
            ['mcp__fish__invoke', 'cd (pwd)/strict; git commit -m x'],
        ]) {
            const decision = await invokePreToolUse(source, {
                tool_name: toolName,
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', `${toolName}: ${command}`);
            assert.match(
                decision.permissionDecisionReason,
                /non-POSIX shell syntax/,
                `${toolName}: ${command}`,
            );
        }
        for (const command of [
            'git commit -C HEAD -m x',
            'git commit -m "fix; cd handling"',
        ]) {
            const decision = await invokePreToolUse(source, {
                tool_name: 'powershell',
                tool_input: { command },
            });
            assert.doesNotMatch(
                decision?.permissionDecisionReason || '',
                /repository target selected with non-POSIX/,
                command,
            );
        }
    } finally {
        rmSync(source, { recursive: true, force: true });
    }
});

test('hook-affecting config cannot bypass the final ref guard for protected Git mutations', async () => {
    for (const profile of ['clean', 'compliance', 'strict']) {
        const dir = makeHookRepo(profile, `aim-hook-ref-bypass-${profile}-`);
        try {
            const before = gitValue(dir, 'rev-parse', 'HEAD');
            const branch = gitValue(dir, 'branch', '--show-current');
            writeFileSync(join(dir, '.env'), 'RELEASE_BLOCKER=secret\n');
            execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
            const tree = gitValue(dir, 'write-tree');
            execFileSync('git', ['reset', '-q', 'HEAD', '--', '.env'], { cwd: dir });
            rmSync(join(dir, '.env'));
            const bad = execFileSync(
                'git',
                ['commit-tree', tree, '-p', before, '-m', 'forbidden tree'],
                { cwd: dir, encoding: 'utf8' },
            ).trim();

            for (const command of [
                `git -c core.hooksPath=/dev/null update-ref refs/heads/${branch} ${bad} ${before}`,
                `git -c core.hooksPath=/dev/null cherry-pick ${bad}`,
                `git -c core.hooksPath=/dev/null fetch . ${bad}:refs/heads/bypass-fetch`,
                `git -c core.hooksPath=/dev/null worktree add -b bypass-worktree ../bypass-worktree ${bad}`,
                `git -c core.hooksPath=/dev/null stash branch bypass-stash ${bad}`,
                'git -c core.hooksPath=/dev/null remote update',
                'git -c core.hooksPath=/dev/null bisect start',
                `git push --receive-pack='git -c core.hooksPath=/dev/null receive-pack' . ${bad}:refs/heads/bypass-push`,
                `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git update-ref refs/heads/${branch} ${bad} ${before}`,
                `rm .git/hooks/reference-transaction && git update-ref refs/heads/${branch} ${bad} ${before}`,
            ]) {
                const decision = await invokePreToolUse(dir, {
                    tool_name: 'Bash',
                    tool_input: { command },
                });
                assert.equal(decision?.permissionDecision, 'deny', `${profile}: ${command}`);
                assert.match(
                    decision.permissionDecisionReason,
                    /final reference update|earlier command|policy hooks/,
                    `${profile}: ${command}`,
                );
                assert.equal(gitValue(dir, 'rev-parse', 'HEAD'), before, command);
            }

            const normal = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: {
                    command: `git update-ref refs/heads/${branch} ${bad} ${before}`,
                },
            });
            assert.equal(normal, null, profile);
            const blocked = spawnSync(
                'git',
                ['update-ref', `refs/heads/${branch}`, bad, before],
                { cwd: dir, encoding: 'utf8' },
            );
            assert.notEqual(blocked.status, 0, `${profile}: ${blocked.stderr}`);
            assert.equal(gitValue(dir, 'rev-parse', 'HEAD'), before, profile);
            assert.match(blocked.stderr, /secret\.dotenv|rejected before refs changed/, profile);

            const fetchBranch = `normal-fetch-${profile}`;
            const normalFetch = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: {
                    command: `git fetch . ${bad}:refs/heads/${fetchBranch}`,
                },
            });
            assert.equal(normalFetch, null, profile);
            const blockedFetch = spawnSync(
                'git',
                ['fetch', '.', `${bad}:refs/heads/${fetchBranch}`],
                { cwd: dir, encoding: 'utf8' },
            );
            assert.notEqual(blockedFetch.status, 0, `${profile}: ${blockedFetch.stderr}`);
            assert.notEqual(spawnSync(
                'git', ['show-ref', '--verify', `refs/heads/${fetchBranch}`],
                { cwd: dir },
            ).status, 0, profile);

            const worktreeParent = mkdtempSync(join(tmpdir(), `aim-hook-worktree-${profile}-`));
            const worktreePath = join(worktreeParent, 'blocked');
            const worktreeBranch = `normal-worktree-${profile}`;
            const normalWorktree = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: {
                    command: `git worktree add -b ${worktreeBranch} ${worktreePath} ${bad}`,
                },
            });
            assert.equal(normalWorktree, null, profile);
            const blockedWorktree = spawnSync(
                'git',
                ['worktree', 'add', '-b', worktreeBranch, worktreePath, bad],
                { cwd: dir, encoding: 'utf8' },
            );
            assert.notEqual(blockedWorktree.status, 0, `${profile}: ${blockedWorktree.stderr}`);
            assert.notEqual(spawnSync(
                'git', ['show-ref', '--verify', `refs/heads/${worktreeBranch}`],
                { cwd: dir },
            ).status, 0, profile);
            rmSync(worktreeParent, { recursive: true, force: true });

            execFileSync('git', ['remote', 'add', 'self', '.'], { cwd: dir });
            execFileSync(
                'git',
                ['config', 'remote.self.receivepack', 'git -c core.hooksPath=/dev/null receive-pack'],
                { cwd: dir },
            );
            const configuredReceiver = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command: `git push self ${bad}:refs/heads/bypass-configured` },
            });
            assert.equal(configuredReceiver.permissionDecision, 'deny', profile);
            assert.match(configuredReceiver.permissionDecisionReason, /configured remote receive-pack/, profile);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('every profile denies protected Git operations when the final managed guard is missing', async () => {
    for (const profile of ['clean', 'compliance', 'strict']) {
        const dir = makeHookRepo(profile, `aim-hook-missing-final-${profile}-`);
        try {
            const before = gitValue(dir, 'rev-parse', 'HEAD');
            const branch = gitValue(dir, 'branch', '--show-current');
            unlinkSync(join(dir, '.git', 'hooks', 'reference-transaction'));
            for (const command of [
                `git update-ref refs/heads/${branch} ${before} ${before}`,
                'git commit -m guarded',
            ]) {
                const decision = await invokePreToolUse(dir, {
                    tool_name: 'Bash',
                    tool_input: { command },
                });
                assert.equal(decision.permissionDecision, 'deny', `${profile}: ${command}`);
                assert.match(decision.permissionDecisionReason, /reference-transaction.*unavailable/s);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('commit editor classification matches real Git for fixup and squash messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-editor-options-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        const marker = join(dir, 'editor-ran');
        const editor = join(dir, 'editor.sh');
        writeFileSync(editor, `#!/bin/sh\n: > ${shellQuote(marker)}\n`);
        chmodSync(editor, 0o755);
        const editorCommand = shellQuote(editor);

        for (const { args, editorRisk } of [
            { args: ['--fixup=HEAD'], editorRisk: false },
            { args: ['--fixup=amend:HEAD'], editorRisk: true },
            { args: ['--fixup=amend:HEAD', '--no-edit'], editorRisk: false },
            { args: ['--fixup=reword:HEAD'], editorRisk: true },
            { args: ['--fixup=reword:HEAD', '--no-edit'], editorRisk: false },
            { args: ['--squash=HEAD'], editorRisk: true },
            { args: ['--squash=HEAD', '-m', 'note'], editorRisk: false },
        ]) {
            rmSync(marker, { force: true });
            const result = spawnSync(
                'git',
                ['commit', '--allow-empty', ...args, '--no-verify'],
                { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: editorCommand } },
            );
            assert.equal(result.status, 0, result.stderr);
            assert.equal(existsSync(marker), editorRisk, args.join(' '));
            assert.equal(
                parseGit(`git commit --allow-empty ${args.join(' ')}`).commands[0].editorRisk,
                editorRisk,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('asObject coerces non-object hook input to an empty object', () => {
    // A hostile or malformed host payload must not crash the hook on property
    // access (e.g. JSON.parse('null') -> null -> null.cwd throws).
    assert.deepEqual(asObject(null), {});
    assert.deepEqual(asObject(undefined), {});
    assert.deepEqual(asObject('not an object'), {});
    assert.deepEqual(asObject(42), {});
    assert.deepEqual(asObject([1, 2]), {});
    assert.deepEqual(asObject({ a: 1 }), { a: 1 });
});

test('malformed, empty, and non-object PreToolUse payloads produce an explicit deny', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-invalid-input-'));
    try {
        for (const raw of ['', '{', '{"tool_name":', 'null', '[]', '"executor"']) {
            const decision = await invokePreToolUseRaw(dir, raw);
            assert.equal(decision.permissionDecision, 'deny', JSON.stringify(raw));
            assert.match(
                decision.permissionDecisionReason,
                /payload (?:was empty|must be a JSON object|is not valid JSON)/,
                JSON.stringify(raw),
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('hookSessionStart writes managed excludes into .git/info/exclude', async () => {
    const { hookSessionStart } = await import('../src/hook.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-'));
    const realCwd = process.cwd();
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true; // suppress emit() JSON noise
    process.chdir(dir);
    try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        hookSessionStart();
        const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
        assert.match(exclude, /\.playwright-mcp\//);
    } finally {
        process.chdir(realCwd);
        process.stdout.write = origWrite;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('hookPreToolUse: clean allows the add with an advisory (no deny)', async () => {
    // Run in a fresh temp git repo so the assertion does not depend on the
    // aimhooman repo's stored profile: a repo with no config.json defaults to
    // 'clean' (see state.mjs#loadConfig).
    const dir = mkdtempSync(join(tmpdir(), 'aim-pretool-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    try {
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git add .playwright-mcp/trace.json' },
        });
        assert.notEqual(out.permissionDecision, 'deny');
        assert.match(out.hookSpecificOutput.additionalContext, /advisory/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean denies a --no-verify commit that stages files at commit time (-a)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-noverify-future-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        // Tracked file modified but NOT staged: `git commit -a` stages it at
        // commit time, and --no-verify bypasses the pre-commit guard. The agent
        // guard cannot see that future index, so it must deny even under clean.
        writeFileSync(join(dir, 'README.md'), 'changed\n');

        const denied = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -a --no-verify -m x' },
        });
        assert.equal(denied.permissionDecision, 'deny');
        assert.match(denied.permissionDecisionReason, /stages files at commit time/);

        // A plain --no-verify commit of the already-staged set stays advisory
        // under clean (the guard inspected stagedPaths); the deny only triggers
        // when a future index cannot be inspected.
        const allowed = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m x' },
        });
        assert.notEqual(allowed?.permissionDecision, 'deny');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('strict direct commit requires both current managed hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-strict-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync('node', [CLI, 'init', '--profile', 'strict'], { cwd: dir });
        unlinkSync(join(dir, '.git', 'hooks', 'commit-msg'));
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m safe' },
        });
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /commit-msg.*unavailable/);
        assert.doesNotMatch(out.permissionDecisionReason, /forbids bypassing/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('strict PreToolUse resolves direct commit aliases and denies bypass or unknown aliases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-alias-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });
        execFileSync('git', ['config', 'alias.ci', 'commit'], { cwd: dir });
        execFileSync('git', ['config', 'alias.cino', 'commit --no-verify'], { cwd: dir });

        writeFileSync(join(dir, 'README.md'), 'safe alias commit\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        const allowed = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git ci -m safe-alias' },
        });
        assert.notEqual(allowed?.permissionDecision, 'deny');
        const actual = spawnSync('git', ['ci', '-m', 'safe alias'], { cwd: dir, encoding: 'utf8' });
        assert.equal(actual.status, 0, actual.stderr);

        writeFileSync(join(dir, 'README.md'), 'bypass alias commit\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const denied = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git cino -m bypass-alias' },
        });
        assert.equal(denied.permissionDecision, 'deny');
        assert.match(denied.permissionDecisionReason, /forbids bypassing/);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);

        const unknown = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git mystery-subcommand' },
        });
        assert.equal(unknown.permissionDecision, 'deny');
        assert.match(unknown.permissionDecisionReason, /cannot prove.*subcommand or alias/);

        const fakeGit = join(dir, 'git');
        const fakeGitMarker = join(dir, 'fake-git-ran');
        writeFileSync(fakeGit, `#!/bin/sh\n: > "${fakeGitMarker}"\n`);
        chmodSync(fakeGit, 0o755);
        const pathedAlias = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: './git ci -m untrusted-executable' },
        });
        assert.equal(pathedAlias.permissionDecision, 'deny');
        assert.match(pathedAlias.permissionDecisionReason, /cannot prove.*subcommand or alias/);
        assert.equal(existsSync(fakeGitMarker), false, 'inspection must not execute the supplied Git path');

        for (const command of [
            "git -c alias.temp='commit --no-verify' temp -m transient-alias",
            "git config alias.temp 'commit --no-verify' && git temp -m changed-alias",
            'PATH=/tmp/fake git ci -m risky-path-alias',
        ]) {
            const risky = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(risky.permissionDecision, 'deny', command);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('strict PreToolUse rejects runtime assignments, indirect history changes, and hook mutation prefixes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-command-risk-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

        for (const command of [
            'NODE_OPTIONS=--require=/tmp/inject.cjs git commit -m unsafe',
            'PATH=/tmp/fake; /usr/bin/git commit -m unsafe',
            'export NODE_PATH=/tmp/modules && git commit -m unsafe',
            'GIT_DIR=/tmp/other.git git commit -m unsafe',
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(out.permissionDecision, 'deny', command);
            assert.match(out.permissionDecisionReason, /environment assignments/, command);
        }

        for (const command of [
            'x=git; $x commit --no-verify -m unsafe',
            "eval 'git commit --no-verify -m unsafe'",
            'exec git commit --no-verify -m unsafe',
            '$(printf git) commit --no-verify -m unsafe',
            "printf '%s\\n' 'git commit --no-verify -m unsafe' | sh",
            "echo 'git commit --no-verify -m unsafe' | bash",
            `python -c "import os; os.system('git commit --no-verify -m unsafe')"`,
            `perl -e "system('git commit --no-verify -m unsafe')"`,
            `node -e "require('child_process').execSync('git commit --no-verify -m unsafe')"`,
            "printf '%s\\n' 'git commit --no-verify -m unsafe' | cat | sh",
            "printf '%s\\n' 'git commit --no-verify -m unsafe' | sh -c 'cat | sh'",
            `sh -c 'eval "$1"' _ 'git commit --no-verify -m unsafe'`,
            `bash -c '"$@"' _ git commit --no-verify -m unsafe`,
            `powershell -Command "'git commit --no-verify -m unsafe' | Invoke-Expression"`,
            'git checkout other-branch && git commit -m unsafe',
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(out.permissionDecision, 'deny', command);
            assert.match(
                out.permissionDecisionReason,
                /dynamic execution|Git state change|strict Git commit|forbids bypassing|shell expansion/,
                command,
            );
        }

        for (const command of [
            'rm .git/hooks/pre-commit .git/hooks/commit-msg && git commit -m unsafe',
            'git config core.hooksPath /tmp/empty && git commit -m unsafe',
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(out.permissionDecision, 'deny', command);
            assert.match(out.permissionDecisionReason, /earlier command/, command);
            assert.equal(
                execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
                before,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('POSIX control forms cannot hide a no-verify commit from strict or clean', async () => {
    const commands = [
        'if true; then git commit --no-verify -m bypass; fi',
        '! git commit --no-verify -m bypass',
        'for x in y; do git commit --no-verify -m bypass; done',
        'if true; then "$GIT_COMMAND"; fi',
    ];
    const strict = makeHookRepo('strict', 'aim-hook-posix-strict-');
    const clean = makeHookRepo('clean', 'aim-hook-posix-clean-');
    const shellControl = makeHookRepo('clean', 'aim-hook-posix-shell-');
    try {
        for (const [index, command] of commands.slice(0, 3).entries()) {
            writeFileSync(join(shellControl, 'README.md'), `shell commit ${index}\n`);
            execFileSync('git', ['add', 'README.md'], { cwd: shellControl });
            const before = gitValue(shellControl, 'rev-parse', 'HEAD');
            const execution = spawnSync(BASH, ['-c', command], {
                cwd: shellControl,
                encoding: 'utf8',
            });
            assert.equal(execution.status, index === 1 ? 1 : 0, execution.stderr);
            assert.notEqual(gitValue(shellControl, 'rev-parse', 'HEAD'), before, command);
        }

        writeFileSync(join(strict, 'README.md'), 'strict staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: strict });
        const strictHead = gitValue(strict, 'rev-parse', 'HEAD');
        const strictIndex = gitValue(strict, 'write-tree');
        for (const command of commands) {
            const decision = await invokePreToolUse(strict, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', command);
            assert.match(
                decision.permissionDecisionReason,
                /strict Git commit|cannot safely verify|shell expansion/,
                command,
            );
            assert.equal(gitValue(strict, 'rev-parse', 'HEAD'), strictHead, command);
            assert.equal(gitValue(strict, 'write-tree'), strictIndex, command);
        }

        writeFileSync(
            join(clean, 'ordinary.txt'),
            'safe\n-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n',
        );
        execFileSync('git', ['add', 'ordinary.txt'], { cwd: clean });
        const cleanHead = gitValue(clean, 'rev-parse', 'HEAD');
        const cleanIndex = gitValue(clean, 'write-tree');
        for (const command of commands) {
            const decision = await invokePreToolUse(clean, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', command);
            assert.match(decision.permissionDecisionReason, /secret\.private-key-content/, command);
            assert.equal(gitValue(clean, 'rev-parse', 'HEAD'), cleanHead, command);
            assert.equal(gitValue(clean, 'write-tree'), cleanIndex, command);
        }
    } finally {
        rmSync(strict, { recursive: true, force: true });
        rmSync(clean, { recursive: true, force: true });
        rmSync(shellControl, { recursive: true, force: true });
    }
});

test('directory-stack changes cannot select a repository behind stale parser cwd', async () => {
    const source = makeHookRepo('clean', 'aim-hook-pushd-source-');
    const target = makeHookRepo('strict', 'aim-hook-pushd-target-');
    try {
        writeFileSync(join(target, 'README.md'), 'strict target staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: target });
        mkdirSync(join(target, 'nested'));
        const shellTarget = shellQuote(target);
        writeFileSync(join(source, 'jump.sh'), `cd ${shellTarget}\n`);
        const beforeHead = gitValue(target, 'rev-parse', 'HEAD');
        const beforeIndex = gitValue(target, 'write-tree');
        const relativeTarget = shellQuote(relative(source, target));
        const probeMarker = '.aimhooman-shell-target';
        writeFileSync(join(target, probeMarker), 'target\n');
        const shellProbe = spawnSync(
            BASH,
            ['-c', `pushd ${shellTarget} >/dev/null && test -f ${probeMarker} && popd >/dev/null`],
            { cwd: source, encoding: 'utf8' },
        );
        assert.equal(shellProbe.status, 0, shellProbe.stderr);
        for (const command of [
            `pushd ${shellTarget}; git commit --no-verify -m bypass`,
            `pushd ${relativeTarget} && git commit --no-verify -m bypass`,
            `builtin pushd ${shellTarget} && git commit --no-verify -m bypass`,
            `pushd ${shellTarget} && pushd nested && popd && git commit --no-verify -m bypass`,
            `eval 'pushd ${shellTarget}' && git commit --no-verify -m bypass`,
            `. ./jump.sh && git commit --no-verify -m bypass`,
            `jump(){ pushd ${shellTarget}; }; jump && git commit --no-verify -m bypass`,
            `pushd ${shellQuote(join(source, 'missing'))} || git commit --no-verify -m bypass`,
            'popd && git commit --no-verify -m bypass',
        ]) {
            const decision = await invokePreToolUse(source, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', command);
            assert.equal(gitValue(target, 'rev-parse', 'HEAD'), beforeHead, command);
            assert.equal(gitValue(target, 'write-tree'), beforeIndex, command);
        }
    } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
    }
});

test('inline alias configuration is denied before its unproved expansion can run', async () => {
    for (const profile of ['clean', 'compliance']) {
        const dir = makeHookRepo(profile, `aim-hook-inline-alias-${profile}-`);
        try {
            writeFileSync(
                join(dir, 'ordinary.txt'),
                'safe\n-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n',
            );
            execFileSync('git', ['add', 'ordinary.txt'], { cwd: dir });
            const beforeHead = gitValue(dir, 'rev-parse', 'HEAD');
            const beforeIndex = gitValue(dir, 'write-tree');
            for (const command of [
                "git -c alias.ship='commit --no-verify' ship -m bypass",
                "AIM_ALIAS='commit --no-verify' git --config-env=alias.ship=AIM_ALIAS ship -m bypass",
                "git -c alias.outer=inner -c 'alias.inner=commit --no-verify' outer -m bypass",
                "git -c 'alias.ship=!git commit --no-verify -m bypass' ship",
            ]) {
                const decision = await invokePreToolUse(dir, {
                    tool_name: 'Bash',
                    tool_input: { command },
                });
                assert.equal(decision.permissionDecision, 'deny', `${profile}: ${command}`);
                assert.match(decision.permissionDecisionReason, /inline Git alias/, command);
                assert.match(decision.permissionDecisionReason, /managed reference-transaction guard/, command);
                assert.equal(gitValue(dir, 'rev-parse', 'HEAD'), beforeHead, command);
                assert.equal(gitValue(dir, 'write-tree'), beforeIndex, command);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('inline and external Git commands cannot hide future index or hook mutation', async () => {
    for (const profile of ['clean', 'compliance']) {
        const dir = makeHookRepo(profile, `aim-hook-unproved-alias-${profile}-`);
        try {
            writeFileSync(
                join(dir, 'future-secret.txt'),
                '-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n',
            );
            const before = gitValue(dir, 'rev-parse', 'HEAD');
            for (const command of [
                "git -c 'alias.ship=!git add future-secret.txt && git -c core.hooksPath=/dev/null commit --no-verify -m leak' ship",
                'git mystery-subcommand',
            ]) {
                const decision = await invokePreToolUse(dir, {
                    tool_name: 'Bash',
                    tool_input: { command },
                });
                assert.equal(decision.permissionDecision, 'deny', `${profile}: ${command}`);
                assert.match(decision.permissionDecisionReason, /cannot prove.*managed reference-transaction guard/, command);
                assert.equal(gitValue(dir, 'rev-parse', 'HEAD'), before, command);
                assert.equal(gitValue(dir, 'status', '--short'), '?? future-secret.txt', command);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('direct sequencer verbs use the managed final reference boundary', async () => {
    const dir = makeHookRepo('strict', 'aim-hook-direct-sequencer-');
    try {
        for (const verb of ['am', 'cherry-pick', 'merge', 'pull', 'rebase', 'revert']) {
            const parsed = parseGit(`git ${verb} target`);
            assert.equal(parsed.commands[0]?.verb, verb, verb);
            const decision = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command: `git ${verb} target` },
            });
            assert.equal(decision, null, verb);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('unresolved eval and source indirection are uncertainty boundaries', () => {
    for (const command of ['eval "$AIM_COMMAND"', 'source ./commands.sh', '. ./commands.sh']) {
        assert.equal(parseGit(command).uncertainShell, true, command);
    }
});

test('alternate and replaced Git indexes are denied before a clean no-verify commit', async () => {
    const dir = makeHookRepo('clean', 'aim-hook-index-snapshot-');
    try {
        writeFileSync(join(dir, 'README.md'), 'safe default index\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        const defaultIndex = join(dir, '.git', 'index');
        const alternateIndex = join(dir, '.git', 'alternate-index');
        copyFileSync(defaultIndex, alternateIndex);
        writeFileSync(
            join(dir, 'ordinary.txt'),
            'safe\n-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n',
        );
        execFileSync('git', ['add', 'ordinary.txt'], {
            cwd: dir,
            env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
        });
        assert.doesNotMatch(gitValue(dir, 'ls-files'), /ordinary\.txt/);
        assert.match(execFileSync('git', ['ls-files'], {
            cwd: dir,
            env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
            encoding: 'utf8',
        }), /ordinary\.txt/);

        const beforeHead = gitValue(dir, 'rev-parse', 'HEAD');
        const beforeIndex = gitValue(dir, 'write-tree');
        for (const command of [
            `GIT_INDEX_FILE="${alternateIndex}" git commit --no-verify -m bypass`,
            'GIT_INDEX_FILE=.git/alternate-index git commit --no-verify -m bypass',
            `env GIT_INDEX_FILE="${alternateIndex}" git commit --no-verify -m bypass`,
        ]) {
            const decision = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision.permissionDecision, 'deny', command);
            assert.match(decision.permissionDecisionReason, /exact staged snapshot/, command);
        }

        const replacement = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: {
                command: `cp "${alternateIndex}" .git/index && git commit --no-verify -m bypass`,
            },
        });
        assert.equal(replacement.permissionDecision, 'deny');
        assert.match(replacement.permissionDecisionReason, /replaces the Git index/);
        const unmodelled = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: {
                command: 'node mutate-index.mjs && git commit -m bypass',
            },
        });
        assert.equal(unmodelled.permissionDecision, 'deny');
        assert.match(unmodelled.permissionDecisionReason, /earlier unmodelled command/);
        assert.equal(gitValue(dir, 'rev-parse', 'HEAD'), beforeHead);
        assert.equal(gitValue(dir, 'write-tree'), beforeIndex);
        assert.doesNotMatch(gitValue(dir, 'ls-files'), /ordinary\.txt/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('strict PreToolUse denies wrapper, shell, interpreter, and script-block indirection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-indirection-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });

        // Class A (direct-exec wrappers), B (-c shells), C (eval interpreters),
        // and D (script-block / dynamic-eval forms) must all be denied — never
        // silently allowed — when they wrap `git commit --no-verify`.
        for (const command of [
            'su -c "git commit --no-verify"',
            'pkexec git commit --no-verify',
            'firejail git commit --no-verify',
            'fish -c "git commit --no-verify"',
            'ash -c "git commit --no-verify"',
            'lua -e "os.execute(\'git commit --no-verify\')"',
            'awk \'BEGIN{system("git commit --no-verify")}\'',
            'Invoke-Command { git commit --no-verify }',
            '& { git commit --no-verify }',
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(out.permissionDecision, 'deny', command);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('combined add and commit relies on the installed strict final guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-combined-add-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', 'README.md', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });

        writeFileSync(join(dir, 'README.md'), 'safe\n');
        const safeCommand = 'git add -A && git commit -m safe';
        const safeDecision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: safeCommand },
        });
        assert.notEqual(safeDecision?.permissionDecision, 'deny');
        const safeCommit = spawnSync(BASH, ['-c', safeCommand], { cwd: dir, encoding: 'utf8' });
        assert.equal(safeCommit.status, 0, safeCommit.stderr);

        const beforeBlocked = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        writeFileSync(join(dir, '.env'), 'TOKEN=unsafe\n');
        const forbiddenDecision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: safeCommand },
        });
        assert.notEqual(forbiddenDecision?.permissionDecision, 'deny');
        const forbiddenCommit = spawnSync(BASH, ['-c', safeCommand], { cwd: dir, encoding: 'utf8' });
        assert.notEqual(forbiddenCommit.status, 0);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), beforeBlocked);
        execFileSync('git', ['reset', '-q'], { cwd: dir });
        rmSync(join(dir, '.env'), { force: true });

        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        const downgradeDecision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: safeCommand },
        });
        assert.notEqual(downgradeDecision?.permissionDecision, 'deny');
        const downgradeCommit = spawnSync(BASH, ['-c', safeCommand], { cwd: dir, encoding: 'utf8' });
        assert.notEqual(downgradeCommit.status, 0);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), beforeBlocked);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('literal and aliased branch transitions cannot hide a strict no-verify commit behind clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-branch-transition-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', 'README.md', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'clean base'], { cwd: dir });
        const cleanBranch = execFileSync(
            'git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' },
        ).trim();
        execFileSync('git', ['checkout', '-q', '-b', 'strict-branch'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'strict branch'], { cwd: dir });
        execFileSync('git', ['checkout', '-q', cleanBranch], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        execFileSync('git', ['config', 'alias.co', 'checkout'], { cwd: dir });
        execFileSync('git', [
            'config',
            'alias.transition-commit',
            '!git checkout strict-branch && git commit --no-verify -m unsafe',
        ], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        for (const command of [
            'git checkout strict-branch && git commit --no-verify -m unsafe',
            'git co strict-branch && git commit --no-verify -m unsafe',
            'git transition-commit',
        ]) {
            const decision = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(decision?.permissionDecision, 'deny', command);
            assert.match(decision.permissionDecisionReason, /Git state change/, command);
            assert.equal(
                execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim(),
                cleanBranch,
                command,
            );
            assert.equal(
                execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
                before,
                command,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('replacement refs cannot rewrite the strict HEAD policy seen by the agent guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-replace-policy-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'strict\n');
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', 'README.md', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'strict policy'], { cwd: dir });
        const originalBranch = execFileSync(
            'git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' },
        ).trim();
        const strictHead = execFileSync(
            'git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' },
        ).trim();

        execFileSync('git', ['checkout', '-q', '--orphan', 'replacement-policy'], { cwd: dir });
        execFileSync('git', ['rm', '-q', '-rf', '.'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'replacement\n');
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', 'README.md', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'clean replacement'], { cwd: dir });
        const replacementHead = execFileSync(
            'git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' },
        ).trim();

        execFileSync('git', ['checkout', '-q', originalBranch], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init'], { cwd: dir });
        execFileSync('git', ['replace', strictHead, replacementHead], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });

        const decision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m unsafe' },
        });
        assert.equal(decision.permissionDecision, 'deny');
        assert.match(decision.permissionDecisionReason, /strict profile forbids bypassing/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('strict PreToolUse blocks explicit editors before they can remove the message guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-editor-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });

        const commitMessageHook = join(dir, '.git', 'hooks', 'commit-msg');
        const editor = join(dir, 'message-editor.sh');
        writeFileSync(
            editor,
            `#!/bin/sh\nprintf '\\nCo-authored-by: Codex <noreply@openai.com>\\n' >> "$1"\n` +
            `rm -f "${commitMessageHook}"\n`,
        );
        chmodSync(editor, 0o755);
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const defaultEditor = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit' },
        });
        assert.equal(defaultEditor.permissionDecision, 'deny');
        assert.match(defaultEditor.permissionDecisionReason, /opens a local editor/);

        const command = `git -c core.editor=${editor} commit`;
        const decision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command },
        });

        // Model the host gate: execution happens only when PreToolUse does not
        // deny it. If the classification regresses, the editor demonstrates
        // the real hook deletion path before the assertions fail.
        if (decision?.permissionDecision !== 'deny') {
            spawnSync('git', ['-c', `core.editor=${editor}`, 'commit'], { cwd: dir, encoding: 'utf8' });
        }
        assert.equal(decision?.permissionDecision, 'deny');
        assert.match(decision.permissionDecisionReason, /forbids bypassing/);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
        assert.equal(existsSync(commitMessageHook), true);

        for (const riskyCommand of [
            `git -c sequence.editor=${editor} commit`,
            `GIT_EDITOR=${editor} git commit`,
            `GIT_SEQUENCE_EDITOR=${editor} git commit`,
            `VISUAL=${editor} git commit`,
            `EDITOR=${editor} git commit`,
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command: riskyCommand },
            });
            assert.equal(out.permissionDecision, 'deny', riskyCommand);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('strict PreToolUse blocks a foreign prepare-message hook before it can remove commit-msg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-prepare-message-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });

        const commitMessageHook = join(dir, '.git', 'hooks', 'commit-msg');
        const prepareMessageHook = join(dir, '.git', 'hooks', 'prepare-commit-msg');
        writeFileSync(prepareMessageHook, `#!/bin/sh\nrm -f "${commitMessageHook}"\n`);
        chmodSync(prepareMessageHook, 0o755);
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const decision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m unsafe' },
        });
        if (decision?.permissionDecision !== 'deny') {
            spawnSync('git', ['commit', '-m', 'unsafe'], { cwd: dir, encoding: 'utf8' });
        }
        assert.equal(decision?.permissionDecision, 'deny');
        assert.match(decision.permissionDecisionReason, /prepare-commit-msg/);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
        assert.equal(existsSync(commitMessageHook), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('uncertain shell syntax remains advisory outside strict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-clean-uncertain-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m safe | tee commit.log' },
        });
        assert.notEqual(out?.permissionDecision, 'deny');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('literal indirection into a strict target is denied from a clean repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-hook-cross-target-'));
    const clean = join(root, 'clean');
    const strict = join(root, 'strict');
    try {
        execFileSync('git', ['init', '-q', clean]);
        execFileSync('git', ['init', '-q', strict]);
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: strict });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: strict });
        writeFileSync(join(strict, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: strict });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: strict });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: strict });
        writeFileSync(join(strict, 'README.md'), 'staged\n');
        execFileSync('git', ['add', 'README.md'], { cwd: strict });
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: strict, encoding: 'utf8' }).trim();
        const target = shellQuote(strict);
        for (const command of [
            `(cd ${target}; printf '%s\\n' 'git commit --no-verify -m unsafe' | sh)`,
            `D=${target}; eval 'git -C "$D" commit --no-verify -m unsafe'`,
            `CMD="git -C ${target} commit --no-verify -m unsafe"; eval "$CMD"`,
            `CMD="git -C ${target} commit --no-verify -m unsafe"; sh -c "$CMD"`,
            `set -- git -C ${target} commit --no-verify -m unsafe; "$@"`,
            `f(){ git -C ${target} commit --no-verify -m unsafe; }; f`,
            `GIT_DIR=${target}/.git GIT_WORK_TREE=${target} git commit --no-verify -m unsafe`,
        ]) {
            const decision = await invokePreToolUse(clean, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            if (decision?.permissionDecision !== 'deny') {
                spawnSync(BASH, ['-c', command], { cwd: clean, encoding: 'utf8' });
            }
            assert.equal(decision?.permissionDecision, 'deny', command);
            assert.match(
                decision.permissionDecisionReason,
                /strict Git commit|dynamic execution|environment assignments|shell expansion/,
                command,
            );
            assert.equal(
                execFileSync('git', ['rev-parse', 'HEAD'], { cwd: strict, encoding: 'utf8' }).trim(),
                before,
                command,
            );
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('known executor aliases and JSON-string tool arguments are inspected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-executor-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        writeFileSync(
            join(dir, '.aimhooman.json'),
            JSON.stringify({ schema_version: 1, profile: 'strict' })
        );
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init'], { cwd: dir });
        const execAlias = await invokePreToolUse(dir, {
            tool_name: 'functions.exec_command',
            tool_input: { cmd: 'git commit --no-veri -m unsafe' },
        });
        assert.equal(execAlias.permissionDecision, 'deny');
        assert.match(execAlias.permissionDecisionReason, /forbids bypassing/);

        const copilotShape = await invokePreToolUse(dir, {
            toolName: 'powershell',
            toolArgs: JSON.stringify({ command: 'git commit --no-veri -m unsafe' }),
        });
        assert.equal(copilotShape.permissionDecision, 'deny');
        assert.match(
            copilotShape.permissionDecisionReason,
            /forbids bypassing|cannot safely verify|strict Git commit/,
        );

        const directPowerShell = await invokePreToolUse(dir, {
            toolName: 'powershell',
            toolArgs: { command: 'git commit -m direct' },
        });
        assert.equal(directPowerShell.permissionDecision, 'deny');
        assert.match(
            directPowerShell.permissionDecisionReason,
            /cannot safely verify|strict Git commit/,
        );
        const directBash = await invokePreToolUse(dir, {
            toolName: 'bash',
            toolArgs: { command: 'git commit -m direct' },
        });
        assert.doesNotMatch(
            directBash?.permissionDecisionReason || '',
            /cannot safely verify a strict Git commit inside shell nesting/,
        );

        const mcpShell = await invokePreToolUse(dir, {
            tool_name: 'mcp__shell_server__invoke',
            tool_input: { command: 'git commit --no-verify -m unsafe' },
        });
        assert.equal(mcpShell.permissionDecision, 'deny');
        assert.match(mcpShell.permissionDecisionReason, /forbids bypassing/);

        const malformedMcpGit = await invokePreToolUse(dir, {
            tool_name: 'mcp__git__commit',
            tool_input: { argv: ['commit', '--no-verify'] },
        });
        assert.equal(malformedMcpGit.permissionDecision, 'deny');
        assert.match(malformedMcpGit.permissionDecisionReason, /cannot inspect/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('unknown non-executors pass through while malformed known executors deny in strict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-classify-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        writeFileSync(
            join(dir, '.aimhooman.json'),
            JSON.stringify({ schema_version: 1, profile: 'strict' })
        );
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        const unrelated = await invokePreToolUse(dir, {
            tool_name: 'Read',
            tool_input: { command: 'git commit --no-verify -m text-only' },
        });
        assert.equal(unrelated, null);

        const malformed = await invokePreToolUse(dir, {
            tool_name: 'exec_command',
            tool_input: { argv: ['git', 'commit'] },
        });
        assert.equal(malformed.permissionDecision, 'deny');
        assert.match(malformed.permissionDecisionReason, /cannot inspect the exec_command command payload/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('agent commit policy uses the staged policy with a strict HEAD floor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-policy-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'strict policy'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });

        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-veri -m downgrade' },
        });
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /forbids bypassing/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('reviewed staged policy migration uses the same effective policy in PreToolUse and Git hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-policy-review-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'strict policy'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init'], { cwd: dir });
        writeFileSync(join(dir, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        execFileSync('git', ['add', '.aimhooman.json'], { cwd: dir });
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        const oldObject = execFileSync('git', ['rev-parse', 'HEAD:.aimhooman.json'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        const newObject = execFileSync('git', ['rev-parse', ':.aimhooman.json'], {
            cwd: dir,
            encoding: 'utf8',
        }).trim();
        execFileSync(process.execPath, [
            CLI, 'policy-review', '--head', head, '--staged',
            '--old', oldObject, '--new', newObject, '--reason', 'approved migration',
        ], { cwd: dir });

        const decision = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m reviewed-policy-migration' },
        });
        assert.notEqual(decision?.permissionDecision, 'deny');
        const commit = spawnSync('git', ['commit', '-m', 'reviewed policy migration'], {
            cwd: dir,
            encoding: 'utf8',
        });
        assert.equal(commit.status, 0, commit.stderr);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('PreToolUse accepts only the exact reviewed staged instruction blob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-hook-reviewed-blob-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });

        writeFileSync(join(dir, 'AGENTS.md'), 'reviewed team instructions\n');
        execFileSync('git', ['add', 'AGENTS.md'], { cwd: dir });
        const head = gitValue(dir, 'rev-parse', 'HEAD');
        execFileSync(process.execPath, [
            CLI, 'review', 'AGENTS.md', '--head', head, '--reason', 'approved exact blob',
        ], { cwd: dir });

        const reviewed = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m reviewed' },
        });
        assert.notEqual(reviewed?.permissionDecision, 'deny');

        writeFileSync(join(dir, 'AGENTS.md'), 'changed after review\n');
        execFileSync('git', ['add', 'AGENTS.md'], { cwd: dir });
        const changed = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m changed' },
        });
        assert.equal(changed.permissionDecision, 'deny');
        assert.match(changed.permissionDecisionReason, /generic\.agent-instructions/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('malformed local overrides deny commands in every profile', async () => {
    for (const profile of ['clean', 'strict']) {
        const dir = mkdtempSync(join(tmpdir(), `aim-hook-overrides-${profile}-`));
        try {
            execFileSync('git', ['init', '-q'], { cwd: dir });
            execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
            execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
            execFileSync('node', [CLI, 'init', '--profile', profile], { cwd: dir });
            writeFileSync(join(dir, '.git', 'aimhooman', 'overrides.json'), '{bad');
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command: 'git add .playwright-mcp/trace.json' },
            });
            assert.equal(out.permissionDecision, 'deny');
            assert.match(out.permissionDecisionReason, /cannot load local overrides/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('clean denies a staged secret under git commit --no-verify (bypassed guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-noverify-secret-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        writeFileSync(join(dir, '.env'), 'TOKEN=value\n');
        execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m leak' },
        });
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /--no-verify or shell indirection bypasses the pre-commit guard/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean scans staged blob content before allowing a --no-verify commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-noverify-content-secret-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        writeFileSync(
            join(dir, 'notes.txt'),
            'safe\n-----BEGIN ' + 'PRIVATE KEY-----\nsecret\n',
        );
        execFileSync('git', ['add', 'notes.txt'], { cwd: dir });
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m leak' },
        });
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /secret\.private-key-content/);
        assert.match(out.permissionDecisionReason, /bypasses the pre-commit guard/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean denies a staged secret when an earlier command may disable Git hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-prefix-hook-secret-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'README.md'), 'base\n');
        execFileSync('git', ['add', 'README.md'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        mkdirSync(join(dir, 'empty-hooks'));
        execFileSync('git', ['config', 'alias.disable-hooks', 'config core.hooksPath empty-hooks'], { cwd: dir });
        execFileSync('git', ['config', 'alias.shell-disable-hooks', '!git config core.hooksPath empty-hooks'], { cwd: dir });
        execFileSync('git', ['config', 'alias.unsafe-commit', '!git commit --no-verify -m leak'], { cwd: dir });
        writeFileSync(
            join(dir, 'notes.txt'),
            'safe\n-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n',
        );
        execFileSync('git', ['add', 'notes.txt'], { cwd: dir });
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        for (const command of [
            'git config core.hooksPath empty-hooks && git commit -m leak',
            'git disable-hooks && git commit -m leak',
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(out.permissionDecision, 'deny', command);
            assert.match(out.permissionDecisionReason, /earlier command may have changed/, command);
            assert.match(out.permissionDecisionReason, /secret\.private-key-content/, command);
        }
        const shellAlias = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git shell-disable-hooks && git commit -m leak' },
        });
        assert.equal(shellAlias.permissionDecision, 'deny');
        assert.match(shellAlias.permissionDecisionReason, /cannot (?:prove|verify).*reference/);
        const shellCommit = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git unsafe-commit' },
        });
        assert.equal(shellCommit.permissionDecision, 'deny');
        assert.match(shellCommit.permissionDecisionReason, /cannot (?:prove|verify).*reference/);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
        assert.equal(spawnSync('git', ['config', '--get', 'core.hooksPath'], {
            cwd: dir,
            encoding: 'utf8',
        }).status, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean denies no-verify commits after direct or aliased index mutations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-mv-future-index-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        writeFileSync(join(dir, 'harmless.txt'), 'tracked\n');
        execFileSync('git', ['add', 'harmless.txt'], { cwd: dir });
        execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        execFileSync('git', ['config', 'alias.move', 'mv'], { cwd: dir });
        execFileSync('git', ['config', 'alias.stage', 'add -f'], { cwd: dir });
        const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        for (const command of [
            'git mv harmless.txt .env && git commit --no-verify -m leak',
            'git move harmless.txt .env && git commit --no-verify -m leak',
            'git stage . && git commit --no-verify -m leak',
        ]) {
            const out = await invokePreToolUse(dir, {
                tool_name: 'Bash',
                tool_input: { command },
            });
            assert.equal(out.permissionDecision, 'deny', command);
            assert.match(out.permissionDecisionReason, /stages files at commit time/, command);
        }
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), before);
        assert.equal(existsSync(join(dir, 'harmless.txt')), true);
        assert.equal(existsSync(join(dir, '.env')), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean fails closed when a bypassed staged-content scan is incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-noverify-incomplete-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        writeFileSync(join(dir, 'large.txt'), Buffer.alloc((2 << 20) + 1, 0x61));
        execFileSync('git', ['add', 'large.txt'], { cwd: dir });
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m unchecked' },
        });
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /cannot fully scan staged content/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('clean denies a staged secret or uncertain target under indirect --no-verify', async () => {
    // Literal eval/pipeline payloads use the clean secret backstop. Wrappers
    // such as sudo can select cwd from external configuration, so they fail
    // closed before policy lookup instead of scanning the caller's repository.
    for (const [command, reason] of [
        ["eval 'git commit --no-verify -m leak'", /shell indirection|--no-verify/],
        ['sudo git commit --no-verify -m leak', /repository target|dynamic directory/],
        ["printf '%s\\n' 'git commit --no-verify -m leak' | sh", /shell indirection|--no-verify/],
        ["echo 'git commit --no-verify -m leak' | bash", /shell indirection|--no-verify/],
    ]) {
        const parsed = parseGit(command);
        assert.equal(parsed.commit, true, `commit for: ${command}`);
        assert.equal(parsed.uncertainShell, true, `uncertainShell for: ${command}`);
        const dir = mkdtempSync(join(tmpdir(), 'aim-indirect-noverify-'));
        try {
            execFileSync('git', ['init', '-q'], { cwd: dir });
            execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
            execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
            execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
            writeFileSync(join(dir, '.env'), 'TOKEN=value\n');
            execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
            const out = await invokePreToolUse(dir, { tool_name: 'Bash', tool_input: { command } });
            assert.equal(out.permissionDecision, 'deny', `decision for: ${command}`);
            assert.match(out.permissionDecisionReason, reason, `reason for: ${command}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('clean warns (not denies) a hygiene block under git commit --no-verify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-noverify-hygiene-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'clean'], { cwd: dir });
        mkdirSync(join(dir, '.playwright-mcp'), { recursive: true });
        writeFileSync(join(dir, '.playwright-mcp', 'trace.json'), '{}');
        execFileSync('git', ['add', '-f', '.playwright-mcp/trace.json'], { cwd: dir });
        const out = await invokePreToolUse(dir, {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --no-verify -m trace' },
        });
        assert.equal(out.permissionDecision, 'allow');
        assert.match(out.hookSpecificOutput.additionalContext, /--no-verify or shell indirection bypasses the pre-commit guard/);
        assert.match(
            out.hookSpecificOutput.additionalContext,
            /cannot be assumed to be automatically removed/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('unknown executor shape fails closed when project policy cannot load (strict)', async () => {
    // Pins the fail-closed deny in unknownExecutorShape: if the team policy
    // cannot be read (corrupt .aimhooman.json), a strict repo must still deny an
    // executor payload the guard cannot inspect, never silently allow.
    const dir = mkdtempSync(join(tmpdir(), 'aim-unknown-policy-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        execFileSync(process.execPath, [CLI, 'init', '--profile', 'strict'], { cwd: dir });
        // Corrupt the local config that the strict profile resolves from, so
        // enforcementPolicy throws on read and unknownExecutorShape must deny.
        writeFileSync(join(dir, '.git', 'aimhooman', 'config.json'), '{ not valid json');
        const out = await invokePreToolUse(dir, { tool_name: 'Bash', tool_input: {} });
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /cannot load project policy/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function initializeHookRepo(dir, profile) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'base'], { cwd: dir });
    execFileSync(process.execPath, [CLI, 'init', '--profile', profile], { cwd: dir });
    return dir;
}

function makeHookRepo(profile, prefix) {
    return initializeHookRepo(mkdtempSync(join(tmpdir(), prefix)), profile);
}

function gitValue(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function invokePreToolUse(cwd, payload) {
    return invokePreToolUseRaw(cwd, JSON.stringify(payload));
}

async function invokePreToolUseRaw(cwd, rawPayload) {
    const { runHook } = await import('../src/hook.mjs');
    const { Readable } = await import('node:stream');
    const writes = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
    const realCwd = process.cwd();
    process.stdout.write = (chunk, ...args) => {
        if (typeof chunk === 'string' && chunk.startsWith('{')) {
            writes.push(chunk);
            return true;
        }
        return origWrite(chunk, ...args);
    };
    Object.defineProperty(process, 'stdin', {
        value: Readable.from([rawPayload]),
        configurable: true,
    });
    process.chdir(cwd);
    try {
        await runHook(['pre-tool-use']);
    } finally {
        Object.defineProperty(process, 'stdin', stdinDesc);
        process.stdout.write = origWrite;
        process.chdir(realCwd);
    }
    return writes.length ? JSON.parse(writes.join('')) : null;
}
