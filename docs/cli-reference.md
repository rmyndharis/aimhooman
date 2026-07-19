# CLI reference

```
aimhooman init | status | check | audit | scan | explain | allow | deny | override | review | policy-review | fix | doctor | uninstall | version
```

## Install and init

Node 22.8+ and Git 2.28+, zero runtime dependencies, ships as source. Git 2.28
is required for the prepared-phase reference transaction guard that checks
cherry-pick, revert, rebase, `git am`, and other ref-producing flows.

```sh
npm install -g @rmyndharis/aimhooman
```

Guard a repository:

```sh
aimhooman init        # git hooks + local excludes; normally no worktree files
aimhooman init --gitignore # also write the managed AI-artifact block to the worktree .gitignore
aimhooman status
aimhooman uninstall   # restore hooks/excludes; keep local policy state
aimhooman uninstall --purge-state # also delete common Git-directory state
```

`init --gitignore` is the opt-in for teams that want the ignore set committed:
it writes the same managed pattern block into the worktree `.gitignore`,
records the choice in the local config, and prints a notice to commit the file
so every clone shares it. `status` shows the recorded choice, and `uninstall`
removes the block (and the file, if aimhooman created it and nothing else
remains). The default stays local: `.git/info/exclude` only.

Two honest edges. `uninstall` deletes the `.gitignore` itself only when
aimhooman created it and the removed block leaves it empty — if you committed
the file, that deletion is a tracked worktree deletion you then commit or
restore. And the opt-in record lives in the common Git directory, so linked
worktrees share the choice while each worktree keeps its own `.gitignore`.

For commits you make at the terminal (outside your AI tool), one global setup guards
eligible non-bare repositories that do not override `core.hooksPath` locally:

```sh
aimhooman init --global --yes # advanced: change core.hooksPath after confirmation
aimhooman uninstall --global # unset it
```

Global `core.hooksPath` changes Git behavior for repositories that inherit it and can
replace their default hook directory. A local or worktree-scoped override takes
precedence. Bare repositories are outside the worktree/index policy boundary and the
global dispatchers leave them unchanged. `status` shows both local and global values.
Prefer repository `init` unless the global ordering is understood.

When `core.hooksPath` is set, Git reads hooks only from that effective directory and
ignores `.git/hooks`. Repository `init` installs and chains predecessors only when
that directory is absent or is proven to be owned by the repository: inside it and
not tracked by Git. It refuses to modify a global, shared, external, or tracked
hook directory, because a dispatcher committed from one machine names paths that
exist only on that machine. Those repositories are not guarded, and there is no
way to guard them today. Calling `aimhooman precommit` from an existing hook
manager runs the check but registers no managed guard, so the agent hook still
refuses the commit. Remove the override before retrying, or accept that the
repository is unguarded and do not run `init` there.

Repository `init` installs `pre-commit`, `pre-merge-commit`, `commit-msg`,
`reference-transaction`, and `pre-push`, and preserves an existing hook as a
predecessor. For
`commit-msg`, aimhooman pins the would-be tree before the predecessor runs, so a later
index change cannot select a weaker policy. The prepared reference transaction is the
last local check for cherry-pick, revert, rebase, `git am`, fetch/worktree branch
creation, and direct branch-ref updates. The `pre-push` hook scans every commit a push
would introduce — including one pushed by raw object ID, which moves no local branch
and therefore never passes the reference-transaction guard. Every profile stops if a
predecessor removes
a required guard; the first running dispatcher that detects the loss aborts the
operation.

## Commands

`check` accepts one Git target (`--staged`, `--tracked`, `--commit <rev>`, or
`--range <base>...<head>`), plus `--message <file>`, `--profile`, and `--json`.
Commit and range targets read commit messages from Git automatically. A range scans each
introduced commit, so a bad file added and deleted before the endpoint is still reported.
Use an all-zero object ID as the base when there is no prior commit; this includes the root
commit. Deleting an ordinary forbidden path is not itself a finding, while removing or
lowering a versioned strict project policy still needs a bound policy review.
`audit` and `scan` are aliases for a full tracked-index scan.
`init --global --yes` and `uninstall --global` manage the advanced terminal-Git guard;
`uninstall --global` cannot be combined with the local `--purge-state` option.
`fix` follows the active profile: clean writes an exact safe repair, compliance makes no
change, and strict previews unless `--apply` is supplied.
`allow` resolves a finding by path or rule ID; an allow entry's scope is `path` or
`rule` (see [docs/policy.md](policy.md#overrides)).

On `clean` and `compliance`, `check`, `fix`, and the commit hooks warn and continue
when a scan is incomplete; `strict` exits 31 instead. The final ref guards
(`reference-transaction`, `pre-push`) stay fail-closed on every profile and still
veto what they cannot fully scan — with one carve-out: a scan whose only gap is a
file over the per-file size budget warns and continues on `clean`/`compliance`,
because path rules still covered that file.

Machine reports use `schema_version: 1` and include target policy identity, completeness,
scan statistics, commit and object metadata. Schemas are published in [`schemas/`](../schemas/).

For an existing repository, start with `aimhooman audit --json`. If a residue path is
already tracked, remove it from the index with `git rm --cached <path>` and add an
appropriate ignore/exclude. aimhooman does not scan for secrets; if one was committed,
rotate it first — [docs/secrets.md](secrets.md) covers why and what to run instead.
History cleanup is deliberately outside aimhooman's scope.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | clean, or non-blocking review |
| 10 | policy violation (block) |
| 11 | review-required on a non-clean profile |
| 20 | usage, configuration, or rule-pack error |
| 30 | Git or I/O error |
| 31 | scan incomplete on `strict`, or at the final ref guard for any gap other than a per-file size-limit on `clean`/`compliance` (those warn and continue) |
