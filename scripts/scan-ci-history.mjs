#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    acknowledgeProtectedReleasePaths,
    acknowledgePushReviewPlan,
    pushReviewPlan,
} from './acknowledge-reviewed-paths.mjs';
import { EMPTY_HISTORY_OID, resolveCommit } from '../src/history-scan.mjs';
import { gitEnvironment } from '../src/git-environment.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/aimhooman.mjs');

export function selectPushBase({ before, head, refName, defaultBranch, cwd = ROOT }) {
    const repo = { root: cwd };
    const resolvedHead = resolveCommit(repo, head);
    if (!isZeroObjectId(before)) {
        try {
            return resolveCommit(repo, before);
        } catch {
            // A force-push can replace the ref with an unrelated root while the
            // event's `before` object is no longer fetchable. Scanning from the
            // empty-history sentinel covers every commit reachable from the new
            // head instead of trusting an unavailable boundary.
            return zeroObjectId(resolvedHead);
        }
    }

    if (refName && defaultBranch && refName !== defaultBranch) {
        try {
            const defaultHead = resolveCommit(repo, `refs/remotes/origin/${defaultBranch}`);
            const common = gitString(cwd, ['merge-base', defaultHead, resolvedHead]);
            return common === resolvedHead ? null : common;
        } catch {
            // An orphan branch has no common commit. Its root history must be scanned.
        }
    }
    return zeroObjectId(resolvedHead);
}

export function selectReleaseBase({ head, cwd = ROOT }) {
    const repo = { root: cwd };
    const resolvedHead = resolveCommit(repo, head);
    // A reachable v* tag can be created by any actor with tag permission. Until
    // the workflow has durable, verified checkpoint evidence, scan every commit.
    return zeroObjectId(resolvedHead);
}

function gitString(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        env: gitEnvironment(),
        encoding: 'utf8',
    }).trim();
}

function isZeroObjectId(value) {
    return typeof value === 'string' && /^(?:0{40}|0{64})$/.test(value);
}

function zeroObjectId(head) {
    return head.length === 64 ? '0'.repeat(64) : EMPTY_HISTORY_OID;
}

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

async function main() {
    const context = requiredEnvironment('CI_HISTORY_CONTEXT');
    const head = requiredEnvironment('HEAD_SHA');
    let base;

    if (context === 'push') {
        base = selectPushBase({
            before: requiredEnvironment('BASE_SHA'),
            head,
            refName: process.env.REF_NAME || '',
            defaultBranch: process.env.DEFAULT_BRANCH || '',
        });
        if (!base) {
            console.log('aimhooman: pushed ref contains no commits outside the default branch');
            return 0;
        }
        const plan = pushReviewPlan(base, head);
        if (plan.paths.length) {
            await acknowledgePushReviewPlan(plan, {
                repository: requiredEnvironment('GITHUB_REPOSITORY'),
                token: requiredEnvironment('GITHUB_TOKEN'),
                refName: requiredEnvironment('REF_NAME'),
                defaultBranch: requiredEnvironment('DEFAULT_BRANCH'),
            });
        }
    } else if (context === 'release') {
        const tag = requiredEnvironment('CURRENT_TAG');
        if (process.env.PROTECTED_RELEASE_REVIEW !== 'true') {
            throw new Error('release history scan requires the protected release review gate');
        }
        base = selectReleaseBase({ head });
        acknowledgeProtectedReleasePaths(base, head, tag);
    } else {
        throw new Error(`unsupported CI_HISTORY_CONTEXT "${context}"`);
    }

    const range = `${base}...${head}`;
    const scan = spawnSync(process.execPath, [
        CLI, 'check', '--range', range, '--profile', 'strict', '--json',
    ], {
        cwd: ROOT,
        stdio: 'inherit',
    });
    if (scan.error) throw scan.error;
    return scan.status ?? 30;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then((status) => {
        process.exitCode = status;
    }).catch((error) => {
        console.error(`aimhooman: ${error.message}`);
        process.exitCode = 20;
    });
}
