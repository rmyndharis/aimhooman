import test from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentError, parseArguments } from '../src/args.mjs';

const definition = {
    options: {
        json: { names: ['--json'], type: 'boolean' },
        profile: { names: ['--profile'], type: 'string', choices: ['clean', 'strict', 'compliance'] },
        message: { names: ['--message', '-m'], type: 'string' },
    },
    maxPositionals: 1,
};

test('argument parser accepts named values and a positional target', () => {
    assert.deepEqual(parseArguments(['--json', '--profile=strict', '-m', 'MSG', 'path'], definition), {
        options: { json: true, profile: 'strict', message: 'MSG' },
        positionals: ['path'],
    });
});

test('argument parser rejects unknown, repeated, missing, and conflicting options', () => {
    assert.throws(() => parseArguments(['--jsoon'], definition), ArgumentError);
    assert.throws(() => parseArguments(['--json', '--json'], definition), /only be used once/);
    assert.throws(() => parseArguments(['--profile'], definition), /missing value/);
    assert.throws(() => parseArguments(['--profile', 'weak'], definition), /invalid value/);
    assert.throws(() => parseArguments(['one', 'two'], definition), /unexpected argument/);
    assert.throws(() => parseArguments(['--json', '--profile', '--json'], definition), /missing value/);
});
