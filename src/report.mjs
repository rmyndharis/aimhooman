// Human-facing and JSON reporting for aimhooman findings.

export function human(findings, tone) {
    if (!findings.length) return '';
    let out = tone === 'professional' ? '\n' : '\nnot very hooman.\n\n';
    let block = 0;
    let review = 0;
    for (const f of findings) {
        if (f.decision === 'block') block += 1;
        else if (f.decision === 'review') review += 1;
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
        if (f.remediation?.length) out += `       fix: ${f.remediation[0]}\n`;
        out += '\n';
    }
    out += `${findings.length} findings: ${block} block, ${review} review\n`;
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
