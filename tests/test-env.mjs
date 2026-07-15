import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'aimhooman-test-home-'));
const globalConfig = join(home, '.gitconfig');
writeFileSync(globalConfig, [
    '[user]',
    '    name = aimhooman test fixture',
    '    email = fixture@aimhooman.invalid',
    '[commit]',
    '    gpgsign = false',
    '[tag]',
    '    gpgsign = false',
    '[credential]',
    '    helper =',
    '',
].join('\n'));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');
process.env.GNUPGHOME = join(home, '.gnupg');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GCM_INTERACTIVE = 'never';
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
]) delete process.env[name];
for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
}

process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* process is exiting */ }
});
