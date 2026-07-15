import { readdirSync } from 'node:fs';
import {
    dirname, extname, isAbsolute, join, relative, sep,
} from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

export const BRANCH_THRESHOLDS = Object.freeze({
    src: 50,
    bin: 35,
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
    return Object.keys(BRANCH_THRESHOLDS)
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

function branchThreshold(path) {
    const directory = path.split('/', 1)[0];
    return BRANCH_THRESHOLDS[directory];
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
        const threshold = path ? branchThreshold(path) : undefined;
        if (threshold === undefined) continue;
        if (covered.has(path)) {
            failures.push(`${path}: duplicate coverage record`);
            continue;
        }
        covered.add(path);
        if (!Number.isFinite(file.coveredBranchPercent)) {
            failures.push(`${path}: branch coverage is missing`);
        } else if (file.coveredBranchPercent < threshold) {
            failures.push(
                `${path}: branch coverage ${file.coveredBranchPercent.toFixed(2)}% is below ${threshold}%`,
            );
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
            yield `production coverage passed for ${result.coveredFiles} files `
                + `(src ${BRANCH_THRESHOLDS.src}% branch, bin ${BRANCH_THRESHOLDS.bin}% branch)\n`;
        }
    }

    if (!sawCoverage) {
        process.exitCode = 1;
        yield 'production coverage failed:\n- coverage report was not emitted\n';
    }
}
