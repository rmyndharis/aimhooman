import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepo, trackedEntries } from '../src/gitx.mjs';
import { newEngine } from '../src/scan.mjs';
import { scanEntries } from '../src/scan-session.mjs';

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'aim-session-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'one.txt'), 'AI-generated output\n');
    writeFileSync(join(dir, 'two.txt'), 'AI-generated output\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    return dir;
}

test('content scan reads duplicate objects once and reports every path', () => {
    const dir = fixture();
    try {
        const repo = openRepo(dir);
        const result = scanEntries(repo, newEngine('strict'), trackedEntries(repo));
        assert.equal(result.complete, true);
        assert.equal(result.stats.objects_read, 1);
        assert.equal(result.stats.files_scanned, 2);
        assert.deepEqual(result.findings.map((finding) => finding.path).sort(), ['one.txt', 'two.txt']);
        assert.equal(result.findings.every((finding) => finding.objectId), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('content scan makes size and total budgets visible', () => {
    const dir = fixture();
    try {
        const repo = openRepo(dir);
        const result = scanEntries(repo, newEngine('strict'), trackedEntries(repo), {
            maxFileBytes: 4,
            maxTotalBytes: 4,
        });
        assert.equal(result.complete, false);
        assert.equal(result.stats.skipped['size-limit'], 2);
        assert.equal(result.stats.files_scanned, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('binary blobs consume the cumulative byte budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-session-binary-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
        writeFileSync(join(dir, 'one.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
        writeFileSync(join(dir, 'two.bin'), Buffer.from([0, 6, 7, 8, 9, 10]));
        execFileSync('git', ['add', '.'], { cwd: dir });

        const repo = openRepo(dir);
        const complete = scanEntries(repo, newEngine('strict'), trackedEntries(repo), {
            maxFileBytes: 10,
            maxTotalBytes: 12,
        });
        assert.equal(complete.complete, true);
        assert.equal(complete.stats.bytes_scanned, 12);
        assert.equal(complete.stats.skipped.binary, 2);

        const result = scanEntries(repo, newEngine('strict'), trackedEntries(repo), {
            maxFileBytes: 10,
            maxTotalBytes: 6,
        });
        assert.equal(result.complete, false);
        assert.equal(result.stats.bytes_scanned, 6);
        assert.equal(result.stats.files_scanned, 0);
        assert.equal(result.stats.skipped.binary, 1);
        assert.equal(result.stats.skipped['total-byte-limit'], 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('NUL-classified blobs still run every secret signature in every profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-session-binary-secret-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
        const privateHeader = '-----BE' + 'GIN PRIVATE KEY-----';
        const serviceAccount = `{"private_key":"${privateHeader}\\nmaterial"}`;
        const awsCredential = `aws_secret_access_key = ${'a'.repeat(40)}`;
        const providerToken = `ghp_${'a'.repeat(36)}`;
        const fixtures = [
            ['ordinary-0.dat', Buffer.concat([Buffer.from([0]), Buffer.from(privateHeader)])],
            ['ordinary-1.dat', Buffer.concat([Buffer.from('x'.repeat(4000)), Buffer.from([0]), Buffer.from(privateHeader)])],
            ['ordinary-2.dat', Buffer.concat([Buffer.from('x'.repeat(7999)), Buffer.from([0]), Buffer.from(privateHeader)])],
            ['ordinary-3.dat', Buffer.concat([Buffer.from([0]), Buffer.from(serviceAccount)])],
            ['ordinary-4.dat', Buffer.concat([Buffer.from([0]), Buffer.from(awsCredential)])],
            ['ordinary-5.dat', Buffer.concat([Buffer.from([0]), Buffer.from(providerToken)])],
            ['.ENV', Buffer.concat([Buffer.from([0]), Buffer.from(providerToken)])],
        ];
        fixtures.forEach(([path, content]) => writeFileSync(join(dir, path), content));
        execFileSync('git', ['add', '-f', '.'], { cwd: dir });

        const repo = openRepo(dir);
        for (const profile of ['clean', 'strict', 'compliance']) {
            const result = scanEntries(repo, newEngine(profile), trackedEntries(repo));
            assert.equal(result.complete, true, profile);
            assert.equal(result.stats.skipped.binary, fixtures.length, profile);
            assert.equal(result.stats.files_scanned, 0, profile);
            assert.equal(result.findings.length, fixtures.length, profile);
            assert.equal(result.findings.filter((finding) => (
                finding.matchedRuleIds.includes('secret.private-key-content')
            )).length, 4, profile);
            assert.equal(result.findings.some((finding) => (
                finding.matchedRuleIds.includes('secret.service-account-key')
            )), true, profile);
            assert.equal(result.findings.some((finding) => (
                finding.matchedRuleIds.includes('secret.aws-key-content')
            )), true, profile);
            assert.equal(result.findings.some((finding) => (
                finding.matchedRuleIds.includes('secret.provider-token')
            )), true, profile);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
