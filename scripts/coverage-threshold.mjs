import { readdirSync } from 'node:fs';
import {
    dirname, extname, isAbsolute, join, relative, sep,
} from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

// Per-file floors, one set per production directory. Node's own --test-coverage-lines
// and --test-coverage-functions are project totals, so a well-covered majority carries a
// bare file over them; only a per-file floor can see that file. Line and function here
// match those totals, except src function, which sits at the lowest a shipped file holds
// today. No floor is above the current tree, so each one moves the day a file stops
// being exercised as well as it is now.
export const THRESHOLDS = Object.freeze({
    src: Object.freeze({ branch: 50, line: 75, function: 75 }),
    bin: Object.freeze({ branch: 35, line: 75, function: 85 }),
});

// Branch coverage cannot stand in for the other two: V8 collapses a function that never
// runs into one uncovered range without enumerating the branches inside it, so dropping
// a function barely moves the branch number.
const METRICS = Object.freeze({
    branch: 'coveredBranchPercent',
    line: 'coveredLinePercent',
    function: 'coveredFunctionPercent',
});

function portablePath(path) {
    return path.split(sep).join('/');
}

function sourceFilesIn(root, directory, prefix = directory) {
    const found = [];
    const path = join(root, directory);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const relativePath = join(prefix, entry.name);
        if (entry.isDirectory()) {
            found.push(...sourceFilesIn(root, relativePath, relativePath));
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
            found.push(portablePath(relativePath));
        }
    }
    return found;
}

export function productionSourceFiles(root = ROOT) {
    return Object.keys(THRESHOLDS)
        .flatMap((directory) => sourceFilesIn(root, directory))
        .sort();
}

function relativeCoveragePath(root, path) {
    if (typeof path !== 'string') return null;
    const candidate = relative(root, path);
    if (!candidate || candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
        return null;
    }
    return portablePath(candidate);
}

function thresholdsFor(path) {
    const directory = path.split('/', 1)[0];
    return THRESHOLDS[directory];
}

export function evaluateCoverage(summary, {
    root = ROOT,
    expectedFiles = productionSourceFiles(root),
} = {}) {
    if (!summary || !Array.isArray(summary.files)) {
        return { coveredFiles: 0, failures: ['coverage report has no file records'] };
    }

    const failures = [];
    const covered = new Set();
    for (const file of summary.files) {
        const path = relativeCoveragePath(root, file?.path);
        const thresholds = path ? thresholdsFor(path) : undefined;
        if (thresholds === undefined) continue;
        if (covered.has(path)) {
            failures.push(`${path}: duplicate coverage record`);
            continue;
        }
        covered.add(path);
        for (const [metric, field] of Object.entries(METRICS)) {
            const percent = file[field];
            if (!Number.isFinite(percent)) {
                failures.push(`${path}: ${metric} coverage is missing`);
            } else if (percent < thresholds[metric]) {
                failures.push(
                    `${path}: ${metric} coverage ${percent.toFixed(2)}% is below ${thresholds[metric]}%`,
                );
            }
        }
    }

    for (const path of expectedFiles) {
        if (!covered.has(path)) failures.push(`${path}: no coverage record`);
    }

    return {
        coveredFiles: covered.size,
        failures: failures.sort(),
    };
}

export default async function* coverageThresholdReporter(source) {
    let sawCoverage = false;
    for await (const event of source) {
        if (event.type !== 'test:coverage') continue;
        sawCoverage = true;
        let result;
        try {
            result = evaluateCoverage(event.data?.summary);
        } catch (error) {
            result = { coveredFiles: 0, failures: [error.message] };
        }
        if (result.failures.length) {
            process.exitCode = 1;
            yield `production coverage failed:\n${result.failures.map((failure) => `- ${failure}`).join('\n')}\n`;
        } else {
            const held = Object.entries(THRESHOLDS).map(([directory, thresholds]) => (
                `${directory} ${thresholds.branch}% branch, ${thresholds.line}% line, `
                + `${thresholds.function}% function`
            )).join('; ');
            yield `production coverage passed for ${result.coveredFiles} files (${held})\n`;
        }
    }

    if (!sawCoverage) {
        process.exitCode = 1;
        yield 'production coverage failed:\n- coverage report was not emitted\n';
    }
}
