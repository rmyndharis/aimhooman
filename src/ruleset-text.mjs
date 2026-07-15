export const RULESET_START = '<!-- aimhooman:ruleset-start -->';
export const RULESET_END = '<!-- aimhooman:ruleset-end -->';

export function extractRuleset(text, label = 'ruleset source') {
    const source = String(text);
    const starts = occurrences(source, RULESET_START);
    const ends = occurrences(source, RULESET_END);
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
        throw new Error(`${label} must contain one ordered aimhooman ruleset marker pair`);
    }
    const beginning = starts[0] + RULESET_START.length;
    return source.slice(beginning, ends[0]).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

export function rulesetBlock(text, label) {
    return `${RULESET_START}\n${extractRuleset(text, label)}\n${RULESET_END}`;
}

export function normalizedRuleset(text, label) {
    return extractRuleset(text, label).replace(/\r\n/g, '\n');
}

function occurrences(text, search) {
    const offsets = [];
    for (let offset = text.indexOf(search); offset >= 0; offset = text.indexOf(search, offset + search.length)) {
        offsets.push(offset);
    }
    return offsets;
}
