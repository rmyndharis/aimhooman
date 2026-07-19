import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { human, jsonReport, exitCode } from '../src/report.mjs';
import { openRepo } from '../src/gitx.mjs';
import { scanMessage } from '../src/scan-target.mjs';

const secretFinding = {
    ruleId: 'local.secret',
    ruleVersion: 1,
    matchedRuleIds: ['local.secret'],
    matchedRules: [{
        ruleId: 'local.secret',
        ruleVersion: 1,
        kind: 'code',
        category: 'secret',
        provider: 'local',
        confidence: 'high',
        decision: 'block',
        reason: 'secret-like content',
        remediation: ['remove the value'],
        source: 'local',
    }],
    kind: 'code',
    category: 'secret',
    provider: 'local',
    confidence: 'high',
    decision: 'block',
    reason: 'secret-like content',
    remediation: ['remove the value'],
    source: 'local',
    path: 'config.txt',
    line: 7,
    text: 'TOKEN=do-not-print',
    scanProfile: 'strict',
    policySource: 'explicit-strict',
    policyObjectId: null,
};

function resolveSchema(schema, root) {
    if (!schema.$ref) return schema;
    assert.match(schema.$ref, /^#\//);
    return schema.$ref.slice(2).split('/').reduce((value, key) => value[key], root);
}

function assertSchemaValue(rawSchema, value, root, path = '$') {
    const schema = resolveSchema(rawSchema, root);
    if (schema.anyOf) {
        const errors = [];
        for (const candidate of schema.anyOf) {
            try {
                assertSchemaValue(candidate, value, root, path);
                return;
            } catch (error) {
                errors.push(error);
            }
        }
        assert.fail(`${path} did not match any allowed schema: ${errors.map((error) => error.message).join('; ')}`);
    }
    if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${path} has the wrong constant value`);
    if (schema.enum) assert.ok(schema.enum.includes(value), `${path} has an unsupported value`);
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.length) {
        const actual = value === null ? 'null'
            : Array.isArray(value) ? 'array'
                : Number.isInteger(value) ? 'integer' : typeof value;
        assert.ok(types.includes(actual), `${path} must be ${types.join(' or ')}, got ${actual}`);
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${path} is too short`);
        if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${path} does not match its pattern`);
    }
    if (typeof value === 'number' && schema.minimum !== undefined) {
        assert.ok(value >= schema.minimum, `${path} is below its minimum`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path} has too few items`);
        if (schema.uniqueItems) {
            assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${path} has duplicate items`);
        }
        if (schema.items) value.forEach((item, index) => assertSchemaValue(schema.items, item, root, `${path}[${index}]`));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const key of schema.required || []) {
            assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
        }
        for (const [key, item] of Object.entries(value)) {
            if (schema.properties?.[key]) {
                assertSchemaValue(schema.properties[key], item, root, `${path}.${key}`);
            } else if (schema.additionalProperties === false) {
                assert.fail(`${path}.${key} is not declared in the schema`);
            } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                assertSchemaValue(schema.additionalProperties, item, root, `${path}.${key}`);
            }
        }
    }
}

test('exitCode: a block wins over an incomplete scan and over review', () => {
    const block = { decision: 'block' };
    const review = { decision: 'review' };
    assert.equal(exitCode([block], 'clean', false), 10);
    assert.equal(exitCode([block], 'strict', false), 10);
    assert.equal(exitCode([block, review], 'strict', true), 10);
    assert.equal(exitCode([block, review], 'clean', false), 10);
});

test('exitCode: an incomplete scan stops at 31 only on strict or the final boundary', () => {
    const review = { decision: 'review' };
    assert.equal(exitCode([], 'clean', false), 0);
    assert.equal(exitCode([], 'compliance', false), 0);
    assert.equal(exitCode([], 'strict', false), 31);
    assert.equal(exitCode([review], 'clean', false), 0);
    assert.equal(exitCode([review], 'strict', false), 31);
    // failClosedIncomplete keeps the reference-transaction guard vetoing an
    // unchecked remainder on every profile.
    assert.equal(exitCode([], 'clean', false, { failClosedIncomplete: true }), 31);
    assert.equal(exitCode([], 'compliance', false, { failClosedIncomplete: true }), 31);
    assert.equal(exitCode([review], 'compliance', false, { failClosedIncomplete: true }), 31);
});

test('exitCode: review becomes 11 only off clean, even when the scan is incomplete', () => {
    const review = { decision: 'review' };
    assert.equal(exitCode([review], 'strict', true), 11);
    assert.equal(exitCode([review], 'compliance', true), 11);
    assert.equal(exitCode([review], 'clean', true), 0);
    // Incomplete no longer masks the review exit on compliance; strict still
    // stops at 31 first.
    assert.equal(exitCode([review], 'compliance', false), 11);
    // A finding's own scanProfile stricter than the report profile still surfaces.
    assert.equal(exitCode([{ decision: 'review', scanProfile: 'strict' }], 'clean', true), 11);
    // A finding whose scanProfile is clean does not escalate under a strict report.
    assert.equal(exitCode([{ decision: 'review', scanProfile: 'clean' }], 'strict', true), 0);
});

test('exitCode: a clean scan exits 0 on every profile', () => {
    assert.equal(exitCode([], 'clean', true), 0);
    assert.equal(exitCode([], 'strict', true), 0);
    assert.equal(exitCode([], 'compliance', true), 0);
});

test('human report includes content line numbers and redacts secret text', () => {
    const report = human([secretFinding], 'professional');
    assert.match(report, /config\.txt:7/);
    assert.match(report, /\[redacted\]/);
    assert.doesNotMatch(report, /do-not-print/);
});

test('human report escapes control characters in paths', () => {
    const nonSecret = {
        ...secretFinding,
        category: 'review',
        matchedRules: secretFinding.matchedRules.map((match) => ({ ...match, category: 'review' })),
    };
    const report = human([{ ...nonSecret, path: 'odd\nname', text: 'tab\ttext' }], 'professional');
    assert.match(report, /odd\\nname:7/);
    assert.match(report, /tab\\ttext/);
    // The \r arm and the generic hex-escape arm (e.g. BEL, DEL) are also escaped.
    const cr = human([{ ...nonSecret, path: 'weird\rname', text: 'bell\x07end\x7f' }], 'professional');
    assert.match(cr, /weird\\rname/);
    assert.match(cr, /bell\\x07end\\x7f/);
});

// W6: only remediation[0] used to render, so a rule whose remediation array
// carried a second line (e.g. "rotate the key if it was ever exposed") lost it
// silently. The whole array now renders, one `fix:` line per entry.
test('human report renders every remediation entry, not just the first', () => {
    const finding = {
        ...secretFinding,
        remediation: ['remove the value', 'rotate the key if it was ever exposed', 'use the secret store'],
    };
    const report = human([finding], 'professional');
    assert.match(report, /fix: remove the value/);
    assert.match(report, /fix: rotate the key if it was ever exposed/);
    assert.match(report, /fix: use the secret store/);
    const fixLines = report.split('\n').filter((line) => line.startsWith('       fix:'));
    assert.equal(fixLines.length, 3, `expected 3 fix lines, got ${fixLines.length}`);
});

// W7: the summary line was always "findings" even for a single finding, and the
// block/review nouns did not agree either. Singular/plural now applied to all
// three counts.
test('human report summary line agrees on number for one vs many findings', () => {
    const one = human([secretFinding], 'professional');
    assert.match(one, /1 finding: 1 block, 0 reviews/);
    const reviewFinding = {
        ...secretFinding,
        decision: 'review',
        matchedRules: secretFinding.matchedRules.map((match) => ({ ...match, decision: 'review' })),
    };
    const two = human([secretFinding, reviewFinding], 'professional');
    assert.match(two, /2 findings: 1 block, 1 review/);
});

// W8: a scan that fires many findings (a vendored OpenSSL corpus can produce 99)
// used to emit hundreds of near-identical stderr lines with no truncation
// marker. The human report now caps the printed blocks and collapses the rest
// into one summary line; the JSON report is never capped.
test('human report caps printed findings and signals truncation; JSON is uncapped', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
        ...secretFinding,
        path: `file${i}.txt`,
        line: i + 1,
    }));
    const report = human(many, 'professional');
    // The cap is 20, so 10 findings are hidden behind a single truncation line.
    assert.match(report, /… and 10 more findings \(run 'aimhooman review' for the full list\)/);
    // The full count is still reported in the summary.
    assert.match(report, /30 findings:/);
    // Only the first 20 paths are printed; file25.txt (index 25) is beyond the cap.
    assert.doesNotMatch(report, /file25\.txt/);
    assert.match(report, /file19\.txt/);
    // The JSON report carries all 30 findings uncapped.
    const json = jsonReport(many);
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings.length, 30);
});

// UT-08: a repeated rule (20 hits of the same secret rule) used to reprint the
// identical fix block for every finding. The full remediation now renders on
// the first finding of a rule; later findings of the same rule point back.
test('human report prints a repeated rule remediation once, not per finding', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
        ...secretFinding,
        path: `key${i}.txt`,
        line: i + 1,
    }));
    const report = human(many, 'professional');
    const full = report.split('\n').filter((line) => line === '       fix: remove the value');
    assert.equal(full.length, 1, `expected the fix once, got ${full.length}`);
    const pointers = report.split('\n').filter((line) => line === '       fix: as above for local.secret');
    assert.equal(pointers.length, 4, `expected 4 back-pointers, got ${pointers.length}`);
    // Every finding location still shows, first to last.
    assert.match(report, /key0\.txt:1/);
    assert.match(report, /key4\.txt:5/);
});

test('human report keeps full remediation for distinct rules', () => {
    const other = {
        ...secretFinding,
        ruleId: 'local.other',
        matchedRuleIds: ['local.other'],
        remediation: ['do the other thing'],
    };
    const report = human([secretFinding, other, { ...secretFinding, path: 'again.txt' }], 'professional');
    assert.match(report, /fix: remove the value/);
    assert.match(report, /fix: do the other thing/);
    // Only the genuinely repeated rule collapses.
    const pointers = report.split('\n').filter((line) => line.includes('fix: as above for'));
    assert.equal(pointers.length, 1);
    assert.match(pointers[0], /local\.secret/);
});

// Field test F-4: the "not very hooman." banner used to fire on pure advisories
// (review findings only, the commit proceeds), which wore the signal out. It now
// appears only when at least one finding blocks the operation.
test('human report shows the banner only when a finding blocks', () => {
    const reviewFinding = {
        ...secretFinding,
        category: 'review',
        decision: 'review',
        matchedRules: secretFinding.matchedRules.map((match) => ({ ...match, category: 'review', decision: 'review' })),
    };
    const advisory = human([reviewFinding], 'playful');
    assert.doesNotMatch(advisory, /not very hooman\./);
    assert.match(advisory, /REVIEW/);
    const stopped = human([secretFinding], 'playful');
    assert.match(stopped, /not very hooman\./);
    const mixed = human([reviewFinding, secretFinding], 'playful');
    assert.match(mixed, /not very hooman\./);
    // Professional tone never prints the banner, blocked or not.
    assert.doesNotMatch(human([secretFinding], 'professional'), /not very hooman\./);
});

test('JSON report includes metadata and redacts secret text', () => {
    const metadata = {
        tool_version: '0.1.0-rc.1',
        target: 'staged',
        profile: 'strict',
        policy_source: 'explicit-strict',
        policy_object_id: null,
        complete: true,
        stats: {
            entries: 1,
            blob_files: 1,
            objects_read: 1,
            files_scanned: 1,
            bytes_scanned: 19,
            findings_total: 1,
            findings_returned: 1,
            skipped: {},
            skippedPaths: {},
        },
        message_scanned: false,
    };
    const report = JSON.parse(jsonReport([secretFinding], metadata));
    assert.equal(report.schema_version, 1);
    assert.equal(report.profile, 'strict');
    assert.equal(report.target, 'staged');
    assert.equal(report.findings[0].text, '[redacted]');

    const schema = JSON.parse(readFileSync(
        join(import.meta.dirname, '..', 'schemas', 'scan-report.schema.json'),
        'utf8',
    ));
    assertSchemaValue(schema, report, schema);
});

test('reporters redact when any contributing rule is secret, regardless of the primary rule', () => {
    const sentinel = 'REAL_SECRET_MATERIAL';
    const marker = {
        ...secretFinding,
        ruleId: 'marker.corner-cut',
        matchedRuleIds: ['marker.corner-cut', 'local.secret'],
        matchedRules: [{
            ruleId: 'marker.corner-cut',
            ruleVersion: 1,
            kind: 'code',
            category: 'ai-marker',
            provider: 'generic',
            confidence: 'medium',
            decision: 'block',
            reason: 'marker',
            remediation: [],
            source: 'builtin',
        }, {
            ...secretFinding.matchedRules[0],
            decision: 'allow',
        }],
        category: 'ai-marker',
        provider: 'generic',
        text: sentinel,
    };
    const humanOutput = human([marker], 'professional');
    const jsonOutput = jsonReport([marker]);
    assert.match(humanOutput, /\[redacted\]/);
    assert.match(jsonOutput, /\[redacted\]/);
    assert.doesNotMatch(humanOutput, new RegExp(sentinel));
    assert.doesNotMatch(jsonOutput, new RegExp(sentinel));
});

test('JSON report validates real scanMessage output (incl. autofix) against the schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-report-schema-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        const repo = openRepo(dir);
        const scan = scanMessage(
            repo,
            'Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>\n',
            { target: 'worktree', explicitProfile: 'strict' },
        );
        // Real engine output must carry the autofix field the schema declares.
        assert.ok(
            scan.findings.some((f) => f.autofix === 'remove-whole-line'),
            'expected an autofix finding from the attribution rule',
        );
        const metadata = {
            tool_version: '0.1.0',
            target: scan.target,
            profile: scan.profile,
            policy_source: scan.policy_source,
            policy_object_id: scan.policy_object_id,
            complete: scan.complete,
            stats: scan.stats,
            message_scanned: scan.message_scanned,
        };
        const report = JSON.parse(jsonReport(scan.findings, metadata));
        const schema = JSON.parse(readFileSync(
            join(import.meta.dirname, '..', 'schemas', 'scan-report.schema.json'),
            'utf8',
        ));
        // Catches drift: any field the real engine/decorate emits that the schema
        // does not declare (additionalProperties:false) fails here.
        assertSchemaValue(schema, report, schema);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
