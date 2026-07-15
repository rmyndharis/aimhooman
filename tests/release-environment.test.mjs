import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    assertProtectedReleaseEnvironment,
    verifyReleaseEnvironment,
} from '../scripts/verify-release-environment.mjs';

const protectedEnvironment = {
    can_admins_bypass: false,
    protection_rules: [{
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [{ type: 'User', reviewer: { login: 'maintainer' } }],
    }],
};

test('release environment requires an identified reviewer, prevents self-review, and disables bypass', () => {
    assert.equal(assertProtectedReleaseEnvironment(protectedEnvironment).length, 1);
    assert.throws(
        () => assertProtectedReleaseEnvironment({ ...protectedEnvironment, can_admins_bypass: true }),
        /disable administrator bypass/,
    );
    assert.throws(
        () => assertProtectedReleaseEnvironment({ can_admins_bypass: false, protection_rules: [] }),
        /require at least one reviewer/,
    );
    assert.throws(
        () => assertProtectedReleaseEnvironment({
            ...protectedEnvironment,
            protection_rules: [{ ...protectedEnvironment.protection_rules[0], prevent_self_review: false }],
        }),
        /prevent self-review/,
    );
});

test('release environment check writes its protected output only after verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-release-environment-'));
    const output = join(root, 'github-output');
    const requests = [];
    try {
        const reviewers = await verifyReleaseEnvironment({
            env: {
                GITHUB_REPOSITORY: 'owner/repository',
                GITHUB_TOKEN: 'test-token',
                GITHUB_OUTPUT: output,
            },
            fetchImpl: async (url, options) => {
                requests.push({ url, options });
                if (url.endsWith('/environments/release')) {
                    return { ok: true, json: async () => protectedEnvironment };
                }
                if (url.endsWith('/variables/NPM_EXCLUSIVE_PUBLISHER')) {
                    return {
                        ok: true,
                        json: async () => ({ name: 'NPM_EXCLUSIVE_PUBLISHER', value: 'true' }),
                    };
                }
                return { ok: true, json: async () => ({ permission: 'write' }) };
            },
        });
        assert.equal(reviewers, 1);
        assert.equal(readFileSync(output, 'utf8'), 'protected=true\n');
        assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repository/environments/release');
        assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
        assert.equal(
            requests[1].url,
            'https://api.github.com/repos/owner/repository/environments/release/variables/NPM_EXCLUSIVE_PUBLISHER',
        );
        assert.equal(
            requests[2].url,
            'https://api.github.com/repos/owner/repository/collaborators/maintainer/permission',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('every eligible release reviewer must have repository write authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-release-reviewer-authority-'));
    const output = join(root, 'github-output');
    try {
        await assert.rejects(
            verifyReleaseEnvironment({
                env: {
                    GITHUB_REPOSITORY: 'owner/repository',
                    GITHUB_TOKEN: 'test-token',
                    GITHUB_OUTPUT: output,
                },
                fetchImpl: async (url) => {
                    if (url.endsWith('/environments/release')) {
                        return { ok: true, json: async () => protectedEnvironment };
                    }
                    if (url.endsWith('/variables/NPM_EXCLUSIVE_PUBLISHER')) {
                        return {
                            ok: true,
                            json: async () => ({ name: 'NPM_EXCLUSIVE_PUBLISHER', value: 'true' }),
                        };
                    }
                    return { ok: true, json: async () => ({ permission: 'read' }) };
                },
            }),
            /lacks write permission/,
        );
        assert.equal(existsSync(output), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('team release reviewers fail closed under the repository-scoped workflow token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-release-team-authority-'));
    const output = join(root, 'github-output');
    const environment = {
        ...protectedEnvironment,
        protection_rules: [{
            type: 'required_reviewers',
            prevent_self_review: true,
            reviewers: [{ type: 'Team', reviewer: { slug: 'release-maintainers' } }],
        }],
    };
    try {
        await assert.rejects(
            verifyReleaseEnvironment({
                env: {
                    GITHUB_REPOSITORY: 'organization/repository',
                    GITHUB_TOKEN: 'test-token',
                    GITHUB_OUTPUT: output,
                },
                fetchImpl: async (url) => {
                    if (url.endsWith('/environments/release')) {
                        return { ok: true, json: async () => environment };
                    }
                    throw new Error('team authority endpoint must not be queried');
                },
            }),
            /team release reviewers.*direct user reviewer/,
        );
        assert.equal(existsSync(output), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('release environment check fails closed without creating an output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-release-environment-failure-'));
    const output = join(root, 'github-output');
    let requests = 0;
    try {
        await assert.rejects(
            verifyReleaseEnvironment({
                env: {
                    GITHUB_REPOSITORY: 'owner/repository',
                    GITHUB_TOKEN: 'test-token',
                    GITHUB_OUTPUT: output,
                },
                fetchImpl: async (url) => {
                    requests += 1;
                    if (url.endsWith('/environments/release')) {
                        return { ok: true, json: async () => protectedEnvironment };
                    }
                    return { ok: false, status: 404 };
                },
            }),
            /environment-scoped NPM_EXCLUSIVE_PUBLISHER.*404/,
        );
        assert.equal(requests, 2);

        requests = 0;
        await assert.rejects(
            verifyReleaseEnvironment({
                env: {
                    GITHUB_REPOSITORY: '../invalid',
                    GITHUB_TOKEN: 'test-token',
                    GITHUB_OUTPUT: output,
                },
                fetchImpl: async () => { requests += 1; },
            }),
            /owner\/name pair/,
        );
        assert.equal(requests, 0);

        requests = 0;
        await assert.rejects(
            verifyReleaseEnvironment({
                env: {
                    GITHUB_REPOSITORY: 'owner/repository',
                    GITHUB_TOKEN: 'test-token',
                    GITHUB_OUTPUT: output,
                },
                fetchImpl: async () => {
                    requests += 1;
                    return { ok: false, status: 403 };
                },
            }),
            /GitHub returned 403/,
        );
        assert.equal(requests, 1);
        assert.equal(existsSync(output), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('release environment rejects an unconfirmed exclusive-publisher invariant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-release-publisher-invariant-'));
    const output = join(root, 'github-output');
    try {
        await assert.rejects(
            verifyReleaseEnvironment({
                env: {
                    GITHUB_REPOSITORY: 'owner/repository',
                    GITHUB_TOKEN: 'test-token',
                    GITHUB_OUTPUT: output,
                },
                fetchImpl: async (url) => {
                    if (url.endsWith('/environments/release')) {
                        return { ok: true, json: async () => protectedEnvironment };
                    }
                    if (url.endsWith('/variables/NPM_EXCLUSIVE_PUBLISHER')) {
                        return {
                            ok: true,
                            json: async () => ({ name: 'NPM_EXCLUSIVE_PUBLISHER', value: 'false' }),
                        };
                    }
                    throw new Error('reviewer authority must not be queried');
                },
            }),
            /must be true.*only authorized publisher/,
        );
        assert.equal(existsSync(output), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
