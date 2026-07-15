// Git replacement refs are local, mutable aliases. Policy and audit reads must
// address the repository's real object graph instead of a rewritten view.
export function gitEnvironment(environment = process.env) {
    return { ...environment, GIT_NO_REPLACE_OBJECTS: '1' };
}
