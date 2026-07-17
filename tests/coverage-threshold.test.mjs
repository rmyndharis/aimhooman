import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import coverageThresholdReporter, {
    evaluateCoverage,
    productionSourceFiles,
} from '../scripts/coverage-threshold.mjs';

function record(root, path, coveredBranchPercent, coveredLinePercent = 100, coveredFunctionPercent = 100) {
    return {
        path: join(root, path), coveredBranchPercent, coveredLinePercent, coveredFunctionPercent,
    };
}

test('coverage command limits aggregate metrics to production and attaches the per-file gate', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const command = pkg.scripts['test:coverage'];
    for (const fragment of [
        '--test-coverage-include="src/**"',
        '--test-coverage-include="bin/**"',
        '--test-coverage-exclude="tests/**"',
        '--test-coverage-lines=75',
        '--test-coverage-branches=60',
        '--test-coverage-functions=85',
        '--test-reporter=./scripts/coverage-threshold.mjs',
    ]) {
        assert.ok(command.includes(fragment), `missing coverage option: ${fragment}`);
    }
});

test('production coverage checks each source file against its directory threshold', () => {
    const root = join(tmpdir(), 'coverage-root');
    const result = evaluateCoverage({
        files: [
            record(root, 'src/scan.mjs', 50),
            record(root, 'bin/aimhooman.mjs', 35),
            record(root, 'tests/scan.test.mjs', 0),
        ],
    }, {
        root,
        expectedFiles: ['bin/aimhooman.mjs', 'src/scan.mjs'],
    });

    assert.deepEqual(result, { coveredFiles: 2, failures: [] });
});

test('production coverage fails for low, missing, invalid, and duplicate file records', () => {
    const root = join(tmpdir(), 'coverage-root');
    const result = evaluateCoverage({
        files: [
            record(root, 'src/scan.mjs', 49.99),
            record(root, 'src/scan.mjs', 100),
            record(root, 'bin/aimhooman.mjs', Number.NaN),
            record(root, '../outside.mjs', 0),
        ],
    }, {
        root,
        expectedFiles: [
            'bin/aimhooman.mjs',
            'src/new-module.mjs',
            'src/scan.mjs',
        ],
    });

    assert.equal(result.coveredFiles, 2);
    assert.deepEqual(result.failures, [
        'bin/aimhooman.mjs: branch coverage is missing',
        'src/new-module.mjs: no coverage record',
        'src/scan.mjs: branch coverage 49.99% is below 50%',
        'src/scan.mjs: duplicate coverage record',
    ]);
    assert.deepEqual(evaluateCoverage(null).failures, ['coverage report has no file records']);
});

// Node's --test-coverage-lines and --test-coverage-functions are whole-project totals,
// so a well-covered majority carries a bare file over them. Only a per-file floor can
// see a function that stopped running, and branch coverage cannot stand in for one: V8
// collapses an unexecuted function into a single uncovered range without enumerating
// the branches inside it, so the branch number barely moves.
test('production coverage floors lines and functions per file, not only branches', () => {
    const root = join(tmpdir(), 'coverage-root');
    const result = evaluateCoverage({
        files: [record(root, 'src/scan.mjs', 88.24, 45.39, 55.56)],
    }, {
        root,
        expectedFiles: ['src/scan.mjs'],
    });

    assert.deepEqual(result.failures, [
        'src/scan.mjs: function coverage 55.56% is below 75%',
        'src/scan.mjs: line coverage 45.39% is below 75%',
    ]);
});

test('source discovery includes nested JavaScript files and ignores other files', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-coverage-files-'));
    try {
        mkdirSync(join(root, 'src', 'nested'), { recursive: true });
        mkdirSync(join(root, 'bin'), { recursive: true });
        writeFileSync(join(root, 'src', 'scan.mjs'), '');
        writeFileSync(join(root, 'src', 'nested', 'worker.cjs'), '');
        writeFileSync(join(root, 'src', 'notes.txt'), '');
        writeFileSync(join(root, 'bin', 'cli.js'), '');
        assert.deepEqual(productionSourceFiles(root), [
            'bin/cli.js',
            'src/nested/worker.cjs',
            'src/scan.mjs',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('coverage reporter fails when Node does not emit a coverage event', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        async function* events() {
            yield { type: 'test:pass', data: {} };
        }
        const output = [];
        for await (const chunk of coverageThresholdReporter(events())) output.push(chunk);
        assert.equal(process.exitCode, 1);
        assert.match(output.join(''), /coverage report was not emitted/);
    } finally {
        process.exitCode = previousExitCode;
    }
});
