import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRevisionError, openRepo } from '../src/gitx.mjs';
import { commitChanges, commitMessage, commitSnapshot, historyRange, parseHistoryRange } from '../src/history-scan.mjs';
import { scanGitTarget } from '../src/scan-target.mjs';
import { LocalOverridesError, saveConfig, saveOverrides } from '../src/state.mjs';
import { exitCode } from '../src/report.mjs';

function repository() {
    const dir = mkdtempSync(join(tmpdir(), 'aim-history-'));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(dir, 'README.md'), 'base\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-q', '-m', 'base']);
    return dir;
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('history range retains files that disappear before the endpoint', () => {
    const dir = repository();
    try {
        const base = git(dir, ['rev-parse', 'HEAD']);
        writeFileSync(join(dir, '.env'), 'TOKEN=value\n');
        git(dir, ['add', '-f', '.env']);
        git(dir, ['commit', '-q', '-m', 'temporary file']);
        git(dir, ['rm', '-q', '.env']);
        git(dir, ['commit', '-q', '-m', 'remove temporary file']);

        const repo = openRepo(dir);
        const history = historyRange(repo, `${base}..HEAD`);
        assert.equal(history.commits.length, 2);
        const first = commitChanges(repo, history.commits[0].commit, history.commits[0].commit, history.commits[0].parents);
        assert.equal(first.entries.some((entry) => entry.path === '.env' && entry.type === 'blob'), true);
        const second = commitChanges(repo, history.commits[1].commit, history.commits[1].commit, history.commits[1].parents);
        assert.equal(second.entries.some((entry) => entry.path === '.env' && entry.type === 'deleted'), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('history range reads each commit message and resolves three-dot merge bases', () => {
    const dir = repository();
    try {
        const base = git(dir, ['rev-parse', 'HEAD']);
        writeFileSync(join(dir, 'one.txt'), 'one');
        git(dir, ['add', 'one.txt']);
        git(dir, ['commit', '-q', '-m', 'first message']);
        writeFileSync(join(dir, 'two.txt'), 'two');
        git(dir, ['add', 'two.txt']);
        git(dir, ['commit', '-q', '-m', 'last message']);

        const repo = openRepo(dir);
        const history = historyRange(repo, `${base}...HEAD`);
        assert.equal(history.scanBase, base);
        const messages = history.commits.map((item) => commitMessage(repo, item.commit, item.commit).message.trim());
        assert.deepEqual(messages, ['first message', 'last message']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('history object reads ignore local replacement refs', () => {
    const dir = repository();
    try {
        const originalBranch = git(dir, ['branch', '--show-current']);
        const original = git(dir, ['rev-parse', 'HEAD']);

        git(dir, ['checkout', '-q', '--orphan', 'replacement-history']);
        git(dir, ['rm', '-q', '-rf', '.']);
        writeFileSync(join(dir, 'README.md'), 'replacement\n');
        git(dir, ['add', 'README.md']);
        git(dir, ['commit', '-q', '-m', 'replacement message']);
        const replacement = git(dir, ['rev-parse', 'HEAD']);

        git(dir, ['checkout', '-q', originalBranch]);
        git(dir, ['replace', original, replacement]);
        assert.equal(commitMessage(openRepo(dir), original).message.trim(), 'base');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('git stderr from a passing history read is captured, not printed', () => {
    const dir = repository();
    try {
        const head = git(dir, ['rev-parse', 'HEAD']);
        // A --reference clone whose reference was deleted leaves a stale
        // alternates file. Git then writes `error:` to stderr and still exits 0,
        // so only the wrapper's stdio decides whether the user reads it, mixed
        // in with aimhooman's own diagnostics on the same stream.
        writeFileSync(join(dir, '.git/objects/info/alternates'), `${join(dir, 'gone', 'objects')}\n`);
        const repo = openRepo(dir);

        const leaked = [];
        const write = process.stderr.write;
        process.stderr.write = (chunk) => (leaked.push(String(chunk)), true);
        try {
            assert.equal(commitMessage(repo, head, head).message.trim(), 'base');
            assert.equal(commitSnapshot(repo, head).entries.length, 1);
            assert.equal(commitChanges(repo, head, head, []).entries.length, 1);
        } finally {
            process.stderr.write = write;
        }
        assert.equal(leaked.join(''), '');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('commit snapshot handles a root tree and unusual path names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-history-root-'));
    try {
        git(dir, ['init', '-q']);
        git(dir, ['config', 'user.name', 'Test']);
        git(dir, ['config', 'user.email', 'test@example.com']);
        const path = 'tab\tline\nbreak-å.txt';
        // Windows worktrees cannot represent control characters in filenames,
        // but Git history can. Build the root commit in the object database so
        // every platform exercises the NUL-delimited history parsers.
        const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: dir,
            encoding: 'utf8',
            input: 'content',
        }).trim();
        const tree = execFileSync('git', ['mktree', '-z'], {
            cwd: dir,
            encoding: 'utf8',
            input: Buffer.from(`100644 blob ${blob}\t${path}\0`),
        }).trim();
        const commit = git(dir, ['commit-tree', tree, '-m', 'root message']);

        const snapshot = commitSnapshot(openRepo(dir), commit);
        assert.equal(snapshot.parents.length, 0);
        assert.equal(snapshot.entries[0].path, path);
        assert.equal(snapshot.changes[0].path, path);
        assert.equal(snapshot.entries[0].size, Buffer.byteLength('content'));
        assert.equal(snapshot.message.trim(), 'root message');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('historyRange flags a shallow clone and range scans fail closed under strict', () => {
    const src = mkdtempSync(join(tmpdir(), 'aim-shallow-src-'));
    const clone = mkdtempSync(join(tmpdir(), 'aim-shallow-clone-'));
    try {
        git(src, ['init', '-q']);
        git(src, ['config', 'user.name', 'Test']);
        git(src, ['config', 'user.email', 'test@example.com']);
        writeFileSync(join(src, 'README.md'), 'base\n');
        git(src, ['add', 'README.md']);
        git(src, ['commit', '-q', '-m', 'base']);
        writeFileSync(join(src, '.env'), 'TOKEN=value\n');
        git(src, ['add', '-f', '.env']);
        git(src, ['commit', '-q', '-m', 'leak']);
        // Shallow clone: only the head commit is present locally. --no-local
        // forces the standard transport, which honors --depth (local clones ignore it).
        execFileSync('git', ['clone', '-q', '--no-local', '--depth', '1', src, clone], { encoding: 'utf8' });

        const repo = openRepo(clone);
        const history = historyRange(repo, `${'0'.repeat(40)}..HEAD`);
        assert.equal(history.shallow, true);
        assert.equal(history.commits.length, 1);

        // Strict fails closed: completeness cannot be proven on a shallow clone.
        assert.throws(
            () => scanGitTarget(repo, { kind: 'range', range: `${'0'.repeat(40)}..HEAD`, explicitProfile: 'strict' }),
            (e) => e instanceof GitRevisionError && /shallow repository/.test(e.message),
        );

        // Clean/compliance proceed without blocking the commit, but mark the
        // scan incomplete so the report's `complete` flag (and exit code 31)
        // signal the gap machine-readably instead of reporting a silent pass.
        const report = scanGitTarget(repo, { kind: 'range', range: `${'0'.repeat(40)}..HEAD` });
        assert.equal(report.complete, false);
        assert.match(report.diagnostics.map((d) => d.message).join('\n'), /shallow repository/);
    } finally {
        rmSync(src, { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
    }
});

test('single-commit scans mark a shallow parent boundary incomplete and recover after deepening', () => {
    const src = mkdtempSync(join(tmpdir(), 'aim-shallow-commit-src-'));
    const clone = mkdtempSync(join(tmpdir(), 'aim-shallow-commit-clone-'));
    try {
        git(src, ['init', '-q']);
        git(src, ['config', 'user.name', 'Test']);
        git(src, ['config', 'user.email', 'test@example.com']);
        writeFileSync(join(src, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'strict' }));
        git(src, ['add', '.aimhooman.json']);
        git(src, ['commit', '-q', '-m', 'strict parent']);
        writeFileSync(join(src, '.aimhooman.json'), JSON.stringify({ schema_version: 1, profile: 'clean' }));
        git(src, ['add', '.aimhooman.json']);
        git(src, ['commit', '-q', '-m', 'hidden downgrade']);
        execFileSync('git', ['clone', '-q', '--no-local', '--depth', '1', src, clone], { encoding: 'utf8' });

        const repo = openRepo(clone);
        const shallow = scanGitTarget(repo, { kind: 'commit', revision: 'HEAD' });
        assert.equal(shallow.complete, false);
        assert.match(shallow.diagnostics.map((item) => item.message).join('\n'), /cannot prove parent policy/);
        assert.throws(
            () => scanGitTarget(repo, { kind: 'commit', revision: 'HEAD', explicitProfile: 'strict' }),
            (error) => error instanceof GitRevisionError && /fetch full history/.test(error.message),
        );

        git(clone, ['fetch', '--unshallow', '-q']);
        const deepened = scanGitTarget(repo, { kind: 'commit', revision: 'HEAD' });
        assert.equal(deepened.complete, true);
        assert.equal(deepened.profile, 'strict');
        assert.ok(deepened.findings.some((finding) => finding.ruleId === 'generic.project-policy'));
    } finally {
        rmSync(src, { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
    }
});

test('a likely reversed range warns without rejecting a valid empty range', () => {
    const dir = repository();
    try {
        writeFileSync(join(dir, 'next.txt'), 'next\n');
        git(dir, ['add', 'next.txt']);
        git(dir, ['commit', '-q', '-m', 'next']);
        const repo = openRepo(dir);

        const reversedHistory = historyRange(repo, 'HEAD...HEAD~1');
        assert.equal(reversedHistory.reversed, true);
        const reversed = scanGitTarget(repo, { kind: 'range', range: 'HEAD...HEAD~1' });
        assert.equal(reversed.complete, true);
        assert.equal(exitCode(reversed.findings, reversed.profile, reversed.complete), 0);
        assert.match(reversed.diagnostics.map((item) => item.message).join('\n'), /endpoints may be reversed/);

        const emptyHistory = historyRange(repo, 'HEAD..HEAD');
        assert.equal(emptyHistory.reversed, false);
        assert.equal(scanGitTarget(repo, { kind: 'range', range: 'HEAD..HEAD' }).complete, true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a range mixing clean and compliance is not reported as compliance', () => {
    // Across the shipped packs compliance is not above clean: it allows the six
    // attribution rules clean blocks or reviews, and no rule runs the other way.
    // Nothing else in the code orders the two either. So the rank behind this
    // field is only a tiebreak, and it must not name the profile that allows
    // what the other blocks. Enforcement is per-commit and unaffected.
    const dir = repository();
    try {
        const base = git(dir, ['rev-parse', 'HEAD']);
        writeFileSync(join(dir, 'one.txt'), 'one\n');
        git(dir, ['add', 'one.txt']);
        git(dir, ['commit', '-q', '-m', 'work under the default profile']);
        writeFileSync(join(dir, '.aimhooman.json'), '{"schema_version":1,"profile":"compliance"}\n');
        git(dir, ['add', '.aimhooman.json']);
        git(dir, ['commit', '-q', '-m', 'adopt compliance']);

        const report = scanGitTarget(openRepo(dir), { kind: 'range', range: `${base}..HEAD` });
        assert.equal(report.policy_source, 'per-commit');
        assert.equal(report.profile, 'clean');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('staged strict policy reports the exact staged policy object', () => {
    const dir = repository();
    try {
        writeFileSync(join(dir, '.aimhooman.json'), '{"schema_version":1,"profile":"strict"}\n');
        git(dir, ['add', '.aimhooman.json']);
        git(dir, ['commit', '-q', '-m', 'strict policy']);
        const oldObject = git(dir, ['rev-parse', 'HEAD:.aimhooman.json']);
        writeFileSync(join(dir, '.aimhooman.json'), '{\n  "schema_version": 1,\n  "profile": "strict"\n}\n');
        git(dir, ['add', '.aimhooman.json']);
        const stagedObject = git(dir, ['rev-parse', ':.aimhooman.json']);

        const report = scanGitTarget(openRepo(dir), { kind: 'staged' });
        assert.notEqual(stagedObject, oldObject);
        assert.equal(report.policy_source, 'staged-policy');
        assert.equal(report.policy_object_id, stagedObject);
        assert.equal(report.policy_enforced_object_ids, undefined);

        rmSync(join(dir, '.aimhooman.json'));
        git(dir, ['add', '-u', '.aimhooman.json']);
        const repo = openRepo(dir);
        saveConfig(repo.stateDir, { profile: 'strict' });
        const deleted = scanGitTarget(repo, { kind: 'staged' });
        assert.equal(deleted.policy_object_id, oldObject);
        assert.deepEqual(deleted.policy_enforced_object_ids, [oldObject]);
        assert.ok(deleted.findings.some((finding) => finding.ruleId === 'generic.project-policy'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('review allowances and corrupt override state fail closed at scan time', () => {
    const dir = repository();
    try {
        writeFileSync(join(dir, 'AGENTS.md'), '# reviewed instructions\n');
        git(dir, ['add', 'AGENTS.md']);
        const repo = openRepo(dir);
        const head = git(dir, ['rev-parse', 'HEAD']);
        const reviewedObject = git(dir, ['rev-parse', ':AGENTS.md']);
        saveOverrides(repo.stateDir, {
            allow: [{
                target: 'AGENTS.md',
                scope: 'reviewed-instruction',
                head,
                transition: 'staged',
                newObjectId: reviewedObject,
                newMode: '100644',
            }],
            deny: [],
        });
        assert.deepEqual(
            scanGitTarget(repo, { kind: 'staged', explicitProfile: 'strict' }).findings,
            [],
        );

        writeFileSync(join(dir, 'AGENTS.md'), '# replaced after review\n');
        git(dir, ['add', 'AGENTS.md']);
        const replaced = scanGitTarget(repo, { kind: 'staged', explicitProfile: 'strict' });
        assert.equal(replaced.findings[0]?.ruleId, 'generic.agent-instructions');

        writeFileSync(join(repo.stateDir, 'overrides.json'), '{bad');
        assert.throws(
            () => scanGitTarget(repo, { kind: 'staged' }),
            LocalOverridesError,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('standalone commit review resolves an intermediate transition against the current head', () => {
    const dir = repository();
    try {
        writeFileSync(join(dir, 'AGENTS.md'), '# reviewed in an intermediate commit\n');
        git(dir, ['add', 'AGENTS.md']);
        git(dir, ['commit', '-q', '-m', 'add instructions']);
        const transition = git(dir, ['rev-parse', 'HEAD']);
        const reviewedObject = git(dir, ['rev-parse', 'HEAD:AGENTS.md']);

        writeFileSync(join(dir, 'after.txt'), 'final head\n');
        git(dir, ['add', 'after.txt']);
        git(dir, ['commit', '-q', '-m', 'advance head']);
        const head = git(dir, ['rev-parse', 'HEAD']);
        const repo = openRepo(dir);
        saveOverrides(repo.stateDir, {
            allow: [{
                target: 'AGENTS.md',
                scope: 'reviewed-instruction',
                head,
                transition,
                newObjectId: reviewedObject,
                newMode: '100644',
            }],
            deny: [],
        });

        const approved = scanGitTarget(repo, {
            kind: 'commit', revision: transition, explicitProfile: 'strict',
        });
        assert.equal(approved.findings.some((finding) => (
            finding.ruleId === 'generic.agent-instructions'
        )), false);

        const wrongExplicitHead = scanGitTarget(repo, {
            kind: 'commit',
            revision: transition,
            explicitProfile: 'strict',
            reviewContexts: [{ head: transition, transition }],
        });
        assert.ok(wrongExplicitHead.findings.some((finding) => (
            finding.ruleId === 'generic.agent-instructions'
        )));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('staged review mapping to a proposed tip remains exact on head, transition, blob, and mode', () => {
    const dir = repository();
    try {
        const oldHead = git(dir, ['rev-parse', 'HEAD']);
        writeFileSync(join(dir, 'AGENTS.md'), '# staged review\n');
        git(dir, ['add', 'AGENTS.md']);
        const reviewedObject = git(dir, ['rev-parse', ':AGENTS.md']);
        const wrongObject = git(dir, ['rev-parse', 'HEAD:README.md']);
        const repo = openRepo(dir);
        const exact = {
            target: 'AGENTS.md',
            scope: 'reviewed-instruction',
            head: oldHead,
            transition: 'staged',
            newObjectId: reviewedObject,
            newMode: '100644',
        };
        saveOverrides(repo.stateDir, { allow: [exact], deny: [] });
        git(dir, ['commit', '-q', '-m', 'approved instructions']);
        const proposedTip = git(dir, ['rev-parse', 'HEAD']);
        const mapping = [{
            head: oldHead,
            storedTransition: 'staged',
            scanTransition: proposedTip,
        }];

        let report = scanGitTarget(repo, {
            kind: 'commit', revision: proposedTip, explicitProfile: 'strict', reviewContexts: mapping,
        });
        assert.equal(report.findings.some((finding) => finding.ruleId === 'generic.agent-instructions'), false);

        for (const reviewContexts of [
            [{ head: proposedTip, storedTransition: 'staged', scanTransition: proposedTip }],
            [{ head: oldHead, storedTransition: proposedTip, scanTransition: proposedTip }],
        ]) {
            report = scanGitTarget(repo, {
                kind: 'commit', revision: proposedTip, explicitProfile: 'strict', reviewContexts,
            });
            assert.ok(report.findings.some((finding) => finding.ruleId === 'generic.agent-instructions'));
        }

        saveOverrides(repo.stateDir, { allow: [{ ...exact, newMode: '100755' }], deny: [] });
        report = scanGitTarget(repo, {
            kind: 'commit', revision: proposedTip, explicitProfile: 'strict', reviewContexts: mapping,
        });
        assert.ok(report.findings.some((finding) => finding.ruleId === 'generic.agent-instructions'));

        saveOverrides(repo.stateDir, { allow: [{ ...exact, newObjectId: wrongObject }], deny: [] });
        report = scanGitTarget(repo, {
            kind: 'commit', revision: proposedTip, explicitProfile: 'strict', reviewContexts: mapping,
        });
        assert.ok(report.findings.some((finding) => finding.ruleId === 'generic.agent-instructions'));

        saveOverrides(repo.stateDir, { allow: [exact], deny: [] });
        writeFileSync(join(dir, 'later.txt'), 'later\n');
        git(dir, ['add', 'later.txt']);
        git(dir, ['commit', '-q', '-m', 'later commit']);
        const later = git(dir, ['rev-parse', 'HEAD']);
        report = scanGitTarget(repo, {
            kind: 'commit',
            revision: proposedTip,
            explicitProfile: 'strict',
            reviewContexts: [{
                head: oldHead,
                storedTransition: 'staged',
                scanTransition: later,
            }],
        });
        assert.ok(report.findings.some((finding) => finding.ruleId === 'generic.agent-instructions'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a staged instruction deletion needs an exact reviewed tombstone', () => {
    const dir = repository();
    try {
        writeFileSync(join(dir, 'AGENTS.md'), '# tracked instructions\n');
        git(dir, ['add', 'AGENTS.md']);
        git(dir, ['commit', '-q', '-m', 'add instructions']);
        git(dir, ['rm', '-q', 'AGENTS.md']);
        const repo = openRepo(dir);
        const head = git(dir, ['rev-parse', 'HEAD']);

        assert.ok(scanGitTarget(repo, {
            kind: 'staged', explicitProfile: 'strict',
        }).findings.some((finding) => finding.ruleId === 'generic.agent-instructions'));

        const tombstone = {
            target: 'AGENTS.md',
            scope: 'reviewed-instruction',
            head,
            transition: 'staged',
            newObjectId: null,
            newMode: null,
        };
        saveOverrides(repo.stateDir, { allow: [tombstone], deny: [] });
        assert.equal(scanGitTarget(repo, {
            kind: 'staged', explicitProfile: 'strict',
        }).findings.some((finding) => finding.ruleId === 'generic.agent-instructions'), false);

        saveOverrides(repo.stateDir, {
            allow: [tombstone],
            deny: [{ target: 'generic.agent-instructions', scope: 'rule' }],
        });
        assert.ok(scanGitTarget(repo, {
            kind: 'staged', explicitProfile: 'strict',
        }).findings.some((finding) => finding.ruleId === 'generic.agent-instructions'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('range syntax rejects missing and extra endpoints', () => {
    assert.deepEqual(parseHistoryRange('main...feature'), { base: 'main', operator: '...', head: 'feature' });
    assert.throws(() => parseHistoryRange('HEAD'), /both endpoints/);
    assert.throws(() => parseHistoryRange('a..b..c'), /both endpoints/);
});
