#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertForwardVersion, releaseChannel } from '../src/release-channel.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE = /^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/;

function npmErrorCode(result) {
    for (const value of [result?.stdout, result?.stderr]) {
        const text = String(value || '');
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed?.error?.code === 'string') return parsed.error.code;
        } catch {
            // npm may mix a human diagnostic with its JSON error object.
        }
        const match = text.match(/\b(E[A-Z0-9]+)\b/);
        if (match) return match[1];
    }
    return '';
}

function parsedJson(result, label) {
    try {
        return JSON.parse(String(result.stdout || ''));
    } catch (error) {
        throw new Error(`${label} returned invalid JSON`, { cause: error });
    }
}

async function retryView(label, load, { retries = 5, delay = wait } = {}) {
    let last;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const result = await load();
        if (result.ok) return { state: 'found', value: parsedJson(result, label) };
        const code = npmErrorCode(result);
        if (code === 'E404') return { state: 'absent', value: null };
        last = new Error(`${label} failed with ${code || `exit ${result.status ?? 'unknown'}`}`);
        if (attempt < retries) await delay(Math.min(4000, 250 * (2 ** (attempt - 1))));
    }
    throw new Error(`${label} remained unavailable after ${retries} attempts`, { cause: last });
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function resolveNpmReleaseState({
    name,
    version,
    registry,
    query = npmView,
    retries = 5,
    delay,
}) {
    if (!PACKAGE.test(name || '')) throw new TypeError('package name must be a scoped npm name');
    const channel = releaseChannel(version);
    let registryUrl;
    try { registryUrl = new URL(registry); } catch (error) {
        throw new TypeError('registry must be an absolute URL', { cause: error });
    }
    if (registryUrl.protocol !== 'https:') throw new TypeError('registry must use HTTPS');

    const options = { retries, ...(delay ? { delay } : {}) };
    const versionResult = await retryView(
        `${name}@${version}`,
        () => query([`${name}@${version}`, 'version'], registryUrl.href),
        options,
    );
    const tagsResult = await retryView(
        `${name} dist-tags`,
        () => query([name, 'dist-tags'], registryUrl.href),
        options,
    );

    if (versionResult.state === 'found' && versionResult.value !== version) {
        throw new Error(`registry returned unexpected version ${JSON.stringify(versionResult.value)}`);
    }
    if (versionResult.state === 'found' && tagsResult.state === 'absent') {
        throw new Error('registry reports the version but not its package metadata');
    }
    if (tagsResult.state === 'found'
        && (!tagsResult.value || typeof tagsResult.value !== 'object' || Array.isArray(tagsResult.value))) {
        throw new Error('registry dist-tags response must be an object');
    }

    const currentTag = tagsResult.state === 'found' ? tagsResult.value[channel] ?? null : null;
    if (currentTag !== null && typeof currentTag !== 'string') {
        throw new Error(`registry dist-tag ${channel} must be a version string`);
    }
    if (versionResult.state === 'absent' && currentTag) {
        assertForwardVersion(currentTag, version);
    }
    return {
        schema_version: 1,
        name,
        version,
        channel,
        version_state: versionResult.state === 'found' ? 'existing' : 'absent',
        package_state: tagsResult.state === 'found' ? 'existing' : 'absent',
        current_tag: currentTag,
    };
}

async function npmView(fields, registry) {
    const npm = process.env.npm_execpath;
    const command = npm ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const args = npm
        ? [npm, 'view', ...fields, '--json', '--registry', registry]
        : ['view', ...fields, '--json', '--registry', registry];
    try {
        const result = await execFileAsync(command, args, {
            encoding: 'utf8',
            env: process.env,
            maxBuffer: 4 * 1024 * 1024,
        });
        return { ok: true, status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
        return {
            ok: false,
            status: error?.code,
            stdout: error?.stdout,
            stderr: error?.stderr || error?.message,
        };
    }
}

async function main(args) {
    if (args.length !== 3) {
        throw new TypeError('usage: npm-release-state.mjs <scoped-name> <version> <registry-url>');
    }
    const result = await resolveNpmReleaseState({
        name: args[0],
        version: args[1],
        registry: args[2],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(`aimhooman: ${error.message}`);
        process.exitCode = 20;
    });
}
