#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(import.meta.dirname, '..');

function run(command, args, label) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: 'inherit',
        env: process.env,
    });
    if (result.error) {
        throw new Error(`${label} could not start: ${result.error.message}`, { cause: result.error });
    }
    if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

function compileSchemas() {
    const directory = join(root, 'schemas');
    const files = readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
    if (files.length === 0) throw new Error('no published JSON schemas found');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const ids = new Set();
    for (const file of files) {
        const schema = JSON.parse(readFileSync(join(directory, file), 'utf8'));
        if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
            throw new Error(`${file} must declare JSON Schema draft 2020-12`);
        }
        if (typeof schema.$id !== 'string' || !schema.$id) throw new Error(`${file} has no $id`);
        if (ids.has(schema.$id)) throw new Error(`duplicate schema $id: ${schema.$id}`);
        ids.add(schema.$id);
        ajv.compile(schema);
    }
    return files.length;
}

const schemas = compileSchemas();
run(process.execPath, [
    join(root, 'node_modules', 'knip', 'bin', 'knip.js'),
    '--include',
    'files,exports,dependencies,unlisted,unresolved',
], 'dead-code check');
run('go', [
    'run',
    'github.com/rhysd/actionlint/cmd/actionlint@914e7df21a07ef503a81201c76d2b11c789d3fca',
], 'workflow lint');
console.log(`compiled ${schemas} schemas; workflow and dead-code checks passed`);
