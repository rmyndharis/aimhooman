// Git replacement refs are local, mutable aliases. Policy and audit reads must
// address the repository's real object graph instead of a rewritten view.
export function gitEnvironment(environment = process.env) {
    return { ...environment, GIT_NO_REPLACE_OBJECTS: '1' };
}

// execFileSync has no default timeout, so a git child that never exits blocks
// the caller forever. One did: it held a CI runner until the platform's 6-hour
// ceiling killed the job, with no error to read afterwards.
//
// Real calls here finish in milliseconds. This bound exists to end a stuck one,
// not to pace a slow one, so it sits far above any legitimate call: a huge
// repository on a slow disk stays well inside it, and a hang now raises an
// error naming the command instead of going quiet.
export const GIT_TIMEOUT_MS = 120_000;
