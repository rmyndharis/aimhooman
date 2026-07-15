export function normalizeGitPath(value) {
    let path = String(value || '');
    if (process.platform === 'win32') path = path.replace(/\\/g, '/');
    return path.replace(/^(?:\.\/)+/, '');
}
