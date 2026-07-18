import {
    loadRules,
    loadRulesWithDiagnostics,
    actionFor,
    matchesPath,
    matchesContent,
    MAX_LOCAL_MATCH_INPUT,
} from './rules.mjs';
import { normalizeGitPath } from './git-path.mjs';

const DECISION_RANK = { allow: 0, review: 1, block: 2 };
const CATEGORY_RANK = new Map([['secret', 2], ['policy-config', 1]]);

// Engine evaluates paths, messages, and content against a rule set under a
// profile, honoring local allow/deny overrides.
export class Engine {
    constructor(profile, rules) {
        this.profile = profile;
        this.rules = rules;
        this.allowPaths = new Set();
        this.allowRules = new Set();
        this.allowSecretPaths = new Set();
        this.denyPaths = new Set();
        this.denyRules = new Set();
        this.scopedAllow = [];
        this.skipped = {};
    }

    // setOverrides keeps path and rule scopes separate. String entries remain
    // accepted for the small public Engine API and are inferred from known IDs.
    setOverrides(allow, deny, scopedAllow = []) {
        const allowed = this.#splitOverrides(allow);
        const denied = this.#splitOverrides(deny);
        this.allowPaths = allowed.paths;
        this.allowRules = allowed.rules;
        this.allowSecretPaths = allowed.secretPaths;
        this.denyPaths = denied.paths;
        this.denyRules = denied.rules;
        this.scopedAllow = scopedAllow.filter((entry) => (
            entry
            && typeof entry.target === 'string'
            && typeof entry.ruleId === 'string'
            && typeof entry.transition === 'string'
            && (typeof entry.newObjectId === 'string' || entry.newObjectId === null)
            && (entry.newMode === '100644' || entry.newMode === '100755' || entry.newMode === null)
        ));
    }

    // decide applies overrides to one rule. The caller reduces every resolved
    // match, so a rule-level allow cannot hide a different matching rule.
    decide(base, target, rule, context = {}) {
        if (this.denyPaths.has(target) || this.denyRules.has(rule.id)) return 'block';
        if (context.transientAllowRules?.has(rule.id)) return 'allow';
        if (this.scopedAllow.some((entry) => (
            entry.target === target
            && entry.ruleId === rule.id
            && entry.transition === context.transition
            && entry.newObjectId === context.objectId
            && entry.newMode === context.mode
        ))) return 'allow';
        // A rule-level allow cannot bypass the secret-category guard that the
        // path-level allow below enforces: secret rules require an explicit
        // --scope secret-path override on a specific path, never a blanket rule allow.
        if (this.allowRules.has(rule.id) && rule.category !== 'secret') return 'allow';
        // A --scope secret-path allow is the explicit override for secret-category
        // rules only; it must not also suppress a non-secret rule that happens to
        // match the same path (principle of least privilege).
        if (this.allowSecretPaths.has(target) && rule.category === 'secret') return 'allow';
        if (this.allowPaths.has(target) && rule.category !== 'secret') return 'allow';
        return base;
    }

    #splitOverrides(entries) {
        const result = { paths: new Set(), rules: new Set(), secretPaths: new Set() };
        for (const entry of entries || []) {
            const target = typeof entry === 'string' ? entry : entry?.target;
            if (!target) continue;
            const scope = typeof entry === 'string'
                ? (this.lookup(target) ? 'rule' : 'path')
                : (entry.scope ?? (this.lookup(target) ? 'rule' : 'path'));
            if (scope === 'rule') result.rules.add(target);
            else if (scope === 'secret-path') result.secretPaths.add(target);
            else if (scope === 'path') result.paths.add(target);
        }
        return result;
    }

    lookup(id) {
        return this.rules.find((r) => r.id === id) || null;
    }

    checkPaths(paths, context = {}) {
        const out = [];
        const seen = new Set();
        for (const raw of paths || []) {
            const p = normalize(raw);
            if (!p || seen.has(p)) continue;
            seen.add(p);
            const result = this.#evaluate('path', p, undefined, context);
            if (result) out.push(finding(result, { path: p }));
            else if (this.denyPaths.has(p)) out.push(pathDenyFinding(p));
        }
        return out;
    }

    checkMessage(text) {
        const out = [];
        for (const record of lineRecords(String(text ?? ''))) {
            this.#markLocalInputSkip('message', '', record.text);
            const result = this.#evaluate('message', '', record.text);
            if (result) out.push(finding(result, { line: record.line, text: record.text }));
        }
        return out;
    }

    checkContent(path, content, options = {}) {
        const out = [];
        const p = normalize(path);
        const categories = Array.isArray(options.categories)
            ? new Set(options.categories)
            : null;
        // lineRanges narrows content scanning to changed hunks (W4, bug 12d-F1).
        // When provided (an array of inclusive 1-based {start,end} ranges), only
        // lines falling in a range are evaluated; this stops a file that contains
        // a secret-bearing line ELSEWHERE (a PEM header inside a test string on
        // line 200) from blocking a commit that only edited line 50. Findings
        // keep their real line numbers because lineRecords already anchors them.
        // Absent = scan every line (the pre-W4 behaviour).
        const ranges = Array.isArray(options.lineRanges) && options.lineRanges.length
            ? options.lineRanges
            : null;
        for (const record of lineRecords(String(content))) {
            if (ranges && !ranges.some((range) => record.line >= range.start && record.line <= range.end)) continue;
            this.#markLocalInputSkip('code', p, record.text, categories);
            const result = this.#evaluate('code', p, record.text, { categories });
            if (result) out.push(finding(result, { path: p, line: record.line, text: record.text }));
        }
        return out;
    }

    // Repair is deliberately narrower than detection: only clean-profile block
    // findings backed by validated whole-line metadata may remove bytes.
    fixMessage(text) {
        const value = String(text ?? '');
        if (this.profile !== 'clean') return { cleaned: value, removed: [] };
        const candidates = this.checkMessage(value).filter((f) => (
            f.decision === 'block' && f.autofix === 'remove-whole-line'
        ));
        if (!candidates.length) return { cleaned: value, removed: [] };
        const records = lineRecords(value);
        const terminatedLines = new Set(records
            .filter((record) => record.end > record.start && value[record.end - 1] === '\n')
            .map((record) => record.line));
        const removed = candidates.filter((finding) => terminatedLines.has(finding.line));
        if (!removed.length) return { cleaned: value, removed: [] };
        const drop = new Set(removed.map((f) => f.line));
        const ranges = [];
        for (const record of records.filter((candidate) => drop.has(candidate.line))) {
            const previous = ranges.at(-1);
            if (previous && record.start <= previous.end) previous.end = Math.max(previous.end, record.end);
            else ranges.push({ start: record.start, end: record.end });
        }
        let cleaned = '';
        let cursor = 0;
        for (const range of ranges) {
            cleaned += value.slice(cursor, range.start);
            cursor = range.end;
        }
        cleaned += value.slice(cursor);
        return { cleaned, removed };
    }

    takeSkipped() {
        const skipped = this.skipped;
        this.skipped = {};
        return skipped;
    }

    #markLocalInputSkip(kind, target, text, categories = null) {
        if (text.length <= MAX_LOCAL_MATCH_INPUT) return;
        const applicable = this.rules.some((rule) => {
            if (rule.source !== 'local' || rule.kind !== kind) return false;
            if (categories && !categories.has(rule.category)) return false;
            if (kind !== 'code') return true;
            const candidate = rule.pathCaseInsensitive ? target.toLowerCase() : target;
            if (rule.pathRes.length && !rule.pathRes.some((regexp) => regexp.test(candidate))) return false;
            return !rule.exceptRes.some((regexp) => regexp.test(candidate));
        });
        if (applicable) this.skipped['local-input-limit'] = (this.skipped['local-input-limit'] || 0) + 1;
    }

    #evaluate(kind, target, text, context = {}) {
        const matches = [];
        for (const rule of this.rules) {
            if (rule.kind !== kind) continue;
            if (context.excludedRuleIds?.has(rule.id)) continue;
            if (context.categories && !context.categories.has(rule.category)) continue;
            const matched = kind === 'path'
                ? matchesPath(rule, target)
                : matchesContent(rule, text, kind === 'code' ? target : undefined);
            if (!matched) continue;
            matches.push({
                rule,
                decision: this.decide(actionFor(rule, this.profile), target, rule, context),
            });
        }
        if (!matches.length) return null;

        matches.sort(compareMatch);
        const decision = matches.reduce((current, match) => (
            DECISION_RANK[match.decision] > DECISION_RANK[current] ? match.decision : current
        ), 'allow');
        if (decision === 'allow') return null;

        const primary = matches.find((match) => match.decision === decision);
        const autofix = matches.some((match) => (
            match.decision === 'block' && match.rule.autofix === 'remove-whole-line'
        )) ? 'remove-whole-line' : undefined;
        return { matches, primary, decision, autofix };
    }
}

function compareMatch(left, right) {
    const decision = DECISION_RANK[right.decision] - DECISION_RANK[left.decision];
    if (decision) return decision;
    const category = (CATEGORY_RANK.get(right.rule.category) || 0) - (CATEGORY_RANK.get(left.rule.category) || 0);
    if (category) return category;
    const source = Number(right.rule.source !== 'local') - Number(left.rule.source !== 'local');
    if (source) return source;
    return compareText(left.rule.id, right.rule.id);
}

function finding(result, extra) {
    const rule = result.primary.rule;
    const matchedRules = [...result.matches]
        .sort((left, right) => compareText(left.rule.id, right.rule.id))
        .map((match) => ({
            ruleId: match.rule.id,
            ruleVersion: match.rule.version ?? null,
            kind: match.rule.kind,
            category: match.rule.category,
            provider: match.rule.provider,
            confidence: match.rule.confidence ?? null,
            decision: match.decision,
            reason: match.rule.reason,
            remediation: match.rule.remediation || [],
            source: match.rule.source || 'builtin',
        }));
    const out = {
        ruleId: rule.id,
        ruleVersion: rule.version ?? null,
        matchedRuleIds: matchedRules.map((match) => match.ruleId),
        matchedRules,
        kind: rule.kind,
        category: rule.category,
        provider: rule.provider,
        confidence: rule.confidence ?? null,
        decision: result.decision,
        reason: rule.reason,
        remediation: rule.remediation || [],
        source: rule.source || 'builtin',
        ...extra,
    };
    if (result.autofix) out.autofix = result.autofix;
    return out;
}

function pathDenyFinding(path) {
    return {
        ruleId: 'override.path-deny',
        ruleVersion: 1,
        matchedRuleIds: ['override.path-deny'],
        matchedRules: [{
            ruleId: 'override.path-deny',
            ruleVersion: 1,
            kind: 'path',
            category: 'local-override',
            provider: 'aimhooman',
            confidence: 'high',
            decision: 'block',
            reason: 'A local deny override blocks this path.',
            remediation: ['Remove the deny override before committing this path.'],
            source: 'local',
        }],
        kind: 'path',
        category: 'local-override',
        provider: 'aimhooman',
        confidence: 'high',
        decision: 'block',
        reason: 'A local deny override blocks this path.',
        remediation: ['Remove the deny override before committing this path.'],
        source: 'local',
        path,
    };
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function lineRecords(value) {
    const records = [];
    let start = 0;
    let line = 1;
    while (start < value.length) {
        const newline = value.indexOf('\n', start);
        const end = newline < 0 ? value.length : newline + 1;
        let textEnd = newline < 0 ? value.length : newline;
        if (textEnd > start && value[textEnd - 1] === '\r') textEnd -= 1;
        records.push({ start, end, line, text: value.slice(start, textEnd) });
        start = end;
        line += 1;
    }
    if (value.length === 0 || value.endsWith('\n')) {
        records.push({ start: value.length, end: value.length, line, text: '' });
    }
    return records;
}

function normalize(p) {
    return normalizeGitPath(p);
}

// newEngine builds an engine for a profile with the embedded rule packs loaded.
// When stateDir is given, local rule packs from <stateDir>/rules/*.json are
// appended after the core packs.
export function newEngine(profile, stateDir) {
    return new Engine(profile, loadRules(stateDir));
}

// Diagnostic constructor lets hook/CLI callers choose profile-specific handling
// for malformed local packs while always retaining validated built-in rules.
export function newEngineWithDiagnostics(profile, stateDir) {
    const { rules, errors } = loadRulesWithDiagnostics(stateDir);
    return { engine: new Engine(profile, rules), errors };
}
