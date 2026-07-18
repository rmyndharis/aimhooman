// Human-facing and JSON reporting for aimhooman findings.

// HUMAN_FINDING_CAP bounds the per-invocation stderr output. A scan that fires
// many findings of the same rule (a vendored OpenSSL corpus can produce 99) used
// to emit hundreds of near-identical lines with no truncation marker. The cap
// prints the first HUMAN_FINDING_CAP finding blocks, then a single summary line
// for the rest. The JSON report (aimhooman review / --json) is never capped.
const HUMAN_FINDING_CAP = 20;

export function human(findings, tone) {
    if (!findings.length) return '';
    let out = tone === 'professional' ? '\n' : '\nnot very hooman.\n\n';
    let block = 0;
    let review = 0;
    for (const f of findings) {
        if (f.decision === 'block') block += 1;
        else if (f.decision === 'review') review += 1;
    }
    // Render findings in order up to the cap, then collapse the rest into one
    // summary line. Keeps the first findings fully visible (the actionable ones)
    // while bounding stderr for repeated-rule scans.
    const shown = findings.slice(0, HUMAN_FINDING_CAP);
    const hidden = findings.length - shown.length;
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
        // rules carry a second line (e.g. "rotate the key if it was ever exposed")
        // that the previous single-index render dropped silently.
        for (const remedy of (f.remediation || [])) {
            out += `       fix: ${remedy}\n`;
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

function isSensitive(finding) {
    return finding?.category === 'secret'
        || finding?.matchedRules?.some((match) => match.category === 'secret') === true;
}

// Exit codes: 0 clean, 10 blocked, 11 review required, 31 incomplete scan.
export function exitCode(findings, profile, complete = true) {
    let block = false;
    let review = false;
    for (const f of findings) {
        if (f.decision === 'block') block = true;
        else if (f.decision === 'review') review = true;
    }
    if (block) return 10;
    if (!complete) return 31;
    if (review && findings.some((finding) => (finding.scanProfile || profile) !== 'clean')) return 11;
    return 0;
}
