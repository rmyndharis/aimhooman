#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function assertProtectedReleaseEnvironment(environment) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
        throw new Error('release environment response must be an object');
    }
    if (environment.can_admins_bypass !== false) {
        throw new Error('release environment must disable administrator bypass');
    }
    if (!Array.isArray(environment.protection_rules)) {
        throw new Error('release environment has no protection rule list');
    }
    const reviewerRule = environment.protection_rules.find((rule) => (
        rule?.type === 'required_reviewers'
        && Array.isArray(rule.reviewers)
        && rule.reviewers.length > 0
    ));
    if (!reviewerRule) {
        throw new Error('release environment must require at least one reviewer');
    }
    if (reviewerRule.prevent_self_review !== true) {
        throw new Error('release environment must prevent self-review');
    }
    for (const entry of reviewerRule.reviewers) {
        const type = entry?.type;
        if (type === 'User' && typeof entry?.reviewer?.login === 'string' && entry.reviewer.login) continue;
        if (type === 'Team') {
            throw new Error(
                'team release reviewers cannot be authority-checked with the repository-scoped workflow token; configure a direct user reviewer',
            );
        }
        throw new Error('release environment contains an invalid direct user reviewer');
    }
    return reviewerRule.reviewers;
}

function requiredEnvironment(env, name) {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

export async function verifyReleaseEnvironment({ env = process.env, fetchImpl = fetch } = {}) {
    const repository = requiredEnvironment(env, 'GITHUB_REPOSITORY');
    const token = requiredEnvironment(env, 'GITHUB_TOKEN');
    const output = requiredEnvironment(env, 'GITHUB_OUTPUT');
    const parts = repository.split('/');
    if (parts.length !== 2
        || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
        throw new Error('GITHUB_REPOSITORY must be an owner/name pair');
    }
    const [owner, name] = parts.map(encodeURIComponent);
    const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'aimhooman-release-gate',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${name}/environments/release`,
        { headers },
    );
    if (!response.ok) {
        throw new Error(`cannot inspect release environment: GitHub returned ${response.status}`);
    }
    const reviewers = assertProtectedReleaseEnvironment(await response.json());
    const publisherVariable = await fetchImpl(
        `https://api.github.com/repos/${owner}/${name}/environments/release/variables/NPM_EXCLUSIVE_PUBLISHER`,
        { headers },
    );
    if (!publisherVariable.ok) {
        throw new Error(
            `cannot verify the environment-scoped NPM_EXCLUSIVE_PUBLISHER invariant: GitHub returned ${publisherVariable.status}`,
        );
    }
    const publisher = await publisherVariable.json();
    if (publisher?.name !== 'NPM_EXCLUSIVE_PUBLISHER' || publisher?.value !== 'true') {
        throw new Error(
            'release environment variable NPM_EXCLUSIVE_PUBLISHER must be true after confirming this workflow is the package channel\'s only authorized publisher',
        );
    }
    for (const entry of reviewers) {
        const target = `repos/${owner}/${name}/collaborators/${encodeURIComponent(entry.reviewer.login)}/permission`;
        const permissionResponse = await fetchImpl(`https://api.github.com/${target}`, { headers });
        if (!permissionResponse.ok) {
            throw new Error(`cannot verify release reviewer authority: GitHub returned ${permissionResponse.status}`);
        }
        const authority = await permissionResponse.json();
        const permission = String(authority?.permission || '');
        const permissions = authority?.permissions || authority?.user?.permissions || {};
        const canWrite = ['admin', 'maintain', 'write', 'push'].includes(permission)
            || permissions.admin === true
            || permissions.maintain === true
            || permissions.push === true;
        if (!canWrite) {
            throw new Error(`release reviewer ${entry.reviewer.login} lacks write permission`);
        }
    }
    appendFileSync(output, 'protected=true\n');
    return reviewers.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    verifyReleaseEnvironment().then((reviewers) => {
        console.log(`aimhooman: release environment requires ${reviewers} reviewer(s) and disables admin bypass`);
    }).catch((error) => {
        console.error(`aimhooman: ${error.message}`);
        process.exitCode = 20;
    });
}
