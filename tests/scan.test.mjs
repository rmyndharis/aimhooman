import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newEngine, newEngineWithDiagnostics } from '../src/scan.mjs';
import { globToRegExp, loadRules, loadRulesWithDiagnostics, RulePackError } from '../src/rules.mjs';

test('flags a Claude session file, ignores normal source', () => {
    const f = newEngine('clean').checkPaths(['.claude/session.json', 'src/main.js']);
    assert.equal(f.length, 1);
    assert.equal(f[0].decision, 'block');
    assert.equal(f[0].source, 'builtin');
});

test('flags .env but allows .env.example', () => {
    const f = newEngine('clean').checkPaths(['.env', '.env.example']);
    assert.equal(f.length, 1);
    assert.equal(f[0].path, '.env');
});

test('AGENTS.md is review on clean, block on strict', () => {
    assert.equal(newEngine('clean').checkPaths(['AGENTS.md'])[0].decision, 'review');
    assert.equal(newEngine('strict').checkPaths(['AGENTS.md'])[0].decision, 'block');
});

test('attribution: AI co-author blocked, human co-author allowed', () => {
    const e = newEngine('clean');
    const ai = e.checkMessage('Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>\n');
    assert.ok(ai.length >= 1 && ai[0].decision === 'block');
    const human = e.checkMessage('Add feature\n\nCo-authored-by: Dewi <dewi@example.com>\n');
    assert.equal(human.length, 0);
});

test('content marker: block on strict, review on clean', () => {
    const marker = ['// pony' + 'tail:', 'hack'].join(' ') + '\n';
    assert.equal(newEngine('strict').checkContent('x.js', marker)[0].decision, 'block');
    assert.equal(newEngine('clean').checkContent('x.js', marker)[0].decision, 'review');
});

test('allow override suppresses, deny override escalates', () => {
    const a = newEngine('clean');
    a.setOverrides(['.claude/session.json'], []);
    assert.equal(a.checkPaths(['.claude/session.json']).length, 0);

    const d = newEngine('clean');
    d.setOverrides([], ['generic.agent-instructions']);
    assert.equal(d.checkPaths(['AGENTS.md'])[0].decision, 'block');
});

test('legacy object overrides infer rule IDs without changing path semantics', () => {
    // A secret rule cannot be blanket-allowed at rule scope (that would mask
    // every matching secret path under every profile); it requires an explicit
    // --scope secret-path override on the specific path.
    const allowedRule = newEngine('clean');
    allowedRule.setOverrides([{ target: 'secret.dotenv' }], []);
    assert.equal(allowedRule.checkPaths(['.env'])[0].decision, 'block');

    const allowedSecretPath = newEngine('clean');
    allowedSecretPath.setOverrides([{ target: '.env', scope: 'secret-path' }], []);
    assert.equal(allowedSecretPath.checkPaths(['.env']).length, 0);

    const deniedRule = newEngine('clean');
    deniedRule.setOverrides([], [{ target: 'generic.agent-instructions' }]);
    assert.equal(deniedRule.checkPaths(['AGENTS.md'])[0]?.decision, 'block');

    const allowedPath = newEngine('clean');
    allowedPath.setOverrides([{ target: '.claude/session.json' }], []);
    assert.equal(allowedPath.checkPaths(['.claude/session.json']).length, 0);
});

test('fixMessage strips attribution, keeps real content', () => {
    const { cleaned, removed } = newEngine('clean').fixMessage(
        'Add feature\n\nReal detail\nCo-authored-by: Claude <noreply@anthropic.com>\n'
    );
    assert.ok(removed.length >= 1);
    assert.ok(!/anthropic/i.test(cleaned));
    assert.ok(/Add feature/.test(cleaned) && /Real detail/.test(cleaned));
});

test('attribution.ai-noreply: prose mention is kept, trailer still flagged', () => {
    const e = newEngine('clean');
    // prose line mentioning the noreply email must NOT be flagged/stripped
    const prose = 'Fix bug\n\nReport abuse to noreply@anthropic.com if you see it.\n';
    assert.equal(e.checkMessage(prose).length, 0);
    const kept = e.fixMessage(prose);
    assert.equal(kept.removed.length, 0);
    assert.ok(/Report abuse/.test(kept.cleaned));
    // ...but a Co-authored-by trailer with the noreply email IS flagged
    const trailer = 'Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>\n';
    assert.ok(e.checkMessage(trailer).length >= 1);
    const stripped = e.fixMessage(trailer);
    assert.ok(stripped.removed.length >= 1);
    assert.ok(!/noreply@anthropic\.com/.test(stripped.cleaned));
});

test('path glob matcher preserves wildcard and character-class behavior', () => {
    // git pathspec supports [abc] and [a-z]; a literal translation would only
    // match the string "[0-9]" and silently miss real files.
    const re = globToRegExp('config[0-9].json');
    assert.equal(re.test('config5.json'), true);
    assert.equal(re.test('configX.json'), false);

    const negated = globToRegExp('env[!.]old');
    assert.equal(negated.test('envZold'), true);
    assert.equal(negated.test('env.old'), false);

    const nested = globToRegExp('**/docs/**');
    assert.equal(nested.test('docs/readme.md'), true);
    assert.equal(nested.test('packages/app/docs/readme.md'), true);
    assert.equal(nested.test('packages/app/readme.md'), false);

    const segment = globToRegExp('src/*.mjs');
    assert.equal(segment.test('src/index.mjs'), true);
    assert.equal(segment.test('src/nested/index.mjs'), false);

    // POSIX [] member: a ] right after [ is a literal member, not the closer.
    const bracket = globToRegExp('file[]x].bin');
    assert.equal(bracket.test('file].bin'), true);
    assert.equal(bracket.test('filex.bin'), true);
    assert.equal(bracket.test('filey.bin'), false);

    // A class body containing a backslash must not throw an unterminated
    // RegExp (it previously rejected the whole local pack).
    const noThrow = globToRegExp('dir[\\x].bin'); // class members: backslash, x
    assert.equal(noThrow.test('dirx.bin'), true);
    assert.equal(noThrow.test('dir\\.bin'), true); // backslash member
    assert.equal(noThrow.test('diry.bin'), false);
});

test('local path globs with repeated wildcards have bounded match cost', () => {
    const dir = localRulesDir();
    writeFileSync(join(dir, 'rules/bounded.json'), JSON.stringify([
        pathRule('local.bounded-glob', `${'*a'.repeat(8)}b`),
    ]));
    try {
        const engine = newEngine('clean', dir);
        const started = performance.now();
        assert.equal(engine.checkPaths(['a'.repeat(48)]).length, 0);
        const duration = performance.now() - started;
        assert.ok(duration < 1_000, `path glob match took ${duration.toFixed(1)} ms`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('compliance profile keeps required AI disclosure', () => {
    const coauthor = 'Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>\n';
    const generated = 'Fix bug\n\nGenerated with Claude Code\n';
    // clean and strict treat AI attribution as a violation...
    assert.equal(newEngine('clean').checkMessage(coauthor)[0].decision, 'block');
    assert.equal(newEngine('strict').checkMessage(coauthor)[0].decision, 'block');
    // ...but compliance must keep it (no finding => disclosure preserved).
    assert.equal(newEngine('compliance').checkMessage(coauthor).length, 0);
    assert.equal(newEngine('compliance').checkMessage(generated).length, 0);
});

test('catalog: new AI-tool residue paths are blocked/flagged', () => {
    const e = newEngine('clean');
    assert.equal(e.checkPaths(['.playwright-mcp/trace.json'])[0]?.decision, 'block');
    assert.equal(e.checkPaths(['sub/.remember/note.json'])[0]?.decision, 'block');
    assert.equal(e.checkPaths(['.superpowers/state.json'])[0]?.decision, 'block');
    assert.equal(e.checkPaths(['.agent/x.json'])[0]?.decision, 'block');
    assert.equal(newEngine('strict').checkPaths(['.agent/x.json'])[0]?.decision, 'block');
    assert.equal(e.checkPaths(['.copilot/session-42.json'])[0]?.decision, 'block');
    assert.equal(e.checkPaths(['.copilot/config.json'])[0]?.decision, 'block');
    assert.equal(e.checkPaths(['copilot/config.json']).length, 0);
    assert.equal(e.checkPaths(['.agents/rules/project.md']).length, 0);
});

test('local rules: a user rule pack in stateDir is loaded and detects a custom path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aim-local-'));
    const rulesDir = join(dir, 'rules');
    mkdirSync(rulesDir);
    writeFileSync(join(rulesDir, 'mine.json'), JSON.stringify([{
        id: 'mine.plans', version: 1, provider: 'generic', category: 'project',
        confidence: 'medium', kind: 'path',
        match: { paths: ['docs/plans/**'] },
        actions: { clean: 'block', strict: 'block', compliance: 'block' },
        reason: 'local convention', remediation: ['git restore --staged <path>'],
    }]));
    try {
        const e = newEngine('clean', dir);
        const finding = e.checkPaths(['docs/plans/x.md'])[0];
        assert.equal(finding?.decision, 'block');
        assert.equal(finding?.source, 'local');
        // local can only ADD — a core block still wins (first-match), local can't weaken it
        assert.equal(e.checkPaths(['.claude/session.json'])[0]?.decision, 'block');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

function localRulesDir() {
    const dir = mkdtempSync(join(tmpdir(), 'aim-local-'));
    mkdirSync(join(dir, 'rules'));
    return dir;
}

function pathRule(id, path = 'local/**') {
    return {
        id, version: 1, provider: 'local', category: 'custom', confidence: 'medium', kind: 'path',
        match: { paths: [path] },
        actions: { clean: 'block', strict: 'block', compliance: 'block' },
        reason: 'local convention',
    };
}

test('local rule loader reports invalid JSON context and compatibility API throws', () => {
    const dir = localRulesDir();
    writeFileSync(join(dir, 'rules/broken.json'), '{ not json');
    writeFileSync(join(dir, 'rules/good.json'), JSON.stringify([pathRule('local.survives', 'survives/**')]));
    try {
        const result = loadRulesWithDiagnostics(dir);
        assert.ok(result.rules.length >= 24);
        assert.ok(result.rules.some((rule) => rule.id === 'local.survives'));
        assert.equal(result.errors.length, 1);
        assert.ok(result.errors[0] instanceof RulePackError);
        assert.equal(result.errors[0].source, 'local');
        assert.equal(result.errors[0].code, 'INVALID_JSON');
        assert.match(result.errors[0].message, /local rule pack .*broken\.json.*invalid JSON/);
        assert.throws(() => loadRules(dir), /local rule pack .*broken\.json.*invalid JSON/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local rule loader rejects invalid regex with rule and pack context', () => {
    const dir = localRulesDir();
    const rule = {
        id: 'local.bad-regex', version: 1, provider: 'local', category: 'custom', kind: 'message',
        match: { content: ['[unterminated'] }, actions: { clean: 'block' }, reason: 'test',
    };
    writeFileSync(join(dir, 'rules/regex.json'), JSON.stringify([rule]));
    try {
        const { errors } = loadRulesWithDiagnostics(dir);
        assert.equal(errors[0]?.code, 'INVALID_REGEX');
        assert.match(errors[0]?.message, /regex\.json.*local\.bad-regex.*invalid pattern/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rule loader validates pack and rule schema', () => {
    const dir = localRulesDir();
    writeFileSync(join(dir, 'rules/not-array.json'), JSON.stringify({ rules: [] }));
    writeFileSync(join(dir, 'rules/wrong-kind.json'), JSON.stringify([{ ...pathRule('local.wrong'), kind: 'unknown' }]));
    try {
        const { errors } = loadRulesWithDiagnostics(dir);
        assert.equal(errors.length, 2);
        assert.ok(errors.every((error) => error.code === 'INVALID_SCHEMA'));
        assert.match(errors[0].message, /pack must be a JSON array/);
        assert.match(errors[1].message, /kind must be one of/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local rule loader caps path glob count, length, and total size', () => {
    const dir = localRulesDir();
    writeFileSync(join(dir, 'rules/count.json'), JSON.stringify([{
        ...pathRule('local.too-many-globs'),
        match: { paths: Array.from({ length: 33 }, (_, index) => `path-${index}`) },
    }]));
    writeFileSync(join(dir, 'rules/length.json'), JSON.stringify([
        pathRule('local.long-glob', 'a'.repeat(513)),
    ]));
    writeFileSync(join(dir, 'rules/total.json'), JSON.stringify([{
        ...pathRule('local.large-glob-set'),
        match: { paths: Array.from({ length: 9 }, (_, index) => `${index}${'a'.repeat(499)}`) },
    }]));
    try {
        const { errors } = loadRulesWithDiagnostics(dir);
        assert.equal(errors.length, 3);
        assert.ok(errors.every((error) => error.code === 'INVALID_SCHEMA'));
        assert.ok(errors.some((error) => /at most 32 local globs/.test(error.message)));
        assert.ok(errors.some((error) => /at most 512 characters/.test(error.message)));
        assert.ok(errors.some((error) => /4096-character local limit/.test(error.message)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('duplicate rule IDs reject the entire local pack', () => {
    const dir = localRulesDir();
    writeFileSync(join(dir, 'rules/duplicate.json'), JSON.stringify([
        pathRule('local.unique', 'unique/**'),
        pathRule('secret.dotenv', 'shadow/**'),
    ]));
    try {
        const { engine, errors } = newEngineWithDiagnostics('clean', dir);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 'DUPLICATE_RULE_ID');
        assert.match(errors[0].message, /duplicate rule id "secret\.dotenv"/);
        // Pack loading is atomic: its otherwise-valid first rule is not retained.
        assert.equal(engine.checkPaths(['unique/file']).length, 0);
        assert.equal(engine.checkPaths(['.env'])[0]?.source, 'builtin');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixMessage reports but does not remove review-only local message findings', () => {
    const dir = localRulesDir();
    const rule = {
        id: 'local.review-message', version: 1, provider: 'local', category: 'custom', kind: 'message',
        match: { content: ['^Needs human review$'] }, actions: { clean: 'review' }, reason: 'review it',
    };
    writeFileSync(join(dir, 'rules/review.json'), JSON.stringify([rule]));
    try {
        const engine = newEngine('clean', dir);
        const text = 'Subject\n\nNeeds human review\n';
        const findings = engine.checkMessage(text);
        assert.equal(findings[0]?.decision, 'review');
        assert.equal(findings[0]?.source, 'local');
        const fixed = engine.fixMessage(text);
        assert.equal(fixed.cleaned, text);
        assert.deepEqual(fixed.removed, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
