import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    acknowledgeProtectedReleasePaths,
    acknowledgePullRequestPlan,
    approvedCodeowner,
    approvedOwners,
    codeownersAt,
    fetchPullRequestReviews,
    ownersForPath,
    protectedReleaseReviewPlan,
    pullRequestReviewPlan,
    acknowledgePushReviewPlan,
    pushReviewPlan,
} from '../scripts/acknowledge-reviewed-paths.mjs';
import { openRepo } from '../src/gitx.mjs';
import { loadOverrides } from '../src/state.mjs';

const CLI = join(import.meta.dirname, '..', 'bin', 'aimhooman.mjs');

test('CODEOWNERS lookup uses the last matching path rule', () => {
    const source = [
        '**/AGENTS.md @team',
        '/AGENTS.md @root-owner',
        '/.aimhooman.json @policy-owner',
    ].join('\n');
    assert.deepEqual(ownersForPath(source, 'AGENTS.md'), ['@root-owner']);
    assert.deepEqual(ownersForPath(source, 'docs/AGENTS.md'), ['@team']);
    assert.deepEqual(ownersForPath(source, '.aimhooman.json'), ['@policy-owner']);
});

test('CODEOWNERS ignores inline comments and unsupported pattern syntax', () => {
    assert.deepEqual(
        ownersForPath('/src/** @maintainer # @attacker', 'src/main.mjs'),
        ['@maintainer'],
    );
    assert.deepEqual(ownersForPath('!/src/** @negated', 'src/main.mjs'), []);
    assert.deepEqual(ownersForPath('/src/[ab].mjs @range', 'src/a.mjs'), []);
    assert.deepEqual(ownersForPath('\\#literal @escaped', '#literal'), []);
});

test('CODEOWNERS protects the enforcement and adapter trust roots', () => {
    const root = join(import.meta.dirname, '..');
    const source = readFileSync(join(root, '.github', 'CODEOWNERS'), 'utf8');
    for (const path of [
        '.github/CODEOWNERS',
        'nested/.aimhooman.json',
        'nested/.github/copilot-instructions.md',
        '.github/workflows/test.yml',
        'bin/aimhooman.mjs',
        'hooks/hooks.json',
        'rules/paths.json',
        'scripts/scan-ci-history.mjs',
        'src/scan.mjs',
        'tests/ci-review.test.mjs',
        '.gemini/settings.json',
        '.cursor/rules/aimhooman.mdc',
        'docs/hosts.json',
        'package.json',
    ]) {
        assert.deepEqual(ownersForPath(source, path), ['@rmyndharis'], path);
    }
});

test('only the latest approval on the exact head is accepted', () => {
    const head = 'a'.repeat(40);
    const reviews = [
        { user: { login: 'old' }, commit_id: 'b'.repeat(40), state: 'APPROVED', submitted_at: '2026-01-01' },
        { user: { login: 'kept' }, commit_id: head, state: 'APPROVED', submitted_at: '2026-01-01' },
        { user: { login: 'changed' }, commit_id: head, state: 'APPROVED', submitted_at: '2026-01-01' },
        { user: { login: 'changed' }, commit_id: head, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02' },
        { user: { login: 'CaseOwner' }, commit_id: head, state: 'APPROVED', submitted_at: '2026-01-01' },
        { user: { login: 'caseowner' }, commit_id: head, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02' },
    ];
    assert.deepEqual([...approvedOwners(reviews, head)], ['@kept']);
});

test('team CODEOWNERS fail closed under a repository-scoped workflow token', async () => {
    await assert.rejects(
        approvedCodeowner(
            ['@example/release-team'],
            new Set(['@alice']),
            {
                repository: 'example/project',
                token: 'token',
                fetchImpl: async () => { throw new Error('team APIs must not be queried'); },
            },
        ),
        /team CODEOWNERS are not supported.*direct @user/,
    );
});

test('remote CODEOWNER approval requires write-equivalent repository permission', async () => {
    const owner = ['@alice'];
    const approved = new Set(['@alice']);
    const url = 'https://api.github.com/repos/example/project/collaborators/alice/permission';
    assert.equal(await approvedCodeowner(owner, approved, {
        repository: 'example/project',
        token: 'token',
        fetchImpl: githubFetch(new Map([[url, { body: { permission: 'read' }, link: '' }]])),
    }), null);
    assert.deepEqual(await approvedCodeowner(owner, approved, {
        repository: 'example/project',
        token: 'token',
        fetchImpl: githubFetch(new Map([[url, { body: { permission: 'write' }, link: '' }]])),
    }), { owner: '@alice', reviewer: '@alice' });
});

test('review pagination includes a later state beyond the first 100 submissions', async () => {
    const head = 'a'.repeat(40);
    const first = Array.from({ length: 100 }, (_, index) => ({
        user: { login: index === 0 ? 'owner' : `reviewer-${index}` },
        commit_id: head,
        state: 'APPROVED',
        submitted_at: '2026-01-01T00:00:00Z',
    }));
    const pages = new Map([
        ['https://api.example/reviews?per_page=100', {
            body: first,
            link: '<https://api.example/reviews?per_page=100&page=2>; rel="next"',
        }],
        ['https://api.example/reviews?per_page=100&page=2', {
            body: [{
                user: { login: 'owner' },
                commit_id: head,
                state: 'CHANGES_REQUESTED',
                submitted_at: '2026-01-02T00:00:00Z',
            }],
            link: '',
        }],
    ]);
    const reviews = await fetchPullRequestReviews(
        'https://api.example/reviews?per_page=100',
        'token',
        async (url) => ({
            ok: pages.has(url),
            status: pages.has(url) ? 200 : 404,
            headers: { get: () => pages.get(url)?.link || '' },
            json: async () => pages.get(url)?.body,
        }),
    );
    assert.equal(reviews.length, 101);
    assert.equal(approvedOwners(reviews, head).has('@owner'), false);
});

test('CI reads ownership rules from the reviewed base rather than the proposed head', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-codeowners-base-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'CI Review Test'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'ci-review@example.com'], { cwd: root });
        mkdirSync(join(root, '.github'));
        writeFileSync(join(root, '.github/CODEOWNERS'), '/AGENTS.md @base-owner\n');
        execFileSync('git', ['add', '.github/CODEOWNERS'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', 'base owners'], { cwd: root });
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

        writeFileSync(join(root, '.github/CODEOWNERS'), '/AGENTS.md @proposed-owner\n');
        execFileSync('git', ['add', '.github/CODEOWNERS'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', 'proposed owners'], { cwd: root });

        assert.deepEqual(ownersForPath(codeownersAt(base, root), 'AGENTS.md'), ['@base-owner']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('CODEOWNERS discovery follows GitHub location precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'aim-codeowners-locations-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'CI Review Test'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'ci-review@example.com'], { cwd: root });
        mkdirSync(join(root, 'docs'));
        writeFileSync(join(root, 'CODEOWNERS'), '/AGENTS.md @root-owner\n');
        writeFileSync(join(root, 'docs/CODEOWNERS'), '/AGENTS.md @docs-owner\n');
        execFileSync('git', ['add', 'CODEOWNERS', 'docs/CODEOWNERS'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', 'root and docs owners'], { cwd: root });
        let commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        assert.deepEqual(ownersForPath(codeownersAt(commit, root), 'AGENTS.md'), ['@root-owner']);

        mkdirSync(join(root, '.github'));
        writeFileSync(join(root, '.github/CODEOWNERS'), '/AGENTS.md @github-owner\n');
        execFileSync('git', ['add', '.github/CODEOWNERS'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', 'github owners'], { cwd: root });
        commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        assert.deepEqual(ownersForPath(codeownersAt(commit, root), 'AGENTS.md'), ['@github-owner']);

        execFileSync('git', ['rm', '-q', '.github/CODEOWNERS', 'CODEOWNERS'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', 'docs owners only'], { cwd: root });
        commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        assert.deepEqual(ownersForPath(codeownersAt(commit, root), 'AGENTS.md'), ['@docs-owner']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('one PR-head approval cannot authorize transient policy results', async () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        const firstOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        git(root, ['rm', '-q', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'remove policy']);
        const removed = git(root, ['rev-parse', 'HEAD']);

        writePolicy(root, 'strict', true);
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'restore strict policy']);
        const secondOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        writePolicy(root, 'compliance');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'change policy']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const nextObject = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);
        const plan = pullRequestReviewPlan(base, head, root);

        assert.deepEqual(plan.paths, ['.aimhooman.json']);
        assert.deepEqual(plan.migrations, [
            {
                head,
                transition: removed,
                oldObjectId: firstOld,
                newObjectId: null,
            },
            {
                head,
                transition: head,
                oldObjectId: secondOld,
                newObjectId: nextObject,
            },
        ]);

        await assert.rejects(acknowledgePullRequestPlan(
            plan,
            codeownersAt(base, root),
            [approvedReview('owner', base)],
            root,
        ), /does not match the exact approved PR head/);
        assert.equal(existsSync(join(root, '.git', 'aimhooman', 'overrides.json')), false);

        await assert.rejects(
            acknowledgePullRequestPlan(
                plan,
                codeownersAt(base, root),
                [approvedReview('owner', head)],
                root,
            ),
            /does not match the exact approved PR head/,
        );
        assert.equal(existsSync(join(root, '.git', 'aimhooman', 'overrides.json')), false);

        // A protected release gate has authority over the whole selected
        // history, so it may bind each exact transient transition separately.
        acknowledgeProtectedReleasePaths(base, head, 'v0.1.0-transient-test', root);
        const overrides = loadOverrides(openRepo(root).stateDir).allow;
        assert.deepEqual(
            new Set(overrides
                .filter((entry) => entry.scope === 'reviewed-policy-file')
                .map((entry) => entry.newObjectId)),
            new Set([null, secondOld, nextObject]),
        );
        assert.deepEqual(
            overrides
                .filter((entry) => entry.scope === 'policy-migration')
                .map((entry) => ({
                    head: entry.head,
                    transition: entry.transition,
                    oldObjectId: entry.oldObjectId,
                    newObjectId: entry.newObjectId ?? null,
                })),
            plan.migrations,
        );

        const report = JSON.parse(execFileSync(process.execPath, [
            CLI, 'check', '--range', `${base}...${head}`, '--profile', 'strict', '--json',
        ], { cwd: root, encoding: 'utf8' }));
        assert.equal(report.findings.some((finding) => (
            finding.ruleId === 'generic.project-policy' && finding.category === 'policy-config'
        )), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('exact CODEOWNER reviews bind instruction deletion, rename, and copy transitions', async () => {
    const root = instructionRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);

        git(root, ['rm', '-q', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'delete instructions']);
        const deleted = git(root, ['rev-parse', 'HEAD']);
        const deletionPlan = pullRequestReviewPlan(base, deleted, root);
        assert.deepEqual(deletionPlan.paths, ['AGENTS.md']);
        assert.deepEqual(deletionPlan.snapshots, [{ commit: deleted, path: 'AGENTS.md' }]);
        await acknowledgePullRequestPlan(
            deletionPlan,
            codeownersAt(base, root),
            [approvedReview('owner', deleted)],
            root,
        );
        let reviewed = loadOverrides(openRepo(root).stateDir).allow
            .filter((entry) => entry.scope === 'reviewed-instruction');
        assert.deepEqual(reviewed.map((entry) => ({
            target: entry.target,
            transition: entry.transition,
            newObjectId: entry.newObjectId,
        })), [{ target: 'AGENTS.md', transition: deleted, newObjectId: null }]);
        assert.equal(reviewFinding(root, base, deleted), undefined);
        assert.equal(commitReviewFinding(root, deleted), undefined);

        writeFileSync(join(root, 'AGENTS.md'), '# restored instructions\n');
        git(root, ['add', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'restore instructions']);
        const restored = git(root, ['rev-parse', 'HEAD']);
        mkdirSync(join(root, 'nested'));
        git(root, ['mv', 'AGENTS.md', 'nested/AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'rename instructions']);
        const renamed = git(root, ['rev-parse', 'HEAD']);
        const renamePlan = pullRequestReviewPlan(restored, renamed, root);
        assert.deepEqual(renamePlan.paths, ['AGENTS.md', 'nested/AGENTS.md']);
        await acknowledgePullRequestPlan(
            renamePlan,
            codeownersAt(base, root),
            [approvedReview('owner', renamed)],
            root,
        );
        reviewed = loadOverrides(openRepo(root).stateDir).allow
            .filter((entry) => entry.scope === 'reviewed-instruction' && entry.head === renamed);
        assert.deepEqual(
            new Set(reviewed.map((entry) => `${entry.target}\0${entry.newObjectId ?? 'tombstone'}`)),
            new Set([
                'AGENTS.md\0tombstone',
                `nested/AGENTS.md\0${git(root, ['rev-parse', 'HEAD:nested/AGENTS.md'])}`,
            ]),
        );
        assert.equal(reviewFinding(root, restored, renamed), undefined);
        assert.equal(commitReviewFinding(root, renamed), undefined);

        const copyBase = renamed;
        mkdirSync(join(root, 'copy'));
        writeFileSync(
            join(root, 'copy/AGENTS.md'),
            readFileSync(join(root, 'nested/AGENTS.md')),
        );
        git(root, ['add', 'copy/AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'copy instructions']);
        const copied = git(root, ['rev-parse', 'HEAD']);
        const copyPlan = pullRequestReviewPlan(copyBase, copied, root);
        assert.deepEqual(copyPlan.paths, ['copy/AGENTS.md']);
        await acknowledgePullRequestPlan(
            copyPlan,
            codeownersAt(base, root),
            [approvedReview('owner', copied)],
            root,
        );
        assert.equal(reviewFinding(root, copyBase, copied), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('PR-head review refuses intermediate merge results while protected release binds every strict parent', async () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        const firstOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);
        git(root, ['branch', '-m', 'main']);
        git(root, ['checkout', '-q', '-b', 'topic']);
        writeFileSync(join(root, 'topic.txt'), 'topic\n');
        git(root, ['add', 'topic.txt']);
        git(root, ['commit', '-q', '-m', 'topic work']);

        git(root, ['checkout', '-q', 'main']);
        writePolicy(root, 'strict', true);
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'rewrite strict policy']);
        const secondOld = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        git(root, ['checkout', '-q', 'topic']);
        git(root, ['merge', '--no-commit', '--no-ff', 'main']);
        writePolicy(root, 'clean');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'merge with policy change']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const nextObject = git(root, ['rev-parse', 'HEAD:.aimhooman.json']);

        const pullRequestPlan = pullRequestReviewPlan(base, head, root);
        assert.deepEqual(
            new Set(pullRequestPlan.migrations.map((migration) => migration.oldObjectId)),
            new Set([firstOld, secondOld]),
        );
        await assert.rejects(
            acknowledgePullRequestPlan(
                pullRequestPlan,
                codeownersAt(base, root),
                [approvedReview('owner', head)],
                root,
            ),
            /does not match the exact approved PR head/,
        );
        const releasePlan = protectedReleaseReviewPlan(base, head, root);
        assert.deepEqual(
            new Set(releasePlan.migrations.map((migration) => migration.oldObjectId)),
            new Set([firstOld, secondOld]),
        );
        assert.ok(releasePlan.migrations.every((migration) => (
            migration.head === head
            && migration.transition === head
            && migration.newObjectId === nextObject
        )));

        acknowledgeProtectedReleasePaths(base, head, 'v0.1.0-test', root);
        const migrations = loadOverrides(openRepo(root).stateDir).allow
            .filter((entry) => entry.scope === 'policy-migration');
        assert.equal(migrations.length, 2);

        const report = JSON.parse(execFileSync(process.execPath, [
            CLI, 'check', '--range', `${base}...${head}`, '--profile', 'strict', '--json',
        ], { cwd: root, encoding: 'utf8' }));
        assert.equal(report.findings.some((finding) => (
            finding.ruleId === 'generic.project-policy' && finding.category === 'policy-config'
        )), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a pushed policy change needs a merged PR with exact-head CODEOWNER evidence', async () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        writePolicy(root, 'clean');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'change policy']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const plan = pushReviewPlan(base, head, root);
        assert.deepEqual(plan.changes, [{ commit: head, path: '.aimhooman.json' }]);
        assert.equal(plan.migrations.length, 1);

        await assert.rejects(
            acknowledgePushReviewPlan(plan, {
                repository: 'example/project',
                token: 'token',
                refName: 'main',
                defaultBranch: 'main',
                cwd: root,
                fetchImpl: githubFetch(new Map([
                    [`https://api.github.com/repos/example/project/commits/${head}/pulls?per_page=100`, []],
                ])),
            }),
            /has no merged pull request with an exact-head CODEOWNER approval/,
        );
        assert.equal(existsSync(join(root, '.git', 'aimhooman', 'overrides.json')), false);

        const routes = new Map([
            [`https://api.github.com/repos/example/project/commits/${head}/pulls?per_page=100`, [{
                number: 42,
                merged_at: '2026-01-01T00:00:00Z',
                head: { sha: head },
                base: { sha: base, ref: 'main', repo: { full_name: 'example/project' } },
            }]],
            ['https://api.github.com/repos/example/project/pulls/42/files?per_page=100', {
                body: Array.from({ length: 100 }, (_, index) => ({
                    filename: `docs/file-${index}.md`,
                    status: 'modified',
                })),
                link: '<https://api.github.com/repos/example/project/pulls/42/files?per_page=100&page=2>; rel="next"',
            }],
            ['https://api.github.com/repos/example/project/pulls/42/files?per_page=100&page=2', [{
                filename: '.aimhooman.json',
                status: 'modified',
            }]],
            ['https://api.github.com/repos/example/project/pulls/42/reviews?per_page=100', [
                approvedReview('owner', head),
            ]],
            ['https://api.github.com/repos/example/project/collaborators/owner/permission', {
                body: { permission: 'admin' },
                link: '',
            }],
        ]);
        await acknowledgePushReviewPlan(plan, {
            repository: 'example/project',
            token: 'token',
            refName: 'main',
            defaultBranch: 'main',
            cwd: root,
            fetchImpl: githubFetch(routes),
        });

        const overrides = loadOverrides(openRepo(root).stateDir).allow;
        assert.equal(overrides.some((entry) => (
            entry.scope === 'reviewed-policy-file' && entry.head === head
        )), true);
        assert.equal(overrides.some((entry) => (
            entry.scope === 'policy-migration'
            && entry.head === head
            && entry.transition === head
        )), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('merged PR proof is bound to the exact merge or squash path result', async (t) => {
    const root = instructionRepository();
    try {
        const baseBranch = git(root, ['branch', '--show-current']);
        const base = git(root, ['rev-parse', 'HEAD']);
        git(root, ['checkout', '-q', '-b', 'approved-topic']);
        const approvedBytes = '# approved instructions\n';
        writeFileSync(join(root, 'AGENTS.md'), approvedBytes);
        git(root, ['add', 'AGENTS.md']);
        git(root, ['commit', '-q', '-m', 'approved topic instructions']);
        const approvedHead = git(root, ['rev-parse', 'HEAD']);
        const approvedTree = git(root, ['rev-parse', 'HEAD^{tree}']);
        const approvedBlob = git(root, ['rev-parse', 'HEAD:AGENTS.md']);

        const routesFor = (resultHead) => new Map([
            [`https://api.github.com/repos/example/project/commits/${resultHead}/pulls?per_page=100`, [{
                number: 77,
                merged_at: '2026-01-01T00:00:00Z',
                head: {
                    sha: approvedHead,
                    repo: { full_name: 'example/project' },
                },
                base: { sha: base, ref: 'main', repo: { full_name: 'example/project' } },
            }]],
            ['https://api.github.com/repos/example/project/pulls/77/files?per_page=100', [{
                filename: 'AGENTS.md',
                status: 'modified',
                sha: approvedBlob,
            }]],
            ['https://api.github.com/repos/example/project/pulls/77/reviews?per_page=100', [
                approvedReview('owner', approvedHead),
            ]],
            ['https://api.github.com/repos/example/project/collaborators/owner/permission', {
                body: { permission: 'admin' },
                link: '',
            }],
            [`https://api.github.com/repos/example/project/git/commits/${approvedHead}`, {
                body: { sha: approvedHead, tree: { sha: approvedTree } },
                link: '',
            }],
            [`https://api.github.com/repos/example/project/git/trees/${approvedTree}?recursive=1`, {
                body: {
                    sha: approvedTree,
                    truncated: false,
                    tree: [{
                        path: 'AGENTS.md',
                        mode: '100644',
                        type: 'blob',
                        sha: approvedBlob,
                    }],
                },
                link: '',
            }],
        ]);
        const acknowledge = (plan, resultHead) => acknowledgePushReviewPlan(plan, {
            repository: 'example/project',
            token: 'token',
            refName: 'main',
            defaultBranch: 'main',
            cwd: root,
            fetchImpl: githubFetch(routesFor(resultHead)),
        });

        await t.test('different merge result is rejected without writing an override', async () => {
            git(root, ['checkout', '-q', '-B', baseBranch, base]);
            writeFileSync(join(root, 'AGENTS.md'), '# injected during merge\n');
            git(root, ['add', 'AGENTS.md']);
            git(root, ['commit', '-q', '-m', 'divergent merge result']);
            const resultHead = git(root, ['rev-parse', 'HEAD']);
            const plan = pushReviewPlan(base, resultHead, root);
            await assert.rejects(
                acknowledge(plan, resultHead),
                /has no merged pull request with an exact-head CODEOWNER approval/,
            );
            assert.equal(existsSync(join(root, '.git', 'aimhooman', 'overrides.json')), false);
        });

        await t.test('exact squash result is accepted', async () => {
            git(root, ['checkout', '-q', '-B', baseBranch, base]);
            writeFileSync(join(root, 'AGENTS.md'), approvedBytes);
            git(root, ['add', 'AGENTS.md']);
            git(root, ['commit', '-q', '-m', 'exact squash result']);
            const resultHead = git(root, ['rev-parse', 'HEAD']);
            const plan = pushReviewPlan(base, resultHead, root);
            await acknowledge(plan, resultHead);
            assert.ok(loadOverrides(openRepo(root).stateDir).allow.some((entry) => (
                entry.scope === 'reviewed-instruction'
                && entry.head === resultHead
                && entry.newObjectId === approvedBlob
                && entry.newMode === '100644'
            )));
        });

        await t.test('same blob with a different mode is rejected', async () => {
            git(root, ['checkout', '-q', '-B', baseBranch, base]);
            writeFileSync(join(root, 'AGENTS.md'), approvedBytes);
            git(root, ['add', 'AGENTS.md']);
            git(root, ['update-index', '--chmod=+x', 'AGENTS.md']);
            git(root, ['commit', '-q', '-m', 'mode-divergent squash result']);
            const resultHead = git(root, ['rev-parse', 'HEAD']);
            const before = loadOverrides(openRepo(root).stateDir).allow.length;
            await assert.rejects(
                acknowledge(pushReviewPlan(base, resultHead, root), resultHead),
                /has no merged pull request with an exact-head CODEOWNER approval/,
            );
            const after = loadOverrides(openRepo(root).stateDir).allow;
            assert.equal(after.length, before);
            assert.equal(after.some((entry) => entry.head === resultHead), false);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('one initial default-branch commit can bootstrap reviewed paths without impossible PR evidence', async () => {
    const root = policyRepository();
    try {
        const head = git(root, ['rev-parse', 'HEAD']);
        const plan = pushReviewPlan('0'.repeat(head.length), head, root);
        assert.equal(plan.initialCommit, true);
        assert.deepEqual(plan.changes, [{ commit: head, path: '.aimhooman.json' }]);
        assert.deepEqual(plan.migrations, []);

        await acknowledgePushReviewPlan(plan, {
            repository: 'example/project',
            token: 'token',
            refName: 'main',
            defaultBranch: 'main',
            cwd: root,
            fetchImpl: async () => {
                throw new Error('initial commit must not request nonexistent PR evidence');
            },
        });

        const overrides = loadOverrides(openRepo(root).stateDir).allow;
        assert.equal(overrides.some((entry) => (
            entry.scope === 'reviewed-policy-file' && entry.head === head
        )), true);

        await assert.rejects(
            acknowledgePushReviewPlan(plan, {
                repository: 'example/project',
                token: 'token',
                refName: 'topic',
                defaultBranch: 'main',
                cwd: root,
                fetchImpl: githubFetch(new Map([
                    [`https://api.github.com/repos/example/project/commits/${head}/pulls?per_page=100`, []],
                ])),
            }),
            /has no current open pull request with an exact-head CODEOWNER approval/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a feature-branch push accepts a current open PR approval bound to the pushed head', async () => {
    const root = policyRepository();
    try {
        const base = git(root, ['rev-parse', 'HEAD']);
        writePolicy(root, 'compliance');
        git(root, ['add', '.aimhooman.json']);
        git(root, ['commit', '-q', '-m', 'change policy on topic']);
        const head = git(root, ['rev-parse', 'HEAD']);
        const plan = pushReviewPlan(base, head, root);
        const routes = new Map([
            [`https://api.github.com/repos/example/project/commits/${head}/pulls?per_page=100`, [{
                number: 43,
                state: 'open',
                merged_at: null,
                head: {
                    sha: head,
                    ref: 'topic',
                    repo: { full_name: 'example/project' },
                },
                base: { sha: base, ref: 'main', repo: { full_name: 'example/project' } },
            }]],
            ['https://api.github.com/repos/example/project/pulls/43/files?per_page=100', [{
                filename: '.aimhooman.json',
                status: 'modified',
            }]],
            ['https://api.github.com/repos/example/project/pulls/43/reviews?per_page=100', [
                approvedReview('owner', head),
            ]],
            ['https://api.github.com/repos/example/project/collaborators/owner/permission', {
                body: { permission: 'admin' },
                link: '',
            }],
        ]);

        await acknowledgePushReviewPlan(plan, {
            repository: 'example/project',
            token: 'token',
            refName: 'topic',
            defaultBranch: 'main',
            cwd: root,
            fetchImpl: githubFetch(routes),
        });
        const overrides = loadOverrides(openRepo(root).stateDir).allow;
        assert.equal(overrides.some((entry) => (
            entry.scope === 'policy-migration' && entry.head === head
        )), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function policyRepository() {
    const root = mkdtempSync(join(tmpdir(), 'aim-policy-review-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'CI Review Test']);
    git(root, ['config', 'user.email', 'ci-review@example.com']);
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '/.aimhooman.json @owner\n');
    writePolicy(root, 'strict');
    git(root, ['add', '.github/CODEOWNERS', '.aimhooman.json']);
    git(root, ['commit', '-q', '-m', 'strict policy']);
    return root;
}

function instructionRepository() {
    const root = mkdtempSync(join(tmpdir(), 'aim-instruction-review-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'CI Review Test']);
    git(root, ['config', 'user.email', 'ci-review@example.com']);
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github/CODEOWNERS'), [
        '/AGENTS.md @owner',
        '**/AGENTS.md @owner',
    ].join('\n') + '\n');
    writeFileSync(join(root, 'AGENTS.md'), '# reviewed instructions\n');
    git(root, ['add', '.github/CODEOWNERS', 'AGENTS.md']);
    git(root, ['commit', '-q', '-m', 'reviewed instructions']);
    return root;
}

function reviewFinding(root, base, head) {
    const report = JSON.parse(execFileSync(process.execPath, [
        CLI, 'check', '--range', `${base}...${head}`, '--profile', 'strict', '--json',
    ], { cwd: root, encoding: 'utf8' }));
    return report.findings.find((finding) => (
        finding.matchedRuleIds?.includes('generic.agent-instructions')
    ));
}

function commitReviewFinding(root, commit) {
    const report = JSON.parse(execFileSync(process.execPath, [
        CLI, 'check', '--commit', commit, '--profile', 'strict', '--json',
    ], { cwd: root, encoding: 'utf8' }));
    return report.findings.find((finding) => (
        finding.matchedRuleIds?.includes('generic.agent-instructions')
    ));
}

function writePolicy(root, profile, pretty = false) {
    const policy = { schema_version: 1, profile };
    writeFileSync(
        join(root, '.aimhooman.json'),
        pretty ? `${JSON.stringify(policy, null, 2)}\n` : `${JSON.stringify(policy)}\n`,
    );
}

function approvedReview(login, head) {
    return {
        user: { login },
        commit_id: head,
        state: 'APPROVED',
        submitted_at: '2026-01-01T00:00:00Z',
    };
}

function githubFetch(routes) {
    return async (url) => {
        const route = routes.get(url);
        const page = Array.isArray(route) ? { body: route, link: '' } : route;
        return {
            ok: routes.has(url),
            status: routes.has(url) ? 200 : 404,
            headers: { get: () => page?.link || '' },
            json: async () => page?.body,
        };
    };
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
