const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export const AIMHOOMAN_REPOSITORY_AUTHORITY = Object.freeze({
    fullName: 'rmyndharis/aimhooman',
    repositoryId: 1301417609,
    ownerLogin: 'rmyndharis',
    ownerId: 2390382,
});

export function parseGitHubRepository(repository) {
    const fields = typeof repository === 'string' ? repository.split('/') : [];
    if (fields.length !== 2 || fields.some((field) => (
        !/^[A-Za-z0-9_.-]+$/.test(field) || field === '.' || field === '..'
    ))) {
        throw new Error('GITHUB_REPOSITORY must be an owner/name pair');
    }
    const [owner, name] = fields;
    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        apiPath: `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    };
}

export function workflowPathFromRef(repository, workflowRef) {
    const parsed = parseGitHubRepository(repository);
    const value = requiredText(workflowRef, 'GITHUB_WORKFLOW_REF');
    const prefix = `${parsed.fullName}/`;
    const separator = value.indexOf('@refs/', prefix.length);
    if (separator <= prefix.length || !equalLogin(value.slice(0, prefix.length), prefix)) {
        throw new Error('GITHUB_WORKFLOW_REF does not identify this repository and a Git ref');
    }
    const path = value.slice(prefix.length, separator);
    if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path)) {
        throw new Error('GITHUB_WORKFLOW_REF does not identify a workflow file');
    }
    return path;
}

export function assertOwnerWorkflowRun(run, expected) {
    objectValue(run, 'workflow run attempt');
    const repository = objectValue(run.repository, 'workflow run repository');
    const repositoryOwner = objectValue(repository.owner, 'workflow run repository owner');
    const headRepository = objectValue(run.head_repository, 'workflow run head repository');
    const actor = objectValue(run.actor, 'workflow run actor');
    const triggeringActor = objectValue(run.triggering_actor, 'workflow run triggering actor');

    exactInteger(run.id, expected.runId, 'workflow run ID');
    exactInteger(run.run_attempt, expected.runAttempt, 'workflow run attempt number');
    exactText(run.event, expected.event, 'workflow run event');
    exactObjectId(run.head_sha, expected.headSha, 'workflow run head SHA');
    exactText(run.head_branch, expected.refName, 'workflow run ref name');
    exactText(run.path, expected.workflowPath, 'workflow path');

    exactInteger(repository.id, expected.repositoryId, 'workflow repository ID');
    exactLogin(repository.full_name, expected.fullName, 'workflow repository name');
    exactInteger(repositoryOwner.id, expected.ownerId, 'workflow repository owner ID');
    exactLogin(repositoryOwner.login, expected.ownerLogin, 'workflow repository owner login');
    exactText(repositoryOwner.type, 'User', 'workflow repository owner type');

    exactInteger(headRepository.id, expected.repositoryId, 'workflow head repository ID');
    exactLogin(headRepository.full_name, expected.fullName, 'workflow head repository name');

    for (const [label, identity] of [
        ['workflow actor', actor],
        ['workflow triggering actor', triggeringActor],
    ]) {
        exactInteger(identity.id, expected.ownerId, `${label} ID`);
        exactLogin(identity.login, expected.ownerLogin, `${label} login`);
        exactText(identity.type, 'User', `${label} type`);
    }

    return Object.freeze({
        ownerLogin: repositoryOwner.login,
        ownerId: repositoryOwner.id,
        repositoryId: repository.id,
        runId: run.id,
        runAttempt: run.run_attempt,
        event: run.event,
        headSha: run.head_sha.toLowerCase(),
        refName: run.head_branch,
        workflowPath: run.path,
    });
}

export async function verifyOwnerWorkflowRun({
    env = process.env,
    expectedEvent,
    expectedHead,
    expectedRef,
    expectedWorkflowPath,
    requireWorkflowAtHead = false,
    authority = AIMHOOMAN_REPOSITORY_AUTHORITY,
    fetchImpl = fetch,
} = {}) {
    const repository = requiredEnvironment(env, 'GITHUB_REPOSITORY');
    const token = requiredEnvironment(env, 'GITHUB_TOKEN');
    const actor = requiredEnvironment(env, 'GITHUB_ACTOR');
    const triggeringActor = requiredEnvironment(env, 'GITHUB_TRIGGERING_ACTOR');
    const event = requiredText(expectedEvent, 'expected workflow event');
    const headSha = objectId(expectedHead, 'expected workflow head SHA');
    const refName = requiredText(expectedRef, 'expected workflow ref name');
    const workflowPath = requiredText(expectedWorkflowPath, 'expected workflow path');
    const parsed = parseGitHubRepository(repository);

    exactLogin(parsed.fullName, authority.fullName, 'repository name');
    exactLogin(parsed.owner, authority.ownerLogin, 'repository owner');
    exactLogin(actor, authority.ownerLogin, 'GITHUB_ACTOR');
    exactLogin(triggeringActor, authority.ownerLogin, 'GITHUB_TRIGGERING_ACTOR');
    exactInteger(
        positiveInteger(requiredEnvironment(env, 'GITHUB_REPOSITORY_ID'), 'GITHUB_REPOSITORY_ID'),
        authority.repositoryId,
        'GITHUB_REPOSITORY_ID',
    );
    exactInteger(
        positiveInteger(requiredEnvironment(env, 'GITHUB_REPOSITORY_OWNER_ID'), 'GITHUB_REPOSITORY_OWNER_ID'),
        authority.ownerId,
        'GITHUB_REPOSITORY_OWNER_ID',
    );
    exactInteger(
        positiveInteger(requiredEnvironment(env, 'GITHUB_ACTOR_ID'), 'GITHUB_ACTOR_ID'),
        authority.ownerId,
        'GITHUB_ACTOR_ID',
    );
    exactText(requiredEnvironment(env, 'GITHUB_EVENT_NAME'), event, 'GITHUB_EVENT_NAME');

    const workflowRefPath = workflowPathFromRef(repository, requiredEnvironment(env, 'GITHUB_WORKFLOW_REF'));
    exactText(workflowRefPath, workflowPath, 'GITHUB_WORKFLOW_REF path');
    const workflowSha = objectId(requiredEnvironment(env, 'GITHUB_WORKFLOW_SHA'), 'GITHUB_WORKFLOW_SHA');
    if (requireWorkflowAtHead) exactObjectId(workflowSha, headSha, 'GITHUB_WORKFLOW_SHA');

    const runId = positiveInteger(requiredEnvironment(env, 'GITHUB_RUN_ID'), 'GITHUB_RUN_ID');
    const runAttempt = positiveInteger(
        requiredEnvironment(env, 'GITHUB_RUN_ATTEMPT'),
        'GITHUB_RUN_ATTEMPT',
    );
    const headers = githubHeaders(token);
    const repositoryUrl = `${API_ORIGIN}/repos/${parsed.apiPath}`;
    const currentRepository = await fetchGitHubObject(
        repositoryUrl,
        headers,
        fetchImpl,
        'repository authority',
    );
    const currentOwner = objectValue(currentRepository.owner, 'repository owner');
    exactInteger(currentRepository.id, authority.repositoryId, 'repository ID');
    exactLogin(currentRepository.full_name, authority.fullName, 'repository full name');
    exactInteger(currentOwner.id, authority.ownerId, 'repository owner ID');
    exactLogin(currentOwner.login, authority.ownerLogin, 'repository owner login');
    exactText(currentOwner.type, 'User', 'repository owner type');

    const permissionUrl = `${repositoryUrl}/collaborators/${encodeURIComponent(authority.ownerLogin)}/permission`;
    const runUrl = `${repositoryUrl}/actions/runs/${runId}/attempts/${runAttempt}`;
    const [permission, run] = await Promise.all([
        fetchGitHubObject(permissionUrl, headers, fetchImpl, 'repository owner permission'),
        fetchGitHubObject(runUrl, headers, fetchImpl, 'workflow run attempt'),
    ]);
    const permissionUser = objectValue(permission.user, 'repository permission user');
    exactText(permission.permission, 'admin', 'repository owner permission');
    exactInteger(permissionUser.id, authority.ownerId, 'repository permission user ID');
    exactLogin(permissionUser.login, authority.ownerLogin, 'repository permission user login');
    exactText(permissionUser.type, 'User', 'repository permission user type');

    return assertOwnerWorkflowRun(run, {
        ...authority,
        runId,
        runAttempt,
        event,
        headSha,
        refName,
        workflowPath,
    });
}

function githubHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'aimhooman-owner-gate',
        'X-GitHub-Api-Version': API_VERSION,
    };
}

async function fetchGitHubObject(url, headers, fetchImpl, label) {
    const response = await fetchImpl(url, { headers });
    if (!response?.ok) {
        throw new Error(`cannot inspect ${label}: GitHub returned ${response?.status ?? 'an invalid response'}`);
    }
    const value = await response.json();
    return objectValue(value, label);
}

function requiredEnvironment(env, name) {
    return requiredText(env?.[name], name);
}

function requiredText(value, label) {
    if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
    return value;
}

function objectValue(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function positiveInteger(value, label) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return Number(value);
}

function objectId(value, label) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value || '')) {
        throw new Error(`${label} must be a Git object ID`);
    }
    return value.toLowerCase();
}

function equalLogin(left, right) {
    return typeof left === 'string'
        && typeof right === 'string'
        && left.toLowerCase() === right.toLowerCase();
}

function exactLogin(actual, expected, label) {
    if (!equalLogin(actual, expected)) throw new Error(`${label} does not match ${expected}`);
}

function exactText(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label} does not match ${expected}`);
}

function exactInteger(actual, expected, label) {
    if (!Number.isSafeInteger(actual) || actual !== expected) {
        throw new Error(`${label} does not match ${expected}`);
    }
}

function exactObjectId(actual, expected, label) {
    if (objectId(actual, label) !== objectId(expected, label)) {
        throw new Error(`${label} does not match ${expected}`);
    }
}
