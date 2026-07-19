# FAQ

**Is this a way to hide AI use?** No. aimhooman removes operational residue and
establishes human ownership. It never changes author, committer, signature, or
timestamp, and the compliance profile keeps any disclosure your policy requires.

**Will it cancel my commits?** On the default `clean` profile, aimhooman first tries to
exclude or unstage hygiene artifacts and safely remove exact attribution lines. The
commit proceeds if no block remains; a scan that runs over budget warns and continues.
A pre-existing tracked block, failed unstage/repair, or unterminated exact attribution
still stops the operation, and the final `reference-transaction` guard vetoes a commit
it cannot fully scan, on every profile. `strict` cancels findings instead of repairing,
and treats an incomplete scan as a stop.

**Does it slow commits down?** The staged check runs locally with no network and reads
Git objects in batches. Text-oriented rules skip binary files. Size and total budgets
are visible in reports. Files over 2 MiB or a scan over 64 MiB make the scan
incomplete: direct checks and the Git pre-commit guards warn on `clean`/`compliance`
and stop on `strict`, and the final ref guard stops on every profile rather than
claiming that content was checked.

**Can the agent bypass it?** Any local tool can ultimately be bypassed by a user with
commit access. The agent guard fails closed on what it cannot prove: empty, invalid,
or non-object hook JSON, missing managed final guards, and hook or receive-pack
indirection around protected ref mutations are denied on every profile, and `strict`
additionally rejects `--no-verify`, unknown executor shapes, and uncertain commit
execution. Read-only commands and pipelines run; the guard stands between the agent
and protected Git mutations, not between you and reading a repository. Git hooks are
not a sandbox: an editor or another local program started during a commit has the same
filesystem access and can change a later hook. Wrappers that can select another cwd or
filesystem namespace (`sudo`, `chroot`, WSL, sandbox launchers) fail closed on every
profile; retry as a direct Git command from the target repository. Treat local
executables and Git config as trusted. For team enforcement, scan the actual PR range
in CI (a normal CI checkout has no staged changes):

```sh
git fetch origin main
aimhooman check --range origin/main...HEAD --profile strict
```

On GitHub Actions, configure `actions/checkout` with `fetch-depth: 0` so the
triple-dot merge base is available.

`pre-commit` and `commit-msg` do not cover every sequencer or ref movement. The managed
`reference-transaction` hook therefore checks introduced commits during Git's prepared
phase and can abort the local ref update. Git 2.54's earlier `preparing` callback is
accepted for compatibility and checks guard integrity; scanning remains in `prepared`,
after references are locked.
CI still scans the exact pushed or PR history:
local hooks do not govern another clone, server-side updates, or history created before
the guard was installed.
Bare repositories have no worktree/index boundary and are not supported by local commands.
A submodule is a separate repository with separate state and hooks; run `aimhooman init`
inside each submodule that needs local enforcement.

**What about secrets?** aimhooman does not scan for secrets since v0.3.0 and never
did history cleanup. A committed credential is exposed: rotate it, then run a
dedicated scanner over the repository. [docs/secrets.md](secrets.md) explains the
reasoning and shows the gitleaks setup we recommend.
