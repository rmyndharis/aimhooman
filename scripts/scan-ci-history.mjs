#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    authorizeProtectedPathPlan,
    protectedPathAuthorizationPlan,
} from './authorize-owner-paths.mjs';
import { requiredEnvironment, verifyOwnerWorkflowRun } from './github-owner-authority.mjs';
import { selectPushBase } from '../src/history-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/aimhooman.mjs');

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
            cwd: ROOT,
        });
        if (!base) {
            console.log('aimhooman: pushed ref contains no commits outside the default branch');
            return 0;
        }
        const plan = protectedPathAuthorizationPlan(base, head);
        if (plan.paths.length) {
            const refName = requiredEnvironment('REF_NAME');
            const authority = await verifyOwnerWorkflowRun({
                expectedEvent: 'push',
                expectedHead: head,
                expectedRef: refName,
                expectedWorkflowPath: '.github/workflows/test.yml',
                requireWorkflowAtHead: true,
            });
            authorizeProtectedPathPlan(plan, authority, {
                context: `push to ${refName} at ${head}`,
                event: 'push',
                refName,
                workflowPath: '.github/workflows/test.yml',
            });
        }
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
