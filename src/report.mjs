// Human-facing and JSON reporting for aimhooman findings.

// HUMAN_FINDING_CAP bounds the per-invocation stderr output. A scan that fires
// many findings of the same rule (a vendored OpenSSL corpus can produce 99) used
// to emit hundreds of near-identical lines with no truncation marker. The cap
// prints the first HUMAN_FINDING_CAP finding blocks, then a single summary line
// for the rest. The JSON report (aimhooman review / --json) is never capped.
const HUMAN_FINDING_CAP = 20;

export function human(findings, tone) {
    if (!findings.length) return '';
    let block = 0;
    let review = 0;
    for (const f of findings) {
        if (f.decision === 'block') block += 1;
        else if (f.decision === 'review') review += 1;
    }
    // The banner means "aimhooman stopped or reshaped your operation". A pure
    // advisory (review findings only, the commit proceeds untouched) prints
    // without it — otherwise the banner fires on allowed work and stops
    // meaning anything when a real block lands.
    let out = tone === 'professional' || block === 0 ? '\n' : '\nnot very hooman.\n\n';
    // Render findings in order up to the cap, then collapse the rest into one
    // summary line. Keeps the first findings fully visible (the actionable ones)
    // while bounding stderr for repeated-rule scans.
    const shown = findings.slice(0, HUMAN_FINDING_CAP);
    const hidden = findings.length - shown.length;
    const fixesPrinted = new Set();
    for (const f of shown) {
        const loc = f.path
            ? `${visible(f.path)}${f.line ? `:${f.line}` : ''}`
            : (f.line ? `commit message line ${f.line}` : '');
        const related = (f.matchedRuleIds || []).filter((id) => id !== f.ruleId);
        const identity = related.length ? `${f.ruleId} (+ ${related.join(', ')})` : f.ruleId;
        const commit = f.commit ? ` [commit ${String(f.commit).slice(0, 12)}]` : '';
        out += `${f.decision.toUpperCase().padEnd(6)} ${identity}${commit}\n       ${loc}\n       ${f.reason}\n`;
        if (f.text && f.text.trim()) {
            out += `       > ${isSensitive(f) ? '[redacted]' : visible(f.text.trim())}\n`;
        }
        // Render the whole remediation array, not just the first entry. Several
        // rules carry a second line (e.g. "or unstage if it is personal" on
        // generic.agent-instructions) that the previous single-index render
        // dropped silently. UT-08: print a rule's fix once — a repeated rule
        // (20 hits of the same path rule) used to reprint the identical fix
        // block for every finding.
        const remedies = f.remediation || [];
        if (remedies.length && fixesPrinted.has(f.ruleId)) {
            out += `       fix: as above for ${f.ruleId}\n`;
        } else {
            if (remedies.length) fixesPrinted.add(f.ruleId);
            for (const remedy of remedies) {
                out += `       fix: ${remedy}\n`;
            }
        }
        out += '\n';
    }
    if (hidden > 0) {
        out += `… and ${hidden} more ${hidden === 1 ? 'finding' : 'findings'} (run 'aimhooman review' for the full list)\n\n`;
    }
    const findingWord = findings.length === 1 ? 'finding' : 'findings';
    const blockWord = block === 1 ? 'block' : 'blocks';
    const reviewWord = review === 1 ? 'review' : 'reviews';
    out += `${findings.length} ${findingWord}: ${block} ${blockWord}, ${review} ${reviewWord}\n`;
    return out;
}

export function visible(value) {
    return String(value).replace(/[\u0000-\u001f\u007f]/g, (character) => {
        if (character === '\n') return '\\n';
        if (character === '\r') return '\\r';
        if (character === '\t') return '\\t';
        return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
    });
}

export function jsonReport(findings, metadata = {}) {
    const safe = findings.map((finding) => (
        isSensitive(finding) && finding.text
            ? { ...finding, text: '[redacted]' }
            : finding
    ));
    return JSON.stringify({ schema_version: 1, ...metadata, findings: safe }, null, 2);
}

// Built-in secret scanning is gone, but a local rule pack can still declare
// category "secret"; findings from such a rule keep their matched text out of
// every report, the same courtesy the built-in rules got.
function isSensitive(finding) {
    return finding?.category === 'secret'
        || finding?.matchedRules?.some((match) => match.category === 'secret') === true;
}

// Exit codes: 0 clean, 10 blocked, 11 review required, 31 incomplete scan.
// An incomplete scan stops the operation only where no later guard can vouch
// for the skipped content: on the strict profile, or when the caller is the
// final ref boundary (failClosedIncomplete). Frictionless profiles warn and
// continue — the reference-transaction guard still scans introduced commits
// with failClosedIncomplete set, so the skipped content is checked before any
// ref moves. One exception at that final boundary: a scan whose only gap is
// 'size-limit' (a file over maxFileBytes went unscanned for content rules —
// path rules still ran) warns and continues on frictionless profiles. Blocking
// the whole commit there cost developers a legit large file for a marker risk
// that clean/compliance treat as advisory anyway. Strict stays fail-closed on
// any gap, size-limit included.
export function exitCode(findings, profile, complete = true, { failClosedIncomplete = false, incompleteReasons = [] } = {}) {
    let block = false;
    let review = false;
    for (const f of findings) {
        if (f.decision === 'block') block = true;
        else if (f.decision === 'review') review = true;
    }
    if (block) return 10;
    if (!complete && (profile === 'strict' || failClosedIncomplete)) {
        const sizeLimitOnly = incompleteReasons.length > 0
            && incompleteReasons.every((reason) => reason === 'size-limit');
        if (profile === 'strict' || !sizeLimitOnly) return 31;
    }
    if (review && findings.some((finding) => (finding.scanProfile || profile) !== 'clean')) return 11;
    return 0;
}
