import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AIMHOOMAN_REPOSITORY_AUTHORITY,
    assertOwnerWorkflowRun,
    parseGitHubRepository,
    verifyOwnerWorkflowRun,
    workflowPathFromRef,
} from '../scripts/github-owner-authority.mjs';

const AUTHORITY = AIMHOOMAN_REPOSITORY_AUTHORITY;
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const RUN_ID = 9123456789;
const RUN_ATTEMPT = 2;
const EVENT = 'push';
const REF_NAME = 'topic@owner';
const WORKFLOW_PATH = '.github/workflows/test.yml';

test('repository parsing and workflow refs preserve @ inside the Git ref', () => {
    assert.deepEqual(parseGitHubRepository(AUTHORITY.fullName), {
        owner: AUTHORITY.ownerLogin,
        name: 'aimhooman',
        fullName: AUTHORITY.fullName,
        apiPath: AUTHORITY.fullName,
    });
    assert.equal(
        workflowPathFromRef(
            AUTHORITY.fullName,
            `${AUTHORITY.fullName}/${WORKFLOW_PATH}@refs/heads/${REF_NAME}`,
        ),
        WORKFLOW_PATH,
    );
    assert.throws(
        () => workflowPathFromRef(
            AUTHORITY.fullName,
            `${AUTHORITY.fullName}/README.md@refs/heads/${REF_NAME}`,
        ),
        /does not identify a workflow file/,
    );
});

test('attempt 2 is accepted only through its exact API endpoint and pinned identities', async () => {
    const fixture = ownerFixture();
    const requests = [];
    const verified = await verifyOwnerWorkflowRun({
        env: fixture.env,
        expectedEvent: EVENT,
        expectedHead: HEAD,
        expectedRef: REF_NAME,
        expectedWorkflowPath: WORKFLOW_PATH,
        requireWorkflowAtHead: true,
        fetchImpl: fixture.fetch(requests),
    });

    assert.deepEqual(verified, {
        ownerLogin: AUTHORITY.ownerLogin,
        ownerId: AUTHORITY.ownerId,
        repositoryId: AUTHORITY.repositoryId,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        event: EVENT,
        headSha: HEAD,
        refName: REF_NAME,
        workflowPath: WORKFLOW_PATH,
    });
    assert.equal(Object.isFrozen(verified), true);
    assert.deepEqual(requests.map(({ url }) => url), [
        repositoryUrl(),
        permissionUrl(),
        runAttemptUrl(RUN_ID, RUN_ATTEMPT),
    ]);
    for (const { options } of requests) {
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    }
});

test('local actor, repository, event, workflow path, and workflow SHA drift fail before API reads', async (t) => {
    const cases = [
        ['repository name', 'GITHUB_REPOSITORY', 'rmyndharis/different', /repository name/],
        ['actor login', 'GITHUB_ACTOR', 'different', /GITHUB_ACTOR/],
        ['triggering actor login', 'GITHUB_TRIGGERING_ACTOR', 'different', /GITHUB_TRIGGERING_ACTOR/],
        ['repository ID', 'GITHUB_REPOSITORY_ID', String(AUTHORITY.repositoryId + 1), /GITHUB_REPOSITORY_ID/],
        ['owner ID', 'GITHUB_REPOSITORY_OWNER_ID', String(AUTHORITY.ownerId + 1), /GITHUB_REPOSITORY_OWNER_ID/],
        ['actor ID', 'GITHUB_ACTOR_ID', String(AUTHORITY.ownerId + 1), /GITHUB_ACTOR_ID/],
        ['event', 'GITHUB_EVENT_NAME', 'pull_request', /GITHUB_EVENT_NAME/],
        [
            'workflow path',
            'GITHUB_WORKFLOW_REF',
            `${AUTHORITY.fullName}/.github/workflows/release.yml@refs/heads/${REF_NAME}`,
            /GITHUB_WORKFLOW_REF path/,
        ],
        ['workflow SHA', 'GITHUB_WORKFLOW_SHA', OTHER_HEAD, /GITHUB_WORKFLOW_SHA/],
    ];

    for (const [name, key, value, message] of cases) {
        await t.test(name, async () => {
            const fixture = ownerFixture();
            fixture.env[key] = value;
            let reads = 0;
            await assert.rejects(
                verifyOwnerWorkflowRun({
                    env: fixture.env,
                    expectedEvent: EVENT,
                    expectedHead: HEAD,
                    expectedRef: REF_NAME,
                    expectedWorkflowPath: WORKFLOW_PATH,
                    requireWorkflowAtHead: true,
                    fetchImpl: async () => {
                        reads += 1;
                        throw new Error('remote API must not be read');
                    },
                }),
                message,
            );
            assert.equal(reads, 0);
        });
    }
});

test('repository and exact admin permission responses are pinned to owner login and ID', async (t) => {
    const cases = [
        ['repository ID', (fixture) => { fixture.repository.id += 1; }, /repository ID/],
        ['repository name', (fixture) => { fixture.repository.full_name = 'rmyndharis/other'; }, /repository full name/],
        ['repository owner ID', (fixture) => { fixture.repository.owner.id += 1; }, /repository owner ID/],
        ['repository owner login', (fixture) => { fixture.repository.owner.login = 'other'; }, /repository owner login/],
        ['organization owner type', (fixture) => { fixture.repository.owner.type = 'Organization'; }, /repository owner type/],
        ['write is not admin', (fixture) => { fixture.permission.permission = 'write'; }, /repository owner permission/],
        ['permission user ID', (fixture) => { fixture.permission.user.id += 1; }, /repository permission user ID/],
        ['permission user login', (fixture) => { fixture.permission.user.login = 'other'; }, /repository permission user login/],
        ['permission user type', (fixture) => { fixture.permission.user.type = 'Bot'; }, /repository permission user type/],
    ];

    for (const [name, mutate, message] of cases) {
        await t.test(name, async () => {
            const fixture = ownerFixture();
            mutate(fixture);
            await assert.rejects(
                verifyFixture(fixture),
                message,
            );
        });
    }
});

test('workflow run attempt is exact for run, attempt, event, head, ref, path, and repository', async (t) => {
    const cases = [
        ['run ID', (run) => { run.id += 1; }, /workflow run ID/],
        ['attempt', (run) => { run.run_attempt += 1; }, /workflow run attempt number/],
        ['event', (run) => { run.event = 'pull_request'; }, /workflow run event/],
        ['head SHA', (run) => { run.head_sha = OTHER_HEAD; }, /workflow run head SHA/],
        ['ref', (run) => { run.head_branch = 'different'; }, /workflow run ref name/],
        ['path', (run) => { run.path = '.github/workflows/release.yml'; }, /workflow path/],
        ['repository ID', (run) => { run.repository.id += 1; }, /workflow repository ID/],
        ['repository name', (run) => { run.repository.full_name = 'rmyndharis/other'; }, /workflow repository name/],
        ['owner ID', (run) => { run.repository.owner.id += 1; }, /workflow repository owner ID/],
        ['owner login', (run) => { run.repository.owner.login = 'other'; }, /workflow repository owner login/],
        ['owner type', (run) => { run.repository.owner.type = 'Organization'; }, /workflow repository owner type/],
        ['head repository ID', (run) => { run.head_repository.id += 1; }, /workflow head repository ID/],
        ['head repository name', (run) => { run.head_repository.full_name = 'fork/aimhooman'; }, /workflow head repository name/],
    ];

    for (const [name, mutate, message] of cases) {
        await t.test(name, async () => {
            const fixture = ownerFixture();
            mutate(fixture.run);
            await assert.rejects(verifyFixture(fixture), message);
        });
    }
});

test('workflow actor and triggering actor each require the pinned owner login, ID, and User type', async (t) => {
    for (const field of ['actor', 'triggering_actor']) {
        for (const [property, value] of [
            ['id', AUTHORITY.ownerId + 1],
            ['login', 'different'],
            ['type', 'Bot'],
        ]) {
            await t.test(`${field} ${property}`, async () => {
                const fixture = ownerFixture();
                fixture.run[field][property] = value;
                await assert.rejects(
                    verifyFixture(fixture),
                    new RegExp(`workflow ${field === 'actor' ? 'actor' : 'triggering actor'} .*${property === 'id' ? 'ID' : property}`),
                );
            });
        }
    }
});

test('run ID and attempt environment values select an exact endpoint and must match its payload', async (t) => {
    for (const [name, key, value, expectedUrl, message] of [
        ['run', 'GITHUB_RUN_ID', String(RUN_ID + 1), runAttemptUrl(RUN_ID + 1, RUN_ATTEMPT), /workflow run ID/],
        ['attempt', 'GITHUB_RUN_ATTEMPT', '3', runAttemptUrl(RUN_ID, 3), /workflow run attempt number/],
    ]) {
        await t.test(name, async () => {
            const fixture = ownerFixture();
            fixture.env[key] = value;
            const requested = [];
            await assert.rejects(
                verifyOwnerWorkflowRun({
                    env: fixture.env,
                    expectedEvent: EVENT,
                    expectedHead: HEAD,
                    expectedRef: REF_NAME,
                    expectedWorkflowPath: WORKFLOW_PATH,
                    requireWorkflowAtHead: true,
                    fetchImpl: fixture.fetch(requested, { runUrl: expectedUrl }),
                }),
                message,
            );
            assert.equal(requested.some(({ url }) => url === expectedUrl), true);
        });
    }
});

test('assertOwnerWorkflowRun rejects malformed nested run evidence', () => {
    const fixture = ownerFixture();
    const expected = expectedRun();
    assert.throws(
        () => assertOwnerWorkflowRun([], expected),
        /workflow run attempt must be an object/,
    );
    for (const [name, mutate, message] of [
        ['repository', (run) => { run.repository = []; }, /workflow run repository must be an object/],
        ['owner', (run) => { run.repository.owner = null; }, /workflow run repository owner must be an object/],
        ['head repository', (run) => { run.head_repository = 'fork'; }, /workflow run head repository must be an object/],
        ['actor', (run) => { run.actor = null; }, /workflow run actor must be an object/],
        ['triggering actor', (run) => { run.triggering_actor = []; }, /workflow run triggering actor must be an object/],
    ]) {
        const run = structuredClone(fixture.run);
        mutate(run);
        assert.throws(() => assertOwnerWorkflowRun(run, expected), message, name);
    }
});

test('403 and malformed GitHub responses fail closed at repository, permission, and run APIs', async (t) => {
    for (const endpoint of ['repository', 'permission', 'run']) {
        await t.test(`${endpoint} 403`, async () => {
            const fixture = ownerFixture();
            await assert.rejects(
                verifyFixture(fixture, { failure: endpoint, status: 403 }),
                /GitHub returned 403/,
            );
        });
    }

    for (const [name, mutate, message] of [
        ['repository body', (fixture) => { fixture.repository = []; }, /repository authority must be an object/],
        ['repository owner', (fixture) => { fixture.repository.owner = []; }, /repository owner must be an object/],
        ['permission body', (fixture) => { fixture.permission = []; }, /repository owner permission must be an object/],
        ['permission user', (fixture) => { fixture.permission.user = null; }, /repository permission user must be an object/],
        ['run body', (fixture) => { fixture.run = []; }, /workflow run attempt must be an object/],
    ]) {
        await t.test(`malformed ${name}`, async () => {
            const fixture = ownerFixture();
            mutate(fixture);
            await assert.rejects(verifyFixture(fixture), message);
        });
    }
});

function ownerFixture() {
    const repository = {
        id: AUTHORITY.repositoryId,
        full_name: AUTHORITY.fullName,
        owner: ownerIdentity(),
    };
    const permission = {
        permission: 'admin',
        user: ownerIdentity(),
    };
    const run = {
        id: RUN_ID,
        run_attempt: RUN_ATTEMPT,
        event: EVENT,
        head_sha: HEAD,
        head_branch: REF_NAME,
        path: WORKFLOW_PATH,
        repository: structuredClone(repository),
        head_repository: {
            id: AUTHORITY.repositoryId,
            full_name: AUTHORITY.fullName,
        },
        actor: ownerIdentity(),
        triggering_actor: ownerIdentity(),
    };
    const env = {
        GITHUB_REPOSITORY: AUTHORITY.fullName,
        GITHUB_TOKEN: 'test-token',
        GITHUB_ACTOR: AUTHORITY.ownerLogin,
        GITHUB_TRIGGERING_ACTOR: AUTHORITY.ownerLogin,
        GITHUB_REPOSITORY_ID: String(AUTHORITY.repositoryId),
        GITHUB_REPOSITORY_OWNER_ID: String(AUTHORITY.ownerId),
        GITHUB_ACTOR_ID: String(AUTHORITY.ownerId),
        GITHUB_EVENT_NAME: EVENT,
        GITHUB_WORKFLOW_REF: `${AUTHORITY.fullName}/${WORKFLOW_PATH}@refs/heads/${REF_NAME}`,
        GITHUB_WORKFLOW_SHA: HEAD,
        GITHUB_RUN_ID: String(RUN_ID),
        GITHUB_RUN_ATTEMPT: String(RUN_ATTEMPT),
    };
    return {
        env,
        repository,
        permission,
        run,
        fetch(requests = [], { runUrl = runAttemptUrl(RUN_ID, RUN_ATTEMPT) } = {}) {
            return async (url, options) => {
                requests.push({ url, options });
                if (url === repositoryUrl()) return response(this.repository);
                if (url === permissionUrl()) return response(this.permission);
                if (url === runUrl) return response(this.run);
                return response({}, { ok: false, status: 404 });
            };
        },
    };
}

function verifyFixture(fixture, { failure = '', status = 403 } = {}) {
    const fetchImpl = async (url) => {
        if (failure === 'repository' && url === repositoryUrl()) {
            return response({}, { ok: false, status });
        }
        if (url === repositoryUrl()) return response(fixture.repository);
        if (failure === 'permission' && url === permissionUrl()) {
            return response({}, { ok: false, status });
        }
        if (failure === 'run' && url === runAttemptUrl(RUN_ID, RUN_ATTEMPT)) {
            return response({}, { ok: false, status });
        }
        if (url === permissionUrl()) return response(fixture.permission);
        if (url === runAttemptUrl(RUN_ID, RUN_ATTEMPT)) return response(fixture.run);
        return response({}, { ok: false, status: 404 });
    };
    return verifyOwnerWorkflowRun({
        env: fixture.env,
        expectedEvent: EVENT,
        expectedHead: HEAD,
        expectedRef: REF_NAME,
        expectedWorkflowPath: WORKFLOW_PATH,
        requireWorkflowAtHead: true,
        fetchImpl,
    });
}

function expectedRun() {
    return {
        ...AUTHORITY,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        event: EVENT,
        headSha: HEAD,
        refName: REF_NAME,
        workflowPath: WORKFLOW_PATH,
    };
}

function ownerIdentity() {
    return {
        id: AUTHORITY.ownerId,
        login: AUTHORITY.ownerLogin,
        type: 'User',
    };
}

function repositoryUrl() {
    return `https://api.github.com/repos/${AUTHORITY.fullName}`;
}

function permissionUrl() {
    return `${repositoryUrl()}/collaborators/${AUTHORITY.ownerLogin}/permission`;
}

function runAttemptUrl(runId, attempt) {
    return `${repositoryUrl()}/actions/runs/${runId}/attempts/${attempt}`;
}

function response(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => structuredClone(body),
    };
}
