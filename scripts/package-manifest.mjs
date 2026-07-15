import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function filesBelow(directory, prefix) {
    const paths = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) paths.push(...filesBelow(join(directory, entry.name), relative));
        else paths.push(relative);
    }
    return paths;
}

export function assertPackageManifest(paths, sourceRoot) {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !path)) {
        throw new TypeError('package manifest paths must be non-empty strings');
    }
    const allowedFiles = new Set([
        'package.json', 'docs/hosts.json',
        '.github/copilot-instructions.md', 'AGENTS.md', 'GEMINI.md', 'CHANGELOG.md',
        'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md',
    ]);
    const allowedPrefixes = [
        'bin/', 'src/', 'rules/', 'hooks/', 'schemas/', 'docs/design/', 'docs/logo/',
        '.claude-plugin/', '.codex-plugin/', '.cursor/', '.clinerules/', '.windsurf/',
        '.kiro/', '.agents/', '.gemini/', '.github/hooks/', 'skills/',
    ];
    const adapterPrefixes = [
        'hooks/', 'skills/', '.claude-plugin/', '.codex-plugin/', '.cursor/',
        '.clinerules/', '.windsurf/', '.kiro/', '.agents/', '.gemini/',
        '.github/hooks/',
    ];
    for (const path of paths) {
        if (path.startsWith('/') || path.includes('\\')
            || path.split('/').some((part) => part === '.' || part === '..')
            || /[\u0000-\u001f\u007f]/.test(path)) {
            throw new Error(`packed artifact has an unsafe path: ${path}`);
        }
        if (/^docs\/reviews\//i.test(path)) throw new Error('internal review documents must not be included in the package');
        if (!allowedFiles.has(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
            throw new Error(`packed artifact has an unexpected path: ${path}`);
        }
        if (/(^|\/)\.env(?:\.|$)/i.test(path)
            && !/\.env\.(?:example|sample|template|dist|defaults)$/i.test(path)) {
            throw new Error(`packed artifact contains a secret-prone environment file: ${path}`);
        }
        if (/(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|service-account(?:-key)?\.json)$/i.test(path)
            || /\.(?:p12|pfx)$/i.test(path)) {
            throw new Error(`packed artifact contains a secret-prone credential path: ${path}`);
        }
        if (/\.pem$/i.test(path)) {
            let content;
            try {
                content = readFileSync(join(sourceRoot, path));
            } catch (error) {
                throw new Error(
                    `packed artifact contains a secret-prone credential path that cannot be inspected: ${path}`,
                    { cause: error },
                );
            }
            if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/.test(content.toString('latin1'))) {
                throw new Error(`packed artifact contains private-key content: ${path}`);
            }
        }
        if (/(^|\/)(?:\.claude\.json|\.claude\/session[^/]*\.json|\.codex\/(?:sessions\/|history)|\.copilot\/|\.cursor\/session|\.aider\.|\.specstory\/|\.continue\/sessions\/|\.playwright-mcp\/|\.remember\/|\.superpowers\/|\.agent\/)/i.test(path)) {
            throw new Error(`packed artifact contains local AI state: ${path}`);
        }
    }
    for (const directory of ['bin', 'src', 'rules', 'hooks', 'schemas', 'docs/design']) {
        for (const required of filesBelow(join(sourceRoot, directory), directory)) {
            if (!paths.includes(required)) throw new Error(`packed artifact is missing ${required}`);
        }
    }
    const registryPath = join(sourceRoot, 'docs', 'hosts.json');
    let registry;
    try {
        registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read host registry: ${error.message}`, { cause: error });
    }
    if (registry?.schema_version !== 1 || !Array.isArray(registry.hosts)) {
        throw new Error('host registry must use schema_version 1 and contain hosts');
    }
    const hostFiles = new Set(['docs/hosts.json']);
    for (const host of registry.hosts) {
        if (!host?.id || !Array.isArray(host.files) || !host.files.length) {
            throw new Error('every host registry entry must name at least one file');
        }
        for (const file of host.files) hostFiles.add(file);
        if (host.canonical_copy) hostFiles.add(host.canonical_copy);
    }
    for (const required of [...hostFiles].sort()) {
        if (!paths.includes(required)) {
            throw new Error(`packed artifact is missing host adapter ${required}`);
        }
    }
    for (const path of paths) {
        if (adapterPrefixes.some((prefix) => path.startsWith(prefix)) && !hostFiles.has(path)) {
            throw new Error(`packed artifact contains an unregistered host adapter: ${path}`);
        }
    }
}
