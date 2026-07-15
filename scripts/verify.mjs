#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPackageManifest } from './package-manifest.mjs';

const root = join(import.meta.dirname, '..');
const retainedArtifactDir = process.env.AIMHOOMAN_ARTIFACT_DIR || '';
const temporary = retainedArtifactDir || mkdtempSync(join(tmpdir(), 'aimhooman-verify-'));
const npmCli = process.env.npm_execpath;

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd || root,
        encoding: options.encoding || 'utf8',
        stdio: options.stdio || 'inherit',
        env: options.env || process.env,
    });
}

function runNpm(args, options = {}) {
    if (npmCli) return run(process.execPath, [npmCli, ...args], options);
    if (process.platform === 'win32') {
        throw new Error('Windows verification must be started with npm run verify');
    }
    return run('npm', args, options);
}

try {
    if (retainedArtifactDir) {
        mkdirSync(temporary, { recursive: true });
        rmSync(join(temporary, 'artifact.json'), { force: true });
    }
    runNpm(['run', 'check']);
    runNpm(['run', 'check:static']);
    runNpm(['run', 'test:coverage']);

    const packOutput = runNpm(['pack', '--json', '--pack-destination', temporary], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [packed] = JSON.parse(packOutput);
    if (!packed?.filename || !Array.isArray(packed.files)) throw new Error('npm pack did not return a file manifest');
    const paths = packed.files.map((entry) => entry.path);
    assertPackageManifest(paths, root);
    for (const required of [
        'bin/aimhooman.mjs', 'GEMINI.md', '.gemini/settings.json',
        '.agents/rules/aimhooman.md',
        'schemas/scan-report.schema.json', 'docs/hosts.json',
        'docs/logo/aimhooman-logo.png', 'docs/logo/aimhooman.png',
    ]) {
        if (!paths.includes(required)) throw new Error(`packed artifact is missing ${required}`);
    }

    const prefix = join(temporary, 'install');
    const tarball = join(temporary, packed.filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    if (packed.integrity && packed.integrity !== integrity) {
        throw new Error('npm pack integrity does not match the produced tarball');
    }
    runNpm(['install', '--ignore-scripts', '--prefix', prefix, tarball]);
    runNpm(['exec', '--offline', '--prefix', prefix, '--', 'aimhooman', 'version']);
    const installedCli = join(
        prefix,
        'node_modules',
        '@rmyndharis',
        'aimhooman',
        'bin',
        'aimhooman.mjs',
    );
    run(process.execPath, [installedCli, 'version']);

    const repository = join(temporary, 'repository');
    mkdirSync(repository);
    const isolatedHome = join(temporary, 'home');
    mkdirSync(isolatedHome);
    const environment = {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        GIT_CONFIG_GLOBAL: join(isolatedHome, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (args) => run('git', args, { cwd: repository, env: environment });
    git(['init', '-q']);
    git(['config', 'user.name', 'Package test']);
    git(['config', 'user.email', 'package-test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repository, 'README.md'), 'package smoke test\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'initial commit']);
    run(process.execPath, [installedCli, 'init', '--profile', 'strict'], { cwd: repository, env: environment });
    writeFileSync(join(repository, '.env'), 'PACKAGE_SMOKE_SECRET=must-not-land\n');
    git(['add', '-f', '.env']);
    const blocked = spawnSync('git', ['commit', '-q', '-m', 'must be blocked'], {
        cwd: repository,
        env: environment,
        encoding: 'utf8',
    });
    if (blocked.error) throw blocked.error;
    if (blocked.status === 0) throw new Error('installed strict hook allowed a forbidden path');
    git(['reset', '-q', 'HEAD', '--', '.env']);
    rmSync(join(repository, '.env'));
    writeFileSync(join(repository, 'README.md'), 'package hook smoke test\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'exercise installed hooks']);
    run(process.execPath, [installedCli, 'status'], { cwd: repository, env: environment });
    run(process.execPath, [installedCli, 'doctor'], { cwd: repository, env: environment });
    if (retainedArtifactDir) {
        const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        writeFileSync(join(temporary, 'artifact.json'), JSON.stringify({
            schema_version: 1,
            name: packageJson.name,
            version: packageJson.version,
            filename: packed.filename,
            integrity,
        }, null, 2) + '\n');
    }
} finally {
    if (!retainedArtifactDir) rmSync(temporary, { recursive: true, force: true });
}
