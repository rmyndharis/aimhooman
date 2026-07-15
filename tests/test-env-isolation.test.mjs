import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('test bootstrap removes ambient Git target, config, template, and signing inputs', () => {
    for (const name of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_CONFIG',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_SYSTEM',
        'GIT_TEMPLATE_DIR',
        'GIT_CEILING_DIRECTORIES',
        'GIT_DISCOVERY_ACROSS_FILESYSTEM',
        'GIT_SSH',
        'GIT_SSH_COMMAND',
        'GIT_PROXY_COMMAND',
        'GIT_ASKPASS',
        'SSH_ASKPASS',
    ]) {
        assert.equal(process.env[name], undefined, name);
    }
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(process.env.GIT_TERMINAL_PROMPT, '0');
    assert.ok(process.env.GIT_CONFIG_GLOBAL?.startsWith(process.env.HOME));
    assert.ok(process.env.GNUPGHOME?.startsWith(process.env.HOME));
});

test('hostile ambient Git config, signing, and template inputs cannot affect a child fixture', () => {
    const root = join(import.meta.dirname, '..');
    const parentBefore = spawnSync('git', ['config', '--local', '--null', '--list'], {
        cwd: root,
        encoding: 'utf8',
    });
    assert.equal(parentBefore.status, 0, parentBefore.stderr);
    const script = String.raw`
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'aim-hostile-git-env-'));
try {
  if (process.env.GIT_CONFIG_COUNT !== undefined || process.env.GIT_TEMPLATE_DIR !== undefined) {
    throw new Error('test bootstrap left hostile Git variables active');
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'fixture\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
} finally {
  rmSync(dir, { recursive: true, force: true });
}`;
    const child = spawnSync(process.execPath, [
        '--import', './tests/test-env.mjs', '--input-type=module', '-e', script,
    ], {
        cwd: root,
        env: {
            ...process.env,
            GIT_CONFIG_COUNT: '3',
            GIT_CONFIG_KEY_0: 'commit.gpgSign',
            GIT_CONFIG_VALUE_0: 'true',
            GIT_CONFIG_KEY_1: 'tag.gpgSign',
            GIT_CONFIG_VALUE_1: 'true',
            GIT_CONFIG_KEY_2: 'core.hooksPath',
            GIT_CONFIG_VALUE_2: '/definitely/missing/hooks',
            GIT_TEMPLATE_DIR: '/definitely/missing/template',
            GIT_SSH_COMMAND: 'false',
        },
        encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const parentAfter = spawnSync('git', ['config', '--local', '--null', '--list'], {
        cwd: root,
        encoding: 'utf8',
    });
    assert.equal(parentAfter.status, 0, parentAfter.stderr);
    assert.equal(parentAfter.stdout, parentBefore.stdout);
});
