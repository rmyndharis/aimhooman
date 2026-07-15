import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertForwardVersion,
    compareVersions,
    parseVersion,
    releaseChannel,
} from '../src/release-channel.mjs';

test('release channel keeps prereleases off latest', () => {
    assert.equal(releaseChannel('0.1.0-rc.1'), 'next');
    assert.equal(releaseChannel('0.1.0-beta.2+build.7'), 'next');
    assert.equal(releaseChannel('0.1.0'), 'latest');
    assert.equal(releaseChannel('1.0.0+build-x'), 'latest');
    assert.throws(() => parseVersion('v0.1.0'), /invalid semantic version/);
    assert.throws(() => parseVersion('0.1.0-rc.01'), /leading zeroes/);
});

test('release ordering follows SemVer and refuses channel rollback', () => {
    const ordered = [
        '0.1.0-alpha',
        '0.1.0-alpha.1',
        '0.1.0-beta',
        '0.1.0-rc.1',
        '0.1.0-rc.2',
        '0.1.0',
        '0.1.1',
    ];
    for (let index = 1; index < ordered.length; index++) {
        assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1);
        assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1);
    }
    assert.equal(compareVersions('0.1.0+one', '0.1.0+two'), 0);
    assert.doesNotThrow(() => assertForwardVersion('0.1.0-rc.1', '0.1.0-rc.2'));
    assert.throws(() => assertForwardVersion('0.1.0-rc.2', '0.1.0-rc.1'), /move a release channel backward/);
    assert.throws(() => assertForwardVersion('0.1.0', '0.1.0'), /move a release channel backward/);
});
