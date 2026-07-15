const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(value) {
    const match = SEMVER.exec(String(value || ''));
    if (!match) throw new TypeError(`invalid semantic version "${value}"`);
    const prerelease = match[4]
        ? match[4].split('.').map((identifier) => (/^\d+$/.test(identifier)
            ? { numeric: true, value: BigInt(identifier), raw: identifier }
            : { numeric: false, value: identifier, raw: identifier }))
        : [];
    if (prerelease.some((identifier) => identifier.numeric && identifier.raw.length > 1 && identifier.raw.startsWith('0'))) {
        throw new TypeError(`invalid semantic version "${value}": numeric prerelease identifiers cannot have leading zeroes`);
    }
    return {
        raw: String(value),
        major: BigInt(match[1]),
        minor: BigInt(match[2]),
        patch: BigInt(match[3]),
        prerelease,
    };
}

export function releaseChannel(version) {
    return parseVersion(version).prerelease.length ? 'next' : 'latest';
}

export function compareVersions(leftValue, rightValue) {
    const left = parseVersion(leftValue);
    const right = parseVersion(rightValue);
    for (const field of ['major', 'minor', 'patch']) {
        if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
    }
    if (!left.prerelease.length || !right.prerelease.length) {
        if (left.prerelease.length === right.prerelease.length) return 0;
        return left.prerelease.length ? -1 : 1;
    }
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index++) {
        const a = left.prerelease[index];
        const b = right.prerelease[index];
        if (!a || !b) return a ? 1 : -1;
        if (a.numeric && b.numeric) {
            if (a.value !== b.value) return a.value < b.value ? -1 : 1;
            continue;
        }
        if (a.numeric !== b.numeric) return a.numeric ? -1 : 1;
        if (a.value !== b.value) return a.value < b.value ? -1 : 1;
    }
    return 0;
}

export function assertForwardVersion(current, proposed) {
    if (!current) return;
    if (compareVersions(current, proposed) >= 0) {
        throw new Error(`refusing to move a release channel backward from ${current} to ${proposed}`);
    }
}
