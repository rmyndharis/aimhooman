#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { assertForwardVersion, releaseChannel } from '../src/release-channel.mjs';

export function main(args) {
    const [command, ...values] = args;
    if (command === 'channel' && values.length === 1) {
        process.stdout.write(`${releaseChannel(values[0])}\n`);
        return 0;
    }
    if (command === 'assert-forward' && values.length === 2) {
        assertForwardVersion(values[0], values[1]);
        return 0;
    }
    throw new TypeError('usage: release-channel.mjs channel <version> | assert-forward <current> <proposed>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(`aimhooman: ${error.message}`);
        process.exitCode = 20;
    }
}
