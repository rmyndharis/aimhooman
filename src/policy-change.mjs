// The project policy file decides which profile every later commit is judged by,
// so a commit that adds or changes it is judged by the policy it adds. A change to
// it is therefore the user's to make, as running aimhooman allow is. This is the
// agent-side half: the Git add and commit that would stage or commit
// .aimhooman.json are refused, whether it is staged already, edited on disk, or
// written by the same line. The Git-side half is the strict floor in scan-target.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { gitBuf, openRepo, stagedPaths } from './gitx.mjs';
import { resolveStagedPolicy } from './scan-target.mjs';
import { inspectCommitOptions } from './shell-parse.mjs';

const POLICY_FILE = '.aimhooman.json';

const POLICY_CHANGE_REASON =
    "aimhooman does not let an agent stage or commit .aimhooman.json: the project policy decides what every "
    + "later commit is judged by, so a change to it is the user's to make. Ask the user to commit it.";

// Git takes any unambiguous prefix of a long option, so --al is --all.
const BROAD_ADD_LONG = ['all', 'update', 'patch', 'interactive', 'edit', 'no-ignore-removal', 'pathspec-from-file', 'pathspec-file-nul'];

function longOption(word) {
    return /^--([a-z][a-z-]*)(?:=.*)?$/.exec(word)?.[1] ?? null;
}

// An add option that can stage a file it does not name.
function isBroadAddOption(word) {
    const name = longOption(word);
    return name ? BROAD_ADD_LONG.some((long) => long.startsWith(name)) : /^-[a-zA-Z]*[Aupie][a-zA-Z]*$/.test(word);
}

// An add option that lets it stage a file the ignore rules cover.
function isForceAddOption(word) {
    const name = longOption(word);
    return name ? 'force'.startsWith(name) : /^-[a-zA-Z]*f[a-zA-Z]*$/.test(word);
}

// Git names the repository in its own spelling: symlinks resolved and, on Windows,
// 8.3 names lengthened. A path typed in the shell is compared in that spelling, so
// a working directory reached through either still finds the file. The part that
// does not exist yet (a file about to be written) keeps its own name.
function physical(path) {
    const tail = [];
    let current = resolve(path);
    for (;;) {
        try {
            return join(realpathSync.native(current), ...tail);
        } catch {
            const parent = dirname(current);
            if (parent === current) return resolve(path);
            tail.unshift(basename(current));
            current = parent;
        }
    }
}

// Whether a path word names the policy file or a directory that holds it. The
// comparison ignores case, because the file systems of macOS and Windows do.
function namesPolicy(word, cwd, root) {
    const target = join(physical(root), POLICY_FILE).toLowerCase();
    const full = resolve(cwd, String(word));
    const file = join(physical(dirname(full)), basename(full)).toLowerCase();
    const directory = physical(full).toLowerCase();
    return file === target || target.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

// Whether a pathspec may select the policy file without naming it: magic, a glob,
// a word the shell has yet to expand ($f, $(...), `...`, {a,b}, ~) or a directory
// that holds it.
function pathspecMayMatch(word, cwd, root) {
    return /^[:~]|[*?[\\$`{}]/.test(word) || namesPolicy(word, cwd, root);
}

function addMayStage(candidate, root) {
    const args = candidate.args ?? [];
    const end = args.indexOf('--');
    const before = end < 0 ? args : args.slice(0, end);
    const paths = [...before.filter((word) => !word.startsWith('-')), ...(end < 0 ? [] : args.slice(end + 1))];
    return before.some((word) => word.startsWith('-') && isBroadAddOption(word))
        || paths.some((word) => pathspecMayMatch(word, candidate.cwd, root));
}

function commitMayStage(candidate, root) {
    if (!candidate.args) return Boolean(candidate.futureIndex);
    const { optionIndex, paths } = inspectCommitOptions(candidate.args);
    return optionIndex || paths.some((word) => pathspecMayMatch(word, candidate.cwd, root));
}

// A staged policy change that the user reviewed: the migration is bound to the
// exact old and new policy objects, so the commit may be made as reviewed.
function reviewedMigration(repo) {
    try {
        return resolveStagedPolicy(repo).acknowledged === true;
    } catch {
        return false;
    }
}

// The line writes the policy file itself: a redirect, tee, cp, mv, sed -i. A
// commit message or a cat that only names it does not.
const WRITES_POLICY = /(?:>>?|\b(?:tee|cp|mv|install|ln|touch|truncate|rm|sed|perl|ed|dd|rsync)\b)[^;&|\n]*\.aimhooman\.json/i;

function writesPolicy(command) {
    return WRITES_POLICY.test(String(command ?? ''));
}

// find -exec git add {} \; leaves no add to read, because the paths come from find.
const WRAPPED_ADD = /-(?:exec|execdir|ok|okdir)\s+(?:\S*[/\\])?git(?:\.exe)?\b[^;&|\n]*?\sadd\b/;

// Whether the policy file has a change a commit could take. An ignored file has
// none, unless an add forces it in.
function pending(repo, ignored) {
    const flags = ignored ? ['--ignored'] : [];
    try {
        return gitBuf(['status', '--porcelain', '-z', '--untracked-files=all', ...flags, '--', POLICY_FILE], repo.root).length > 0;
    } catch {
        return true;
    }
}

// The reason an agent may not run this line, or null.
export function policyChangeReason(parsed, primaryRepo, command) {
    const adds = parsed.commands.filter((candidate) => candidate.verb === 'add');
    const commits = parsed.commands.filter((candidate) => candidate.verb === 'commit');
    const potentialCommit = Boolean(parsed.commit) || commits.length > 0 || parsed.opaqueCommitHiding;
    const wrappedAdd = WRAPPED_ADD.test(String(command ?? ''));
    if (!adds.length && !potentialCommit && !wrappedAdd) return null;
    const repos = new Map();
    const repoAt = (cwd) => {
        if (!repos.has(cwd)) {
            try { repos.set(cwd, openRepo(cwd)); } catch { repos.set(cwd, null); }
        }
        return repos.get(cwd);
    };
    const pendingIn = new Map();
    const isPending = (repo, ignored = false) => {
        const key = `${repo.root}\0${ignored}`;
        if (!pendingIn.has(key)) pendingIn.set(key, writesPolicy(command) || pending(repo, ignored));
        return pendingIn.get(key);
    };
    const touched = new Set([primaryRepo, ...commits.map((candidate) => repoAt(candidate.cwd))].filter(Boolean));
    if (potentialCommit) {
        for (const repo of touched) {
            try {
                if (stagedPaths(repo).some((path) => path.toLowerCase() === POLICY_FILE) && !reviewedMigration(repo)) {
                    return POLICY_CHANGE_REASON;
                }
            } catch { /* the staged scan reports an unreadable index */ }
        }
    }
    for (const candidate of [...adds, ...commits]) {
        const repo = repoAt(candidate.cwd);
        if (!repo) continue;
        const stages = candidate.verb === 'add' ? addMayStage(candidate, repo.root) : commitMayStage(candidate, repo.root);
        const forced = candidate.verb === 'add'
            && (candidate.args ?? []).some((word) => word.startsWith('-') && isForceAddOption(word));
        if (stages && isPending(repo, forced)) return POLICY_CHANGE_REASON;
    }
    if (wrappedAdd) {
        const repo = repoAt(process.cwd());
        if (repo && isPending(repo, true)) return POLICY_CHANGE_REASON;
    }
    // A commit this scan cannot read to its end may stage anything, forced or not.
    if (parsed.opaqueCommitHiding && (parsed.commit || commits.length)) {
        for (const repo of touched) if (isPending(repo, true)) return POLICY_CHANGE_REASON;
    }
    return null;
}
