// The project policy file decides which profile every later commit is judged by,
// so a commit that adds or changes it is judged by the policy it adds. A change to
// it is therefore the user's to make, as running aimhooman allow is. This is the
// agent-side half: the Git add and commit that would stage or commit
// .aimhooman.json are refused, whether it is staged already, edited on disk, or
// written by the same line. The Git-side half is the strict floor in scan-target.
//
// What a line is refused for is what it would take. The file has a state (a
// change to a tracked file, a new file, an ignored one, none), and each add or
// commit takes some of those: add -u and commit -a take only tracked changes,
// add -A and a pathspec take new files too, and only add -f takes an ignored one.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { gitBuf, openRepo } from './gitx.mjs';
import { resolveStagedPolicy } from './scan-target.mjs';
import { inspectCommitOptions, lineUnits, shellWords } from './shell-parse.mjs';

const POLICY_FILE = '.aimhooman.json';

const POLICY_CHANGE_REASON =
    "aimhooman does not let an agent stage or commit .aimhooman.json: the project policy decides what every "
    + "later commit is judged by, so a change to it is the user's to make. Ask the user to commit it.";

// ---- paths
// Git names the repository in its own spelling: symlinks resolved and, on Windows,
// 8.3 names lengthened. A path typed in the shell is compared in that spelling, so
// a working directory reached through either still finds the file. The part that
// does not exist yet (a file about to be written) keeps its own name.
const resolved = new Map();
function physical(path) {
    const key = resolve(path);
    if (resolved.has(key)) return resolved.get(key);
    const tail = [];
    let current = key;
    let found = key;
    for (;;) {
        try {
            found = join(realpathSync.native(current), ...tail);
            break;
        } catch {
            const parent = dirname(current);
            if (parent === current) break;
            tail.unshift(basename(current));
            current = parent;
        }
    }
    resolved.set(key, found);
    return found;
}

// A literal path as the policy file at the root of the repository sees it: the file
// itself, or a directory that holds it. The comparison ignores case, because the
// file systems of macOS and Windows do.
function reach(text, base, root) {
    const target = join(physical(root), POLICY_FILE).toLowerCase();
    const full = resolve(base, text);
    const directory = physical(full).toLowerCase();
    return {
        file: join(physical(dirname(full)), basename(full)).toLowerCase() === target,
        holds: target.startsWith(directory.endsWith(sep) ? directory : directory + sep),
    };
}

// A pathspec word: a pattern, with the magic that :(top) :(literal) :(exclude)
// and the short :/ :! :^ put in front of it. Magic this does not know could mean
// anything.
const KNOWN_MAGIC = new Set(['top', 'literal', 'glob', 'icase', 'exclude']);
function parseSpec(word) {
    if (!word.startsWith(':')) return { text: word };
    const long = /^:\(([^)]*)\)([^]*)$/.exec(word);
    if (long) {
        const magic = long[1].split(',');
        if (!magic.every((name) => KNOWN_MAGIC.has(name))) return { unknown: true };
        return { text: long[2], top: magic.includes('top'), literal: magic.includes('literal'), exclude: magic.includes('exclude') };
    }
    const [, flags, text] = /^:([!^/]*):?([^]*)$/.exec(word);
    return { text, top: flags.includes('/'), exclude: /[!^]/.test(flags) };
}

// Whether one pathspec may select the policy file. A glob or a path the shell has
// yet to expand is read as far as it is literal: src/*.js can only select what is
// under src/, a*b only what starts with a, while a word that starts with an
// expansion can spell anything.
function specReaches(spec, cwd, root, posix) {
    if (spec.unknown) return true;
    const base = spec.top ? root : cwd;
    const text = posix ? spec.text : spec.text.replaceAll('\\', '/');
    if (text.startsWith('~')) return true;
    const glob = spec.literal ? -1 : text.search(posix ? /[*?[\\]/ : /[*?[]/);
    const expand = text.search(/[$`{]/);
    const at = glob < 0 ? expand : expand < 0 ? glob : Math.min(glob, expand);
    if (at < 0) {
        const { file, holds } = reach(text, base, root);
        return file || holds;
    }
    const directory = text.slice(0, text.lastIndexOf('/', at - 1) + 1);
    if (!directory && at === expand) return true;
    const first = text.slice(directory.length, at).toLowerCase();
    const where = physical(resolve(base, directory || '.')).toLowerCase();
    const top = physical(root).toLowerCase();
    if (where === top) return POLICY_FILE.startsWith(first);
    // A pattern over a directory above the repository can reach down to the file.
    return (top + sep).startsWith(where.endsWith(sep) ? where : where + sep);
}

function pathspecsReach(words, cwd, root, posix) {
    const specs = words.map(parseSpec);
    // An exclusion that names the file keeps every other pathspec from taking it.
    for (const spec of specs) {
        if (!spec.exclude || spec.unknown || /[*?[\\$`{]/.test(spec.text)) continue;
        const { file, holds } = reach(posix ? spec.text : spec.text.replaceAll('\\', '/'), spec.top ? root : cwd, root);
        if (file || holds) return false;
    }
    return specs.some((spec) => !spec.exclude && specReaches(spec, cwd, root, posix));
}

// ---- the words of an add or a commit
// Redirections are words in the list too: > file, >file, 2>&1.
const REDIRECT_OPERATOR = /^(?:\d+|&)?(?:>>?\|?|<<?<?|<>|>&|<&)$/;
const REDIRECT_ATTACHED = /^(?:\d+|&)?(?:>>?\|?|<<?<?|<>|>&|<&)[^]/;
function dropRedirects(words) {
    const kept = [];
    for (let at = 0; at < words.length; at += 1) {
        if (REDIRECT_OPERATOR.test(words[at])) at += 1;
        else if (!REDIRECT_ATTACHED.test(words[at])) kept.push(words[at]);
    }
    return kept;
}

// Git takes any unambiguous prefix of a long option, so --al is --all; one that is
// unknown or ambiguous it refuses, which stages nothing.
const ADD_OPTIONS = new Map([
    ['dry-run', 'dryRun'], ['verbose', ''], ['interactive', 'patch'], ['patch', 'patch'], ['edit', 'patch'],
    ['force', 'force'], ['update', 'update'], ['renormalize', ''], ['intent-to-add', ''], ['all', 'all'],
    ['no-ignore-removal', 'all'], ['ignore-removal', ''], ['refresh', ''], ['ignore-errors', ''],
    ['ignore-missing', ''], ['sparse', ''], ['chmod', 'value'], ['pathspec-from-file', 'fromFile'],
    ['pathspec-file-nul', ''],
]);
const ADD_SHORT = { n: 'dryRun', i: 'patch', p: 'patch', e: 'patch', f: 'force', u: 'update', A: 'all' };

function addOption(name) {
    if (ADD_OPTIONS.has(name)) return ADD_OPTIONS.get(name);
    const hits = [...ADD_OPTIONS.keys()].filter((option) => option.startsWith(name));
    return hits.length === 1 ? ADD_OPTIONS.get(hits[0]) : '';
}

function readAdd(words) {
    const add = { paths: [] };
    let literal = false;
    for (let at = 0; at < words.length; at += 1) {
        const word = words[at];
        if (literal || word === '-' || !word.startsWith('-')) {
            add.paths.push(word);
        } else if (word === '--') {
            literal = true;
        } else if (word.startsWith('--')) {
            const effect = addOption(word.slice(2).split('=')[0]);
            if (effect && effect !== 'value') add[effect] = true;
            if ((effect === 'fromFile' || effect === 'value') && !word.includes('=')) at += 1;
        } else {
            for (const letter of word.slice(1)) if (ADD_SHORT[letter]) add[ADD_SHORT[letter]] = true;
        }
    }
    return add;
}

// ---- what the file is, and what an add or a commit takes of it
// none, tracked (a change to a tracked file, staged or not), untracked, ignored;
// written is a line that writes it, which may leave any of those.
function policyState(repo) {
    try {
        const listed = gitBuf(
            ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored', '--', POLICY_FILE],
            repo.root,
        ).toString('utf8');
        if (!listed) return 'none';
        if (listed.startsWith('??')) return 'untracked';
        return listed.startsWith('!!') ? 'ignored' : 'tracked';
    } catch {
        return 'tracked';
    }
}

function takes(state, { trackedOnly = false, force = false } = {}) {
    if (state === 'tracked' || state === 'written') return true;
    if (state === 'untracked') return !trackedOnly;
    return state === 'ignored' && force && !trackedOnly;
}

// What an add would reach, or null when it cannot reach the file.
function addNeed(candidate, root, posix) {
    const add = readAdd(dropRedirects(candidate.args ?? ['-A']));
    if (add.dryRun) return null;
    const reaches = add.fromFile
        || (add.paths.length ? pathspecsReach(add.paths, candidate.cwd, root, posix) : add.all || add.update || add.patch);
    return reaches ? { trackedOnly: Boolean((add.update || add.patch) && !add.all), force: Boolean(add.force) } : null;
}

// A commit takes tracked changes only: the paths it names, or the whole tree for
// -a and -p.
function commitNeed(candidate, root, posix) {
    if (!candidate.args) return { trackedOnly: true };
    const { optionIndex, dryRun, paths } = inspectCommitOptions(dropRedirects(candidate.args));
    if (dryRun) return null;
    const reaches = paths.length ? pathspecsReach(paths, candidate.cwd, root, posix) : optionIndex;
    return reaches ? { trackedOnly: true } : null;
}

// A commit whose own words hold a substitution is not read to its end.
function commitIsOpaque(candidate, posix) {
    return (candidate.args ?? []).some((word) => (posix ? /\$\(|`/ : /\$\(/).test(word));
}

// A staged change to the file, a rename away from it included: that is a delete
// and an add, and the pairing would hide the delete.
function stagedPolicy(repo) {
    try {
        return gitBuf(['diff', '--cached', '--name-only', '--no-renames', '-z', '--', POLICY_FILE], repo.root).length > 0;
    } catch {
        return false;
    }
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

// ---- a line that writes the file, or adds it out of sight
const WRITE_LAST = new Set(['cp', 'install', 'rsync', 'ln', 'copy']);
const WRITE_ANY = new Set([
    'mv', 'rm', 'unlink', 'touch', 'truncate', 'tee', 'ed', 'move', 'del', 'erase', 'ren', 'rename',
    'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'remove-item', 'new-item', 'clear-content',
]);
const WRAPPERS = new Set(['sudo', 'command', 'nice', 'nohup', 'time', 'env']);

function namesFile(word, posix) {
    const path = (posix ? word : word.replaceAll('\\', '/')).toLowerCase();
    return path === POLICY_FILE || path.endsWith(`/${POLICY_FILE}`);
}

// A redirect or a writer whose operand is the file; a message or a read that
// only names it does not write it.
function writesPolicy(text, posix) {
    if (!text.toLowerCase().includes(POLICY_FILE)) return false;
    for (const unit of lineUnits(text, posix)) {
        const words = shellWords(unit.text, 512, { escape: posix });
        for (const [at, word] of words.entries()) {
            const redirect = /^(?:\d+|&)?>>?\|?([^]*)$/.exec(word);
            if (redirect && namesFile(redirect[1] || words[at + 1] || '', posix)) return true;
        }
        let start = words.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word));
        while (start >= 0 && start < words.length && WRAPPERS.has(basename(words[start]).toLowerCase())) start += 1;
        if (start < 0 || start >= words.length) continue;
        const name = basename(words[start]).toLowerCase().replace(/\.exe$/, '');
        const operands = words.slice(start + 1).filter((word) => !word.startsWith('-'));
        if (!operands.some((word) => namesFile(word, posix))) continue;
        if (WRITE_ANY.has(name)) return true;
        if (WRITE_LAST.has(name) && namesFile(operands.at(-1), posix)) return true;
        if ((name === 'sed' || name === 'perl') && words.some((word) => /^(?:-[A-Za-z]*i|--in-place)/.test(word))) return true;
    }
    return /\bof=(?:\S*[/\\])?\.aimhooman\.json/i.test(text);
}

// find -exec git add {} \; and git add inside a substitution leave no add to read:
// the paths come from find or from the substitution.
const GIT_GLOBALS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S*)?)){0,8}`;
const FIND_ADD = new RegExp(String.raw`-(?:exec|execdir|ok|okdir)\s+(?:\S*[/\\])?git(?:\.exe)?${GIT_GLOBALS}\s+add\b`, 'i');
const SUBSTITUTED_ADD = new RegExp(String.raw`(?:\$\(|<\(|>\(|\x60)\s*(?:\S*[/\\])?git(?:\.exe)?${GIT_GLOBALS}\s+add\b`, 'i');

function hiddenAdd(text) {
    if (!/-(?:exec|ok)|\$\(|<\(|>\(|`/i.test(text)) return null;
    const hit = FIND_ADD.exec(text) ?? SUBSTITUTED_ADD.exec(text);
    if (!hit) return null;
    const rest = text.slice(hit.index + hit[0].length).split(/[;&|\n]/, 1)[0];
    return { force: /(?:^|\s)(?:-[A-Za-z]*f[A-Za-z]*|--f(?:o(?:r(?:c(?:e)?)?)?)?)(?:[\s=]|$)/.test(rest) };
}

// The reason an agent may not run this line, or null. posix is false for the
// PowerShell and cmd tools, where a backslash separates directories.
export function policyChangeReason(parsed, command, { posix = true } = {}) {
    const text = String(command ?? '');
    const adds = parsed.commands.filter((candidate) => candidate.verb === 'add');
    const commits = parsed.commands.filter((candidate) => candidate.verb === 'commit');
    const hidden = hiddenAdd(text);
    // The opaque flag of a PowerShell or cmd line is set for every line of the tool.
    const mayCommit = commits.length > 0 || Boolean(parsed.commit)
        || (posix && Boolean(parsed.opaqueCommitHiding) && /\bgit\b/i.test(text));
    if (!adds.length && !mayCommit && !hidden) return null;

    resolved.clear();
    // One look at each directory and each repository: a line can hold hundreds of adds.
    const repos = new Map();
    const places = new Map();
    const repoAt = (cwd) => {
        if (!places.has(cwd)) {
            let found = null;
            try {
                const repo = openRepo(cwd);
                if (!repos.has(repo.root)) repos.set(repo.root, repo);
                found = repos.get(repo.root);
            } catch { /* not a repository */ }
            places.set(cwd, found);
        }
        return places.get(cwd);
    };
    let here = null;
    try { here = repoAt(process.cwd()); } catch { /* a working directory that is gone */ }
    const states = new Map();
    let writes;
    const stateOf = (repo) => {
        if (!states.has(repo.root)) {
            writes ??= writesPolicy(text, posix);
            states.set(repo.root, writes ? 'written' : policyState(repo));
        }
        return states.get(repo.root);
    };

    if (mayCommit) {
        for (const repo of new Set([here, ...commits.map((candidate) => repoAt(candidate.cwd))])) {
            if (repo && stagedPolicy(repo) && !reviewedMigration(repo)) return POLICY_CHANGE_REASON;
        }
    }
    const forced = Boolean(hidden?.force)
        || adds.some((candidate) => readAdd(dropRedirects(candidate.args ?? [])).force);
    for (const candidate of [...adds, ...commits]) {
        const repo = repoAt(candidate.cwd);
        if (!repo) continue;
        const need = candidate.verb === 'add' ? addNeed(candidate, repo.root, posix) : commitNeed(candidate, repo.root, posix);
        if (need && takes(stateOf(repo), need)) return POLICY_CHANGE_REASON;
        if (candidate.verb === 'commit' && commitIsOpaque(candidate, posix) && takes(stateOf(repo), { force: forced })) {
            return POLICY_CHANGE_REASON;
        }
    }
    if (hidden) {
        for (const repo of new Set([here, ...adds.map((candidate) => repoAt(candidate.cwd))])) {
            if (repo && takes(stateOf(repo), { force: hidden.force })) return POLICY_CHANGE_REASON;
        }
    }
    return null;
}
