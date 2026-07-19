import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newEngine, newEngineWithDiagnostics } from '../src/scan.mjs';

function stateWithRules(rules) {
    const dir = mkdtempSync(join(tmpdir(), 'aim-engine-'));
    mkdirSync(join(dir, 'rules'));
    writeFileSync(join(dir, 'rules/local.json'), JSON.stringify(rules));
    return dir;
}

function rule(id, kind, match, actions = { clean: 'block', strict: 'block', compliance: 'block' }) {
    return {
        id,
        version: 1,
        provider: 'local',
        category: 'custom',
        confidence: 'medium',
        kind,
        match,
        actions,
        reason: `${id} matched`,
    };
}

test('matching rules reduce to one order-independent path decision', () => {
    const dir = stateWithRules([
        rule('local.instructions-block', 'path', { paths: ['AGENTS.md'] }),
        rule('local.instructions-review', 'path', { paths: ['AGENTS.md'] }, {
            clean: 'review', strict: 'review', compliance: 'review',
        }),
    ]);
    try {
        const engine = newEngine('clean', dir);
        const forward = engine.checkPaths(['./AGENTS.md', 'AGENTS.md']);
        assert.equal(forward.length, 1);
        assert.equal(forward[0].decision, 'block');
        assert.equal(forward[0].ruleId, 'local.instructions-block');
        assert.deepEqual(forward[0].matchedRuleIds, [
            'generic.agent-instructions',
            'local.instructions-block',
            'local.instructions-review',
        ]);

        engine.rules.reverse();
        const reversed = engine.checkPaths(['AGENTS.md']);
        assert.deepEqual(reversed, forward);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rule allow affects only that match and a deny still wins', () => {
    const dir = stateWithRules([
        rule('local.session-state', 'path', { paths: ['.claude/session.json'] }),
    ]);
    try {
        const engine = newEngine('clean', dir);
        engine.setOverrides(['local.session-state'], []);
        const allowed = engine.checkPaths(['.claude/session.json']);
        assert.equal(allowed[0]?.decision, 'block');
        assert.equal(allowed[0]?.ruleId, 'claude.session-state');
        assert.deepEqual(allowed[0]?.matchedRuleIds, ['claude.session-state', 'local.session-state']);

        engine.setOverrides(['.claude/session.json'], ['local.session-state']);
        const denied = engine.checkPaths(['.claude/session.json']);
        assert.equal(denied[0]?.decision, 'block');
        assert.equal(denied[0]?.ruleId, 'local.session-state');
        assert.equal(
            denied[0]?.matchedRules.find((match) => match.ruleId === 'claude.session-state')?.decision,
            'allow',
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('override scopes distinguish paths, rules, and unmatched path denies', () => {
    const engine = newEngine('clean');
    engine.setOverrides([{ target: '.claude/session.json', scope: 'path' }], []);
    assert.deepEqual(engine.checkPaths(['.claude/session.json']), []);

    engine.setOverrides([], [{ target: 'blocked.txt', scope: 'path' }]);
    assert.equal(engine.checkPaths(['blocked.txt'])[0]?.ruleId, 'override.path-deny');

    engine.setOverrides([], [{ target: 'generic.agent-instructions', scope: 'path' }]);
    assert.equal(engine.checkPaths(['AGENTS.md'])[0]?.decision, 'review');
    assert.equal(engine.checkPaths(['generic.agent-instructions'])[0]?.ruleId, 'override.path-deny');

    engine.setOverrides([], [{ target: 'generic.agent-instructions', scope: 'rule' }]);
    assert.equal(engine.checkPaths(['AGENTS.md'])[0]?.decision, 'block');
    assert.deepEqual(engine.checkPaths(['generic.agent-instructions']), []);
});

// Built-in secret scanning is gone, but a local pack can still declare
// category "secret" (its findings stay redacted in reports). Such a rule is
// the operator's own policy, so the ordinary override scopes apply to it.
test('a local secret-category rule follows the ordinary override scopes', () => {
    const dir = stateWithRules([{
        ...rule('local.acme-token', 'code', { content: ['acme-token'] }),
        category: 'secret',
    }]);
    try {
        const engine = newEngine('clean', dir);
        assert.equal(engine.checkContent('app.js', 'const t = "acme-token"')[0]?.category, 'secret');

        engine.setOverrides([{ target: 'app.js', scope: 'path' }], []);
        assert.deepEqual(engine.checkContent('app.js', 'const t = "acme-token"'), []);

        engine.setOverrides([{ target: 'local.acme-token', scope: 'rule' }], []);
        assert.deepEqual(engine.checkContent('app.js', 'const t = "acme-token"'), []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('review-scoped allows require the exact reviewed blob object', () => {
    const engine = newEngine('strict');
    const reviewed = 'a'.repeat(40);
    const transition = 'c'.repeat(40);
    engine.setOverrides([], [], [{
        target: 'AGENTS.md',
        ruleId: 'generic.agent-instructions',
        transition,
        newObjectId: reviewed,
        newMode: '100644',
    }]);

    assert.equal(engine.checkPaths(['AGENTS.md'])[0]?.decision, 'block');
    assert.equal(
        engine.checkPaths(['AGENTS.md'], {
            transition, objectId: 'b'.repeat(40), mode: '100644',
        })[0]?.decision,
        'block',
    );
    assert.equal(
        engine.checkPaths(['AGENTS.md'], {
            transition: 'd'.repeat(40), objectId: reviewed, mode: '100644',
        })[0]?.decision,
        'block',
    );
    assert.equal(
        engine.checkPaths(['AGENTS.md'], {
            transition, objectId: reviewed, mode: '120000',
        })[0]?.decision,
        'block',
    );
    assert.deepEqual(engine.checkPaths(['AGENTS.md'], {
        transition, objectId: reviewed, mode: '100644',
    }), []);
});

// W11 (F2): on clean/compliance, review is ADVISORY (a stderr message, exit 0),
// so re-surfacing it on every edit of a reviewed agent-instruction file is pure
// friction. A live-file review (newObjectId set) therefore persists per path +
// rule across edits on clean/compliance. Strict keeps the exact-OID binding (the
// test above). Tombstones keep the exact match in every profile.
test('review-scoped allows persist per path on clean/compliance, not strict (W11 hybrid)', () => {
    const reviewed = 'a'.repeat(40);
    const transition = 'c'.repeat(40);
    const entry = {
        target: 'AGENTS.md',
        ruleId: 'generic.agent-instructions',
        transition,
        newObjectId: reviewed,
        newMode: '100644',
    };
    const ctx = { transition, objectId: reviewed, mode: '100644' };

    // Strict: a changed blob is NOT covered — exact-OID binding holds.
    const strict = newEngine('strict');
    strict.setOverrides([], [], [entry]);
    assert.equal(
        strict.checkPaths(['AGENTS.md'], { ...ctx, objectId: 'b'.repeat(40) })[0]?.decision,
        'block',
        'strict keeps exact-OID binding — a changed blob must re-review',
    );

    // Clean/compliance: a changed blob IS covered — the advisory persists per path.
    for (const profile of ['clean', 'compliance']) {
        const engine = newEngine(profile);
        engine.setOverrides([], [], [entry]);
        assert.deepEqual(
            engine.checkPaths(['AGENTS.md'], { ...ctx, objectId: 'b'.repeat(40) }),
            [],
            `${profile}: a reviewed path suppresses the advisory across blob edits`,
        );
        assert.deepEqual(
            engine.checkPaths(['AGENTS.md'], { ...ctx, transition: 'd'.repeat(40) }),
            [],
            `${profile}: a reviewed path suppresses the advisory across transitions`,
        );
        // A DIFFERENT path is not covered — the match is path-specific. The
        // uncovered decision is the rule's base decision in this profile
        // (review for clean/compliance, block for strict).
        assert.equal(
            engine.checkPaths(['CLAUDE.md'], ctx)[0]?.decision,
            profile === 'strict' ? 'block' : 'review',
            `${profile}: a review for AGENTS.md does not cover a different path`,
        );
    }

    // Tombstone (reviewed deletion): exact match in every profile. A re-added
    // file (non-null blob) must NOT be covered by a deletion review.
    for (const profile of ['clean', 'compliance', 'strict']) {
        const engine = newEngine(profile);
        engine.setOverrides([], [], [{ ...entry, newObjectId: null, newMode: null }]);
        assert.equal(
            engine.checkPaths(['AGENTS.md'], { transition, objectId: 'b'.repeat(40), mode: '100644' })[0]?.decision,
            profile === 'strict' ? 'block' : 'review',
            `${profile}: a tombstone review does not cover a re-added file`,
        );
    }
});

test('a bound one-snapshot allow cannot override an explicit local deny', () => {
    const engine = newEngine('strict');
    const context = { transientAllowRules: new Set(['generic.project-policy']) };
    assert.deepEqual(engine.checkPaths(['.aimhooman.json'], context), []);

    engine.setOverrides([], [{ target: 'generic.project-policy', scope: 'rule' }]);
    assert.equal(
        engine.checkPaths(['.aimhooman.json'], context)[0]?.decision,
        'block',
    );
});

test('a reviewed tombstone requires an explicit exact transition and remains below deny', () => {
    const engine = newEngine('strict');
    const transition = 'e'.repeat(40);
    engine.setOverrides([], [], [{
        target: 'AGENTS.md',
        ruleId: 'generic.agent-instructions',
        transition,
        newObjectId: null,
        newMode: null,
    }]);

    assert.equal(engine.checkPaths(['AGENTS.md'])[0]?.decision, 'block');
    assert.equal(
        engine.checkPaths(['AGENTS.md'], {
            objectId: null, mode: null, transition: 'f'.repeat(40),
        })[0]?.decision,
        'block',
    );
    assert.deepEqual(engine.checkPaths(['AGENTS.md'], {
        objectId: null, mode: null, transition,
    }), []);

    engine.setOverrides([], [{ target: 'generic.agent-instructions', scope: 'rule' }], [{
        target: 'AGENTS.md',
        ruleId: 'generic.agent-instructions',
        transition,
        newObjectId: null,
        newMode: null,
    }]);
    assert.equal(
        engine.checkPaths(['AGENTS.md'], { objectId: null, mode: null, transition })[0]?.decision,
        'block',
    );
});

test('message and content matches are grouped by line', () => {
    const dir = stateWithRules([
        rule('local.message-one', 'message', { content: ['^FLAG$'] }),
        rule('local.message-two', 'message', { content: ['FLAG'] }, {
            clean: 'review', strict: 'review', compliance: 'review',
        }),
        rule('local.bot-block', 'message', { content: ['dependabot'] }),
        rule('local.code-one', 'code', { content: ['MARK'], paths: ['src/**'] }),
        rule('local.code-two', 'code', { content: ['^MARK$'], paths: ['src/**'] }),
    ]);
    try {
        const engine = newEngine('clean', dir);
        const message = engine.checkMessage('Subject\nFLAG\n');
        assert.equal(message.length, 1);
        assert.equal(message[0].decision, 'block');
        assert.deepEqual(message[0].matchedRuleIds, ['local.message-one', 'local.message-two']);

        const botLine = 'Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>';
        const bot = engine.checkMessage(botLine);
        assert.equal(bot[0]?.decision, 'block');
        assert.deepEqual(bot[0]?.matchedRuleIds, ['attribution.bot-coauthor', 'local.bot-block']);
        assert.equal(engine.fixMessage(botLine).cleaned, botLine);

        const content = engine.checkContent('src/app.js', 'MARK\n');
        assert.equal(content.length, 1);
        assert.deepEqual(content[0].matchedRuleIds, ['local.code-one', 'local.code-two']);

        engine.rules.reverse();
        assert.deepEqual(engine.checkMessage('Subject\nFLAG\n'), message);
        assert.deepEqual(engine.checkMessage(botLine), bot);
        assert.deepEqual(engine.checkContent('src/app.js', 'MARK\n'), content);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('code rules honor path scopes and built-in markers skip non-source areas', () => {
    const dir = stateWithRules([
        rule('local.scoped-code', 'code', {
            content: ['CUSTOM-MARK'],
            paths: ['src/**'],
            except: ['src/generated/**'],
        }),
        rule('local.marker-block', 'code', {
            content: ['generated by AI'],
            paths: ['src/**'],
        }),
    ]);
    try {
        const engine = newEngine('clean', dir);
        const strict = newEngine('strict', dir);
        assert.equal(engine.checkContent('src/app.js', '// CUSTOM-MARK').length, 1);
        assert.equal(engine.checkContent('src/generated/app.js', '// CUSTOM-MARK').length, 0);
        assert.equal(engine.checkContent('docs/app.js', '// CUSTOM-MARK').length, 0);

        const marker = engine.checkContent('src/app.js', '// generated by AI');
        assert.equal(marker.length, 1);
        assert.equal(marker[0].decision, 'block');
        assert.deepEqual(marker[0].matchedRuleIds, ['local.marker-block', 'marker.ai-authored']);
        assert.equal(strict.checkContent('docs/example.js', '// generated by AI').length, 0);
        assert.equal(strict.checkContent('tests/fixture.js', '// generated by AI').length, 0);
        assert.equal(strict.checkContent('vendor/library.js', '// generated by AI').length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('message repair removes only exact attributed lines', () => {
    const engine = newEngine('clean');
    const prose = 'Do not show the Generated by ChatGPT badge in settings.';
    const human = 'Co-authored-by: Claude Dupont <claude@example.com>';
    const bot = 'Co-authored-by: release-bot[bot] <123+release-bot[bot]@users.noreply.github.com>';
    for (const text of [prose, human, bot]) {
        const fixed = engine.fixMessage(text);
        assert.equal(fixed.cleaned, text);
        assert.deepEqual(fixed.removed, []);
    }

    const exact = 'Subject\n\nCo-authored-by: Claude <noreply@anthropic.com>\nDetail\n';
    const fixed = engine.fixMessage(exact);
    assert.equal(fixed.cleaned, 'Subject\n\nDetail\n');
    assert.equal(fixed.removed.length, 1);
    assert.equal(fixed.removed[0].autofix, 'remove-whole-line');
    assert.deepEqual(engine.fixMessage(fixed.cleaned), { cleaned: fixed.cleaned, removed: [] });

    assert.deepEqual(newEngine('strict').fixMessage(exact), { cleaned: exact, removed: [] });
    assert.deepEqual(newEngine('compliance').fixMessage(exact), { cleaned: exact, removed: [] });

    const knownBoilerplate = 'Subject\n\n🤖 Generated with [Claude Code](https://claude.ai/code)\n';
    assert.equal(engine.fixMessage(knownBoilerplate).cleaned, 'Subject\n\n');
});

test('message rules distinguish known identities from near misses', () => {
    const engine = newEngine('clean');
    const cases = [
        ['Co-authored-by: Claude <noreply@anthropic.com>', 'block', true],
        ['Co-authored-by: Claude Dupont <claude@example.com>', undefined, false],
        ['Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>', 'block', true],
        ['Co-authored-by: Copilot Team <team@example.com>', undefined, false],
        ['Co-authored-by: Codex <noreply@openai.com>', 'block', true],
        ['Co-authored-by: OpenAI Researcher <person@openai.com>', undefined, false],
        ['Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>', 'review', false],
        ['Generated by ChatGPT', 'block', true],
        ['Do not show the Generated by ChatGPT badge in settings.', undefined, false],
        ['Reviewed-by: Service <noreply@openai.com>', 'review', false],
        ['Report abuse to noreply@openai.com if you see it.', undefined, false],
    ];
    for (const [line, decision, removable] of cases) {
        const findings = engine.checkMessage(line);
        assert.equal(findings[0]?.decision, decision, line);
        const input = `${line}\n`;
        const fixed = engine.fixMessage(input);
        assert.equal(fixed.removed.length > 0, removable, line);
        if (!removable) assert.equal(fixed.cleaned, input, line);
    }
});

test('message repair preserves surrounding bytes and line endings', () => {
    const engine = newEngine('clean');
    const cases = [
        ['Judul é\n\nGenerated with Claude Code\n\n\nDetail  ', 'Judul é\n\n\n\nDetail  '],
        ['Judul é\r\n\r\nGenerated with Claude Code\r\n\r\nDetail  \r\n', 'Judul é\r\n\r\n\r\nDetail  \r\n'],
        ['Generated with Claude Code', 'Generated with Claude Code'],
        ['Subject\nGenerated by ChatGPT', 'Subject\nGenerated by ChatGPT'],
        ['Subject\n\nGenerated by ChatGPT', 'Subject\n\nGenerated by ChatGPT'],
        ['Subject\r\n\r\nGenerated by ChatGPT', 'Subject\r\n\r\nGenerated by ChatGPT'],
        ['Subject\nGenerated by ChatGPT\nGenerated with Claude Code', 'Subject\nGenerated with Claude Code'],
    ];
    for (const [input, expected] of cases) {
        assert.equal(engine.fixMessage(input).cleaned, expected);
    }
    assert.deepEqual(
        engine.fixMessage('Subject\nGenerated by ChatGPT'),
        { cleaned: 'Subject\nGenerated by ChatGPT', removed: [] },
    );
});

test('rule metadata and local regex work limits are validated', () => {
    const unsafe = stateWithRules([
        rule('local.slow', 'message', { content: ['^(a+)+$'] }),
    ]);
    const ambiguous = stateWithRules([
        rule('local.ambiguous', 'message', { content: ['a*a*a*a*a*b'] }),
    ]);
    const repeatedGroups = stateWithRules([
        rule('local.repeated-groups', 'message', {
            content: ['(?:a|b)*(?:a|b)*(?:a|b)*(?:a|b)*(?:a|b)*c'],
        }),
    ]);
    const caseFoldedAlternatives = stateWithRules([
        rule('local.case-folded-alternatives', 'message', { content: ['(?i)^(a|A)*b$'] }),
    ]);
    const lookaheadAlternatives = stateWithRules([
        rule('local.lookahead-alternatives', 'message', { content: ['^(?:(?=a)a|aa)*b$'] }),
    ]);
    const optionalRun = stateWithRules([
        rule('local.optional-run', 'message', { content: [`^${'a?'.repeat(16)}b$`] }),
    ]);
    const boundedChoices = stateWithRules([
        rule('local.bounded-choices', 'message', { content: ['^a{0,9}a{0,9}a{0,9}a{0,9}a{0,9}b$'] }),
    ]);
    const autofix = stateWithRules([{
        ...rule('local.autofix', 'message', { content: ['^REMOVE$'] }),
        confidence: 'high',
        autofix: 'remove-whole-line',
    }]);
    try {
        const unsafeResult = newEngineWithDiagnostics('clean', unsafe);
        assert.equal(unsafeResult.errors[0]?.code, 'INVALID_REGEX');
        assert.match(unsafeResult.errors[0]?.message, /groups, alternation, and lookaround/);

        const ambiguousResult = newEngineWithDiagnostics('clean', ambiguous);
        assert.equal(ambiguousResult.errors[0]?.code, 'INVALID_REGEX');
        assert.match(ambiguousResult.errors[0]?.message, /variable quantifiers are not allowed/);

        const repeatedGroupsResult = newEngineWithDiagnostics('clean', repeatedGroups);
        assert.equal(repeatedGroupsResult.errors[0]?.code, 'INVALID_REGEX');
        assert.match(repeatedGroupsResult.errors[0]?.message, /groups, alternation, and lookaround/);

        const caseFoldedResult = newEngineWithDiagnostics('clean', caseFoldedAlternatives);
        assert.equal(caseFoldedResult.errors[0]?.code, 'INVALID_REGEX');
        assert.match(caseFoldedResult.errors[0]?.message, /groups, alternation, and lookaround/);

        const lookaheadResult = newEngineWithDiagnostics('clean', lookaheadAlternatives);
        assert.equal(lookaheadResult.errors[0]?.code, 'INVALID_REGEX');
        assert.match(lookaheadResult.errors[0]?.message, /groups, alternation, and lookaround/);

        for (const state of [optionalRun, boundedChoices]) {
            const result = newEngineWithDiagnostics('clean', state);
            assert.equal(result.errors[0]?.code, 'INVALID_REGEX');
            assert.match(result.errors[0]?.message, /variable quantifiers are not allowed/);
        }

        const autofixResult = newEngineWithDiagnostics('clean', autofix);
        assert.equal(autofixResult.errors[0]?.code, 'INVALID_SCHEMA');
        assert.match(autofixResult.errors[0]?.message, /cannot edit commit messages automatically/);
    } finally {
        rmSync(unsafe, { recursive: true, force: true });
        rmSync(ambiguous, { recursive: true, force: true });
        rmSync(repeatedGroups, { recursive: true, force: true });
        rmSync(caseFoldedAlternatives, { recursive: true, force: true });
        rmSync(lookaheadAlternatives, { recursive: true, force: true });
        rmSync(optionalRun, { recursive: true, force: true });
        rmSync(boundedChoices, { recursive: true, force: true });
        rmSync(autofix, { recursive: true, force: true });
    }
});

test('local input limits do not truncate built-in matching', () => {
    const dir = stateWithRules([
        rule('local.long-line', 'message', { content: ['TAIL$'] }),
    ]);
    try {
        const longMessage = `${'x'.repeat(20_000)} Generated with Claude Code`;
        const engine = newEngine('clean', dir);
        assert.equal(engine.checkMessage(`${'x'.repeat(20_000)}TAIL`).length, 0);
        assert.equal(engine.checkMessage(longMessage).length, 0);
        assert.equal(engine.takeSkipped()['local-input-limit'], 2);

        const builtInAtEnd = `${'x'.repeat(20_000)}\nGenerated with Claude Code`;
        assert.equal(engine.checkMessage(builtInAtEnd)[0]?.ruleId, 'attribution.generated-with');
        assert.equal(
            engine.checkContent('src/long.js', `${'x'.repeat(20_000)} generated by AI`).length,
            1
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
