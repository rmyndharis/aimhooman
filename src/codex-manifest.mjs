import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const CODEX_PLUGIN_FIELDS = new Set([
    'name', 'version', 'description', 'author', 'homepage', 'repository', 'license',
    'keywords', 'skills', 'mcpServers', 'apps', 'hooks', 'interface',
]);

export function validateCodexManifest(manifest, pluginRoot) {
    if (!plainObject(manifest)) throw new Error('Codex plugin manifest must be an object');
    for (const field of Object.keys(manifest)) {
        if (!CODEX_PLUGIN_FIELDS.has(field)) throw new Error(`unsupported Codex plugin field: ${field}`);
    }
    for (const field of ['name', 'version', 'description']) requireString(manifest[field], `plugin.${field}`);
    if (manifest.author !== undefined) {
        if (typeof manifest.author === 'string') requireString(manifest.author, 'plugin.author');
        else requireString(manifest.author?.name, 'plugin.author.name');
    }
    for (const field of ['skills', 'apps', 'mcpServers']) {
        if (manifest[field] !== undefined) validatePathValue(manifest[field], field, pluginRoot);
    }
    if (manifest.hooks !== undefined) validateHooks(manifest.hooks, pluginRoot);
    return manifest;
}

function validateHooks(value, pluginRoot) {
    if (typeof value === 'string') {
        validatePath(value, 'hooks', pluginRoot);
        return;
    }
    if (plainObject(value)) return;
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('plugin.hooks must be a path, inline object, or non-empty array');
    }
    const strings = value.every((entry) => typeof entry === 'string');
    const objects = value.every(plainObject);
    if (!strings && !objects) throw new Error('plugin.hooks array must contain only paths or only inline objects');
    if (strings) for (const path of value) validatePath(path, 'hooks', pluginRoot);
}

function validatePathValue(value, field, pluginRoot) {
    if (typeof value === 'string') return validatePath(value, field, pluginRoot);
    throw new Error(`plugin.${field} must be a relative path`);
}

function validatePath(path, field, pluginRoot) {
    requireString(path, `plugin.${field}`);
    if (!path.startsWith('./') || isAbsolute(path)) {
        throw new Error(`plugin.${field} path must start with ./: ${path}`);
    }
    const target = resolve(pluginRoot, path);
    const outside = relative(pluginRoot, target);
    if (outside === '..' || outside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(outside)) {
        throw new Error(`plugin.${field} path escapes the plugin root: ${path}`);
    }
    if (!existsSync(target)) throw new Error(`plugin.${field} path does not exist: ${path}`);
}

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
}
