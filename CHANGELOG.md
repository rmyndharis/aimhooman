# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This batch works through the findings of the cross-ecosystem field test
(8 upstream clones, 6 language loops, a local bare remote, and a private
GitHub sandbox). The headline: `allow` no longer says yes when it means no —
a path allow on a file whose content holds a secret is refused up front,
with the working escape hatch named in the same breath.

### Fixed

- Tracked-tree scans (`audit`, `check --tracked`, `init --grandfather-secrets`)
  no longer die with `spawnSync git EPIPE` on a partial clone of a repository
  with submodule pins. A gitlink names a commit of another repository, so
  asking `cat-file` about it triggered a promisor fetch that aborted the
  whole metadata batch ("not our ref"). Gitlinks now skip the metadata read;
  their type comes from the mode. Found by the OpenSSL field run, whose 11
  submodule pins made the grandfather flag seed zero allows.
- `init --grandfather-secrets` now runs its one-shot tracked scan with the
  total-byte budget raised to the env cap and the finding budget raised to
  100,000. The commit-time defaults (64 MiB, 1,000 findings) silently missed
  fixtures beyond them in exactly the large, fixture-heavy repositories the
  flag exists for; the per-file budget and an explicit env override still
  apply.
- `aimhooman allow <path>` on a file whose content matches a secret rule
  (e.g. a private key inside an ordinary-looking filename) no longer reports
  `allowed` while the commit stays blocked. The guard now runs the engine's
  secret content rules over the file's bytes, refuses the allow, and points
  at `--scope secret-path`. Files over the scan budget or unreadable skip
  the check; the commit-time scanner still fails closed on those.
- The scan-incomplete summary now names what was skipped
  (`skipped: size-limit=1 file`) instead of `(size-limit=1)`, which read as
  a one-byte budget rather than a count of files.

### Added

- `aimhooman init --grandfather-secrets`: after a successful init, scan the
  tracked tree once and write a `--scope secret-path` allow for every path
  already tracking secret-looking material (test certs, sample keys). New
  secrets stay blocked; only paths found in that scan are allowed. A failed
  or incomplete scan warns without failing the init.
- Provider-token findings name the provider in human output
  (`A provider access token (GitHub) must not enter Git history.`), so the
  developer knows which credential to revoke. The token itself stays
  redacted; the JSON report is unchanged.
- Secret content rules now carry a remediation line naming the fixture
  escape hatch: `aimhooman allow <path> --scope secret-path --reason
  "test fixture"`.
- The pre-commit hook now names locally-ignored AI artifacts once per set
  change (`3 AI artifact(s) present locally are kept out of commits: ...`).
  The prevention layer keeps them out of `git status`, which also kept their
  exclusion silent: a `git add .` never told the developer the chat log did
  not make the commit. The worktree walk is pathspec-pruned to the managed
  exclude patterns, so it costs ~15ms; informational only, it never changes
  an exit code.
- The reference-transaction veto now notes that the rejected commit object
  remains in the local object store — collected by `git gc --prune=now` when
  nothing else references it — so a secret payload is not mistaken for gone.

### Changed

- Repeated findings of the same rule print the remediation once, then
  `fix: as above for <rule id>`, instead of reprinting an identical fix
  block for every hit.
- `init` output now prints `undo: aimhooman uninstall` and notes that known
  AI artifacts are ignored locally (`git status --ignored` shows them).

### Performance

- `openRepo` resolves the repository in one `git rev-parse` call instead of
  three; every hook spawn pays this, so it was the cheapest milliseconds on
  the commit path. The common-dir answer is resolved against the invoking
  cwd and canonicalized, preserving the previous spelling on symlinked
  paths (macOS `/tmp`), and a path containing a newline falls back to one
  flag per call.
- The reference-transaction dispatcher exits before the Node spawn for a
  `prepared` transaction that moves neither a branch nor HEAD (ORIG_HEAD,
  tags, remote-tracking refs). Such payloads carry nothing `refcheck`
  scans — but the skip first proves the four dispatchers are still
  installed, so a hook manager wiping them mid-operation is answered with
  a stop, not silence. An ordinary commit's hook time drops by roughly a
  third in the field measurement (982ms → 649ms).
- Installed Git hook shims export `NODE_COMPILE_CACHE` pointing at a
  per-install directory under the state dir (removed by
  `uninstall --purge-state`), shaving the module parse/compile cost off
  each hook spawn. An unwritable cache dir degrades to the old cold start,
  never to a hook failure.

## [0.1.8] - 2026-07-18

This release works through the findings of the real-world scenario report
(191 scenarios across 11 repos, 8 languages). The headline: a read-only
command copied from `gh`'s own docs no longer gets denied, and editing an
unrelated line in a file that carries a private-key header elsewhere no
longer blocks the commit.

### Fixed

- Read-only commands with unquoted braces (`gh api repos/{owner}/{repo}/pulls`,
  `ls {owner}`, `cp x.{js,ts}`) are no longer denied as opaque commit-hiding
  pipelines. Brace expansion is argument-level and cannot feed code into a pipe
  sink; brace groups (`{ list; }`) and PowerShell script blocks remain opaque.
  The opaque-deny message also no longer names a pipe when the command has none.
- Editing an unrelated line in a file that contains a private-key header
  elsewhere (e.g. a PEM fixture inside a Go test string) no longer blocks the
  commit. Content scanning is now narrowed to the changed hunks; a header added
  in the diff still blocks, a header carried outside the diff stays silent.
  Binary blobs keep their whole-blob secret scan.
- AWS's documented example secret access key (`wJalrXUtnFEMI/...EXAMPLEKEY`)
  no longer blocks commits. Its access-key-ID pair was already excepted; the
  secret-key half now is too. Real keys — including ones containing `EXAMPLEKEY`
  as a substring — still block.
- `aimhooman <subcommand> --help` now prints usage and exits 0 instead of
  erroring on the unknown `--help` option.
- The human finding report renders every remediation entry (a rule's second
  line, e.g. "rotate the key if it was ever exposed", was silently dropped), and
  its summary line agrees on number (`1 finding`, not `1 findings`). A scan
  firing many findings (a vendored OpenSSL corpus can produce 99) now caps the
  printed blocks at 20 and collapses the rest into one truncation line; the JSON
  report stays uncapped.
- The `secret.private-key` message now states the match is by filename, not by
  content, and offers renaming the file when the name is coincidental.
- A chained hook predecessor that resolves sibling scripts via `$(dirname "$0")`
  — the dominant husky and vanilla `.githooks` pattern — no longer breaks after
  `aimhooman init`. The dispatcher now sources the predecessor in a subshell,
  which preserves the original `$0`. (Bash-only predecessors remain out of
  scope.)

### Changed

- **Breaking:** an untracked `core.hooksPath` inside the worktree (a freshly
  created `.husky` before its first commit, a team-local `.team-hooks`) is now
  treated as repository content and refuses to receive a dispatcher — the next
  `git add` would otherwise stage the dispatcher's machine-local absolute CLI,
  Node, and PATH into history. Add the path to `.gitignore` or
  `.git/info/exclude` to keep it local; the refusal message names this and
  points at `aimhooman uninstall`. A `.git/hooks/` path and a tracked `.husky`
  are unaffected.
- `aimhooman review` advisories now persist per path across edits on the
  `clean` and `compliance` profiles, so editing a reviewed agent-instruction
  file (CLAUDE.md, AGENTS.md, `.github/copilot-instructions.md`) no longer
  re-surfaces the review message on every edit. The `strict` profile keeps the
  exact-blob binding unchanged; reviewed deletions (tombstones) keep it in every
  profile.
- The `aimhooman init` refusal message names the two remedies (unset
  `core.hooksPath`, or exclude the worktree path) and points at
  `aimhooman uninstall`, so a refused init is no longer a dead end.

### Performance

- A commit no longer pays a duplicate tree scan in `commit-msg` for the staged
  tree that `pre-commit` just verified. `pre-commit` records the staged tree sha
  after a clean, complete scan; `commit-msg` skips its ~170 ms tree scan when the
  sha matches. The marker is self-invalidating (any index mutation changes the
  sha) and a missing/stale/mismatched marker falls back to the full scan, so
  this is purely an optimization. Net ~150 ms saved per commit.

## [0.1.7] - 2026-07-18

### Fixed

- The final reference guard no longer holds a branch hostage to a file already
  in its history. A commit was scanned against the full tree it inherited, so a
  path allowed in once and then un-allowed blocked every later commit on the
  branch, even one-line edits to an unrelated file — and the only way out was to
  rewrite history. The guard now judges a commit by what it changes: a newly
  staged `.env` still stops the commit, while a file the commit merely carries
  forward from its parent stays silent. A secret already in history is not
  forgotten — `aimhooman check --tracked` still names it — but it no longer
  bricks the branch.
- Imported history no longer trips the attribution guard. `gh pr checkout` and
  `git fetch` bring in other people's commits, whose messages a local developer
  cannot edit; scanning them for AI co-author trailers blocked the checkout
  whenever a PR commit carried one. The guard now scopes attribution and marker
  rules to commits written in the repository (a plain commit, an `--amend`, a
  local merge), and leaves imported commits' messages alone. A locally authored
  `git commit --no-verify` that smuggles the same trailer is still stopped at the
  final guard.
- `aimhooman status` no longer advertises a profile the hooks are not applying.
  The enforcing guards resolve the project policy from the index, so a worktree
  `.aimhooman.json` that has not been `git add`ed was invisible to them — yet
  `status` reported its profile as active. `status` now shows the staged profile
  the hooks actually enforce, prints the worktree value alongside when the two
  differ, and names the remedy (`git add .aimhooman.json`).
- A pipeline into a shell with no commit in it is still refused, but the reason
  no longer tells the developer to retry a commit they never wrote. The deny
  text for `echo x | bash` and similar now names the real shape — a pipeline
  whose sink can run arbitrary commands — instead of reusing the commit-themed
  message.
- A timing or scheduling prefix no longer reads as a hook bypass. `time`,
  `timeout`, `nice`, and `ionice` run the inner command with the same argv in the
  same place, so `time git commit` is judged like `git commit` instead of being
  refused as opaque shell indirection. The carve-out only applies when nothing
  else injects risk; a `--no-verify` or a hooks-path override wrapped in the
  prefix is still caught.

## [0.1.6] - 2026-07-18

### Fixed

- A tracked file over the per-file scan budget no longer blocks every commit in
  the repository. 0.1.5 content-scanned the whole tree on every commit, so a 3 MiB
  vendored bundle that crossed the 2 MiB default budget wedged every later commit
  with `scan incomplete (size-limit=1)` — even one-line edits to an unrelated file
  — and the only way out was to raise the budget above the largest tracked file.
  Path rules still run on the full tree, so a staged `.env` stays blocked, but the
  content scan now reads only the files a commit actually changes. Editing the
  oversized file itself still fails the commit until the budget is raised.
- An oversized file that is binary now skips as `binary` (complete) instead of
  `size-limit` (incomplete). A PSD, WOFF, or PNG cannot hide the text-pattern
  secrets the content scan looks for, so it was never really an incomplete scan.
  The first 8 KB of each oversized file is probed for a NUL byte to tell binary
  from text; files above 16 MiB stay `size-limit` without probing, because
  `cat-file --batch` reads the whole blob into memory and probing a 500 MB file
  just to check for NULs is not worth it. A text file over budget stays a real
  `size-limit` skip, and the owner must raise `AIMHOOMAN_MAX_FILE_BYTES` to cover
  it.
- `secret.dotenv` now excepts `*.minimal`. A `.env.minimal` shipped as a template
  was blocked by the same rule that catches a real `.env`, because `*.sample`,
  `*.template`, `*.dist`, and `*.defaults` were excepted but `*.minimal` was not.
  The rule's version bumps to 4.

### Added

- Incomplete-scan messages name the files that were dropped and why. A budget
  miss used to print a count (`size-limit=3`) with no path, so the owner had to
  hunt for the offender. The CLI now lists up to five skipped paths with their
  sizes and reason, and the JSON scan report carries a `skippedPaths` object so a
  caller can see every dropped file the same way. The schema documents the field.
- `aimhooman explain` prints a rule's `except` clause when it has one, so an
  `allow`/`deny` override can be reasoned about without opening the rule pack.

## [0.1.5] - 2026-07-18

### Fixed

- AWS's own published example key no longer blocks a commit. 0.1.4 began matching bare
  `AKIA…`/`ASIA…` access key IDs, which also matched `AKIAIOSFODNN7EXAMPLE` — the value AWS
  prints in its own documentation, and one that lands in READMEs, Terraform samples, and test
  fixtures. Because the rule's category is `secret`, neither a rule allow nor a plain path
  allow is accepted, so a documentation example became an unconditional block on every profile
  with only a per-file escape. Every AWS example key ends in `EXAMPLE`, so the pattern now
  excludes that suffix and keeps blocking real keys. Path scoping was deliberately not used:
  excluding `docs/` or `tests/` from secret scanning would hide genuine keys in the places they
  most often leak.
- `uninstall --purge-state` no longer leaves a backup behind in a linked worktree. Git writes
  the commit message file into the per-worktree Git directory, so 0.1.4's sweep — which looked
  only in the common directory — printed "state purged" with `COMMIT_EDITMSG.aimhooman-bak`
  still on disk. Uninstall disarms every worktree at once, so it now sweeps the main Git
  directory and each linked one, and matches the `.aimhooman-bak` suffix so a backup left by a
  merge goes with it.
- A plain `uninstall` keeps the attribution backup. It printed "state kept" and then deleted
  the one file holding the lines stripped from the last commit message. Only `--purge-state`,
  which promises to remove everything, takes it now.
- Sweeping an empty lock queue can no longer stop a concurrent `aimhooman init`. Between its
  `mkdir` and its first publication a lock contender owns no file in the queue, so the sweep
  saw an empty directory and removed it, and the contender then failed on a bare `ENOENT`. The
  window is wide enough to lose because building the candidate probes the process identity,
  which spawns `ps` on macOS and BSD. Publication now recreates the directory and retries once.
- The unstage summary no longer claims the files were "kept in your working tree". That is
  false when a path was staged and then deleted before the commit, and when a staged deletion
  is unstaged — the file is absent either way, though aimhooman never removed it. Unstaging
  only ever touches the index, so the note says that instead of guessing where the file is.

### Changed

- An ordinary commit no longer pays a Node cold start for a phase that does nothing. Git fires
  `reference-transaction` twice per commit, and `refcheck` returns immediately for `committed`
  and `aborted`, so the dispatcher now short-circuits those phases in the shell — after the
  chained-hook call, so a chained hook still sees every phase. Measured locally, an ordinary
  commit drops from about 870ms to about 710ms. The `prepared` scan, and the `--no-verify`
  backstop that rides on it, are unchanged. A repository installed with an earlier release
  keeps a valid dispatcher; re-run `aimhooman init` to pick up the faster one.
- The attribution backup no longer lingers indefinitely. `commit-msg` clears the previous run's
  backup before it may write its own, so at most one exists at a time and a later clean commit
  leaves none. The recovery window is now until your next commit rather than unbounded.

## [0.1.4] - 2026-07-18

### Fixed

- Uninstall no longer leaves aimhooman artifacts in `.git`. Every atomic write takes a
  lock whose `<lock>.queue` directory was created but never removed — the release path
  only unlinked its own candidate file — and `--purge-state` cleared just the state
  directory. So `.git` kept the queue directories and the `COMMIT_EDITMSG.aimhooman-bak`
  attribution backup while the command printed "state purged". Uninstall now sweeps this
  residue once the lifecycle lock releases; `rmdirSync` removes only an empty directory,
  so a concurrent contender's queue is never touched, and the lifecycle queue is removable
  precisely because its own lock has already released. A plain uninstall keeps policy
  state and drops the operational residue; `--purge-state` leaves no aimhooman fingerprints.
- A bare AWS access key ID is now detected. `secret.aws-key-content` fired only when an
  `aws_secret_access_key` or `aws_session_token` name sat beside the value, so an
  `AKIA…`/`ASIA…` access key ID committed on its own passed clean. The rule now matches the
  access-key-ID prefixes directly — the fixed-prefix, highest-confidence AWS indicator. The
  16-character body and word boundaries keep short lookalikes such as `AKIA123` from matching.

## [0.1.3] - 2026-07-18

### Fixed

- Repair that empties the index no longer mints an empty commit. Stage only a `.env`,
  run `git commit -m "add config"`, and the pre-commit repair unstages it and prints
  "the commit will be empty" — then Git made that empty commit anyway. Git refuses a
  commit with nothing staged, but repair runs after Git has already decided to proceed,
  so carrying on created a commit Git would never have made and left a junk commit to
  `git reset --hard`. Pre-commit now exits 10 when the repair empties the index, so Git
  stops. Nothing else staged means nothing to commit.
- `build && git add . && git commit` is no longer denied. Each half already passed on its
  own; only the pair was refused. The commit-time-staging deny asked the wide bypass
  predicate — the one that decides whether the staged-content backstop reads the blobs —
  instead of the narrow question of whether anything will scan the commit. An unmodelled
  prefix is not a bypass, and pre-commit still scans the real index at commit time. The
  deny now asks that narrow question. A prefix that reaches the hooks, `--no-verify`, and
  a real `core.hooksPath` override all keep the deny, where the staged files really would
  go unscanned. The refusal message no longer names "--no-verify or shell indirection"
  when neither is present.
- The `PreToolUse` guard stops refusing more everyday read-only pipelines. Building on the
  0.1.1 filter allowance, a read-only Git subcommand is now an allowed pipe source, so
  `git log | head`, `git status | grep modified`, `git diff | cat`, and
  `cd repo && git log | head` run. Build and test toolchains (`npm`, `cargo`, `make`,
  `jest`, `eslint`, `tsc`, `pytest`) are allowed as a source. The listing forms of
  branch/tag/remote/stash/notes run (`git branch | grep`, `git remote -v | grep origin`),
  while their mutating forms (`git branch -D`, `git tag v1`) stay denied. Git as a pipe
  sink, `git commit --no-verify`, and `git push` still deny; the reference-transaction and
  pre-commit hooks remain the boundary.

## [0.1.2] - 2026-07-17

### Removed

- The legacy per-clone state migration is gone, and with it the failure paths it
  created. `openRepo` used to look for state under `.git/worktrees/<name>/aimhooman`
  and migrate it into `<commonDir>/aimhooman`, fingerprinting both and refusing to
  continue when two copies disagreed. No released version ever wrote to that
  location — v0.1.0 already resolved state to `<commonDir>/aimhooman` on the line
  above the migration — so the predecessor it protected never existed. What it did
  produce was real: any error other than ENOENT while listing `.git/worktrees` was
  re-raised through every command, including `uninstall`, so a directory Git itself
  reads without trouble could freeze a repository with no supported way out.
  `.git/worktrees` belongs to Git and can be owned by another uid after a
  `sudo git worktree add`. Repository state resolves to `<commonDir>/aimhooman`, as
  it always has.

### Fixed

- Unstaging residue no longer stages the deletion of tracked files. The HEAD probe
  reused the options object carrying the pathspec on stdin, and `git rev-parse`
  never reads stdin, so once the pathspec passed the 64 KiB pipe buffer the write
  failed with `EPIPE`. The catch read that as "this repository has no HEAD" and ran
  `git rm --cached` where `git restore --staged` was meant, staging the deletion of
  every tracked path it had been asked to restore, printing "unstaged N AI
  artifact(s)", and exiting 0 so the commit carried the deletions into history. It
  takes roughly 470 paths to cross that buffer, which a tracked `.claude/projects/`
  tree passes without trying, and the repair loop could not see it: the staged
  deletions read as still-staged, so it retried, made no progress, and reported
  success anyway. The probe no longer receives the pathspec, and only git's own exit
  status may pick the branch — a timeout or a missing git stops the commit instead
  of guessing that HEAD is absent. Present since 0.1.0.
- A stuck `git` no longer holds a repository open indefinitely. `execFileSync` has
  no default timeout, so a child that never exited blocked its caller for as long as
  it lived, with nothing printed and nothing logged; one held a CI runner for six
  hours and died to the platform's ceiling rather than to anything here. Every child
  process now carries a bound: 120 seconds for git, far above any real call, and 5
  seconds for the `ps` identity probe, which runs inside the lock retry loop and only
  on macOS and BSD (Linux reads `/proc`, Windows returns early). Both throw into the
  handling that was already there, so a bounded failure degrades the way a missing
  git already did instead of hanging. A test walks `src/` and `bin/` and fails on any
  child process without a bound.
- Renaming or moving a repository no longer freezes it. The dispatcher bakes
  absolute paths, so a move changes the `CHAINED` value it carries, and ownership
  was decided by comparing that string — overruling the SHA-256 fingerprint on the
  line above, which had already proved the file was ours. Every commit, every
  `--no-verify`, and every branch creation then failed; `status` reported the guard
  as belonging to another repository; `aimhooman init`, the remedy each message
  named, refused too. Ownership inside the repository's own `.git` is now settled
  by the fingerprint alone, because no second repository can own a file there. The
  baked path keeps its vote only where a hooks directory can genuinely be shared —
  two repositories pointing `core.hooksPath` at one place — which is the case it
  was written for.
- `uninstall` no longer reports success while leaving its own dispatchers behind.
  Refusals were recorded as warnings, the exit code only consulted failures, and
  the "uninstalled" headline printed before either was known, so a moved
  repository was told it was free while four dispatchers still blocked every
  commit. uninstall now checks the hooks directory instead of trusting its own
  report: anything of ours still on disk is named with its full path, the headline
  is withheld, and the exit code is 30. A chained backup that is a symlink is
  still never read or copied through, but the dispatcher above it is now removed
  rather than held as collateral, and the report says the original hook was not
  restored.
- A `HOME` behind a symlink no longer makes every global dispatcher look foreign.
  `hookDiagnostics` compared the effective hooks directory to the global one with
  `resolve`, which does not follow symlinks, while Git reports the realpath — so
  on a distribution that ships `/home` as a link, or an NFS or autofs home, the
  two spellings differed and every global hook was diagnosed as managed for
  another repository.
- A failed excludes refresh no longer disables the `PreToolUse` guard. Writing
  `.git/info/exclude` sat inside the same `try` as the engine load, and the shared
  `catch` allowed the command on every non-strict profile, so an unwritable
  `.git/info` — a CI checkout, a read-only volume, a repository owned by another
  user — turned a staged AWS key plus `git commit --no-verify` from `deny` into
  `allow`. Nothing about the policy was wrong: the rules had loaded, and the
  reported cause ("could not load policy rules") named the wrong thing. Refreshing
  the excludes is gitignore hygiene, which `pre-commit` never does and still
  answers correctly, so it now runs outside the verdict and reports as a warning.

- A local rule pack that cannot load no longer produces a report claiming a
  complete scan. `strict` already failed closed, but `clean` and `compliance`
  turned the load error into a stderr warning and left the accumulator untouched,
  so `--json` returned `complete: true`, `findings: []`, `skipped: {}` and exit 0
  while the team's own rules had never run. The pack most teams write is a
  detector for their internal token format; one typo took it out of the scan, and
  the report actively certified that nothing was missed. A failed pack is now the
  counted skip reason `local-pack-error` and marks the scan incomplete, which is
  the treatment `local-input-limit` already had in every profile: a rule that
  never ran is a coverage gap, not an empty result. `clean` and `compliance`
  therefore stop at exit 31 where they previously continued. The hint now points
  at the pack instead of suggesting the caller reduce the target or limits, which
  was never the remedy for a pattern that will not compile.
- Creating a branch no longer rescans the entire repository. A new branch arrives
  with an all-zero old tip, so `rev-list` ran with no negative boundary and every
  ancestor was re-read, tree and blob sizes included: 24.7s at 200 commits, growing
  linearly, on an operation `--no-verify` cannot skip. Reachability from
  `refs/heads/*` is now trusted, because those commits passed this same guard when
  their branch was written, which puts `git checkout -b` back at ordinary commit
  cost (0.95s in the same repository). Only `refs/heads/*` counts: tags and remote
  refs are not gated here and still cannot pre-poison reachability, the refs under
  review are never their own proof, and a commit no local branch reaches is still
  scanned in full. Commits that predate `aimhooman init` are outside the guard's
  scope; audit them with `check --range`.
- `init` no longer writes dispatchers into a hooks directory that Git tracks.
  Ownership was tested by location alone, so any `core.hooksPath` inside the
  worktree counted as the repository's own — including the committed `.husky` and
  `.githooks` directories that husky and the vanilla pattern rely on. init edited
  those tracked files in place, and the dispatcher it wrote carries this machine's
  absolute CLI, Node, and PATH: once committed, the hook is dead for every
  teammate, and the PATH alone discloses the author's home directory and installed
  tooling. Ownership now also requires that Git is not tracking the directory, and
  a directory Git cannot be asked about counts as tracked. A refusal now names the
  cause instead of reporting a bare incomplete installation; as before, integrate
  aimhooman into the existing hook manager or remove the override.
- A moved Node interpreter no longer disables the guard silently. 0.1.1 made the
  dispatcher degrade gracefully when the CLI or Node was missing, which is right
  for a half-removed install but wrong for a relocated interpreter: `brew upgrade
  node`, `nvm`, `fnm`, and `volta` all move the `process.execPath` that `init`
  pins, and every hook then warned once and allowed the commit unprotected. The
  conditions now separate by what the user can still do about them. A missing CLI
  still allows the operation, because the package is gone and no guard is wanted.
  A missing pinned interpreter stops the operation and names the path and the
  remedy — but only while a Node exists to run that remedy with, since `init` and
  `uninstall` are both Node programs and the CLI file is inert without one.
  Where no Node is present at all, the dispatcher degrades and says so, because
  refusing there would leave the repository unusable with no supported way to
  remove the hooks. Stopping matches what the CLI already believed —
  `installedHooks` treats an unreachable Node as an inactive dispatcher, so the
  shell was short-circuiting the CLI's own fail-closed path — but only where
  stopping is recoverable. Re-run `aimhooman init` after upgrading Node to re-pin it.
- Attribution rules no longer miss current AI footers. `attribution.generated-with`
  pinned the literal vendor link `https://claude.ai/code`, and the co-author rules
  pinned the display names `Claude`, `Claude Code`, and `Codex`. Once the link was
  rebranded and the display name grew a model suffix, the default footer passed
  through untouched with exit 0 while the older form was still repaired perfectly.
  The rules now anchor on what identifies the machine rather than what marketing
  changes: a co-author trailer is matched by its `noreply@` service address alone,
  and the generated-with link is matched by its shape. A new contract test rejects
  any attribution pattern that pins a vendor URL, so the pack cannot rot back into
  this state without failing CI.
- `attribution.ai-noreply` no longer backtracks catastrophically. `\s*[^<>]+\s*`
  placed three ambiguous quantifiers before a literal `<`, which cost 49s on a
  6400-character trailer that never closes; built-in patterns are exempt from the
  local input cap, so a commit message reached it directly. The redundant
  whitespace quantifiers are gone (`[^<>]+` already spans them), leaving the
  matched language unchanged, and a bounded-cost test now covers the built-in
  message patterns.

## [0.1.1] - 2026-07-16

### Fixed

- Git hooks no longer trap the repository when the aimhooman CLI or Node is
  missing (for example after the package was removed without `aimhooman
  uninstall`). The dispatcher used to exit 127 and abort every commit; it now
  warns once and allows the operation without protection, so a half-removed
  install degrades gracefully instead of breaking Git.
- The `PreToolUse` guard no longer denies ordinary read-only pipelines. Any pipe
  made the parsed command uncertain, and the clean and compliance profiles read
  that uncertainty as a possibly hidden commit, so everyday lines such as
  `gh issue view 1 | tail -5` were blocked. A pipeline now passes when every
  segment is a known read-only command and the line carries no opaque shell
  syntax; everything else stays denied, including pipe-to-shell, subshells,
  `eval`, and readers that execute their own input. `strict` is unchanged.
- A bare `allow <path>` for a path that matches a secret rule (for example
  `.env.minimal`) no longer reports success while leaving the block in place.
  It now fails closed and directs to `--scope secret-path`, the only scope that
  can silence a secret, so a local override cannot hide a possible leaked key.
- Detect secrets renamed to a neutral path. A path-only secret such as `.env`
  was missed when moved to a name the destination scan does not match, because its
  content carries no PEM, AWS, or token shape; the rename-source review now retains
  secret-category findings and reports them on the destination path where the bytes
  live, so clean-profile repair unstages the blob that carries the secret. Deleting
  a secret path remains a non-finding.
- Retry the atomic rename that commits a state write when Windows reports a
  transient `EPERM`, `EACCES`, or `EBUSY`. An antivirus or indexer holding a
  handle on the file aimhooman had just written could kill a lock contender at
  its ticket publication, which surfaced as unrelated failures (a lifecycle-queue
  timeout, or a repair that appeared not to run). A persistent failure, any other
  error code, and every non-Windows platform still fail immediately, and the
  original file is never left partially written.
- The clean-profile repair now verifies it cleared every target and re-runs the
  unstage when a transient git operation under heavy load left a path staged, so
  the repair no longer reports success while an artifact rides through.
- Derive the post-repair empty-commit hint from the staged paths captured
  before repair instead of a second git read after `git restore --staged`. That
  read followed an index write and could transiently report the wrong state
  under heavy load; the derivation is deterministic.

### Changed

- The release workflow runs `npm run verify` before publish instead of `npm test`,
  so the tarball-manifest check and the installed-hook smoke test gate the published
  tag, matching the push workflow.
- Non-hook commands no longer load the PreToolUse shell parser at startup; it is
  imported only for the `hook` subcommand, which speeds up `init`, `uninstall`,
  `check`, `status`, and the rest and gives the lifecycle-lock queue more headroom
  on slow runners.

## [0.1.0] - 2026-07-15

First public release. aimhooman keeps AI coding-agent residue out of Git history
without getting in your way: AI session/state files, secrets, AI attribution in
commit messages, and AI markers left in code.

### Fixed

- Scan staged blob content when an agent tries to bypass `pre-commit` under the
  clean or compliance profile.
- Treat earlier repository or hook mutations as a possible guard bypass, track
  index changes such as `git mv`, and preserve policy-transition risk through
  Git aliases before a compound commit.
- Treat branch-writing `fetch`, `worktree`, `stash`, `bisect`, `remote`, and local
  `push` receiver flows as protected ref mutations; reject explicit or configured
  receive-pack indirection before it can bypass the final hook.
- Require the managed final guards to be present for protected agent Git
  operations on every profile, not only `strict`.
- Ignore local Git replacement refs in policy, history, authorization, and audit
  reads; treat `git replace` as a policy transition in compound commands.
- Scan every index stage during unresolved conflicts so a secret on either side
  cannot be missed.
- Authorize protected-path CI only when the exact workflow-run attempt's actor and
  triggering actor, including their IDs, match the repository owner returned by
  GitHub. Bind that authorization to exact commits, paths, blobs, modes, deletion
  tombstones, and policy migrations; changes not attributed to the owner fail closed.
- Keep the published local rule-pack schema compatible with strict JSON Schema
  validators.
- Prove npm version absence and forward dist-tag movement with bounded retries
  before publish; retry integrity, dist-tag, and provenance reads afterward,
  including idempotent reruns.
- Classify SemVer build metadata correctly when creating GitHub releases.
- Run GitHub Copilot hooks on PowerShell as well as Bash without swallowing
  aimhooman's exit status.
- Render native Windows `PATH` entries in Git Bash syntax inside managed hooks,
  and read reference updates with shell builtins so the hooks do not depend on
  semicolon path parsing or external core utilities.
- Reject shell-expanded and split-worktree targets before alias or policy lookup.
  Leading-tilde forms fail closed on every platform, exactly-two-slash targets
  fail closed on POSIX, and guarded Windows changes reject POSIX-root,
  drive-relative, and incomplete UNC targets.
- Treat non-POSIX executor payloads as uncertain and reject their repository-
  selection syntax before a protected operation can inspect the wrong policy.
- Preserve outer runtime and Git-target environment risks inside nested shell
  payloads, including Bash, POSIX-shell, and Zsh startup-file variables.
- Reject guarded Git operations wrapped by commands that can select another cwd
  or filesystem namespace, such as `sudo`, `chroot`, WSL, and sandbox launchers.
- Reject nested non-POSIX shells and explicit login, interactive, or startup-file
  shell launches before they can redirect repository policy lookup.
- Keep concurrent lifecycle commands queued long enough for the earlier command
  to finish, including the case where that command fails and its successor retries.
- Leave unsupported bare repositories unchanged when they inherit the optional
  global hook directory.
- Accept Git 2.54's early `preparing` reference-transaction callback while
  checking guard integrity there and keeping the full scan in the locked
  `prepared` phase.
- Provision pinned Go 1.25 in test and release workflows so actionlint runs on
  macOS runner images that do not preinstall Go.
- Build the package-manifest private-key fixture at test runtime so a fresh
  strict history scan does not mistake the test source for credential material.
- Scan from empty history when a force-push event names an old commit that is no
  longer fetchable, covering every commit reachable from the replacement head.
- Allow public PEM certificates in the package manifest while rejecting PEM
  files that contain a private-key header.
- Publish to npm from a `v*` tag push: the release workflow installs dependencies,
  runs the test suite, and publishes with npm build provenance authenticated by the
  `NPM_TOKEN` secret. Use Node 24 and SHA-pinned actions.

### Overview

- Vendor-neutral guard with one detection core and a thin adapter per host.
- Repair-first ordinary commits by default: session-start auto-exclude writes known AI
  artifacts to `.git/info/exclude`; `pre-commit` unstages any that slip through;
  `commit-msg` removes complete exact high-confidence attribution lines and reports
  broader candidates without editing them. An unterminated exact final line stops
  unchanged because a byte-safe repair cannot be proved.
- 29 built-in rules across paths, attribution, markers, and secrets.
- Three policy profiles: `clean` (default — repair-first on the ordinary commit path),
  `strict` (opt-in hard enforcement that cancels the commit), and `compliance`
  (repair-first but keeps any AI disclosure a regulated policy requires).
- Any block that cannot be unstaged or repaired stops the commit; a pinned-tree
  and final full-snapshot scan prevent a pre-existing tracked block from riding
  through an unrelated change.

### Enforcement surfaces

- SessionStart auto-exclude for known AI artifacts (local, never `.gitignore`).
- `pre-commit` and `pre-merge-commit` unstage of AI session/state files and
  secrets from the index.
- `commit-msg` removal of complete exact AI attribution lines.
- Prepared `reference-transaction` full-scan of every commit introduced by an
  ordinary commit, cherry-pick, revert, rebase, `git am`, fetch/worktree branch
  creation, or direct ref update.
- `PreToolUse` path advisory plus fail-closed checks on every profile for empty,
  invalid, or non-object hook JSON, missing managed guards, unresolved Git
  commands/aliases, and hook or receive-pack indirection around protected ref
  mutations. Unknown executor argument shapes fail closed on `strict`, which also
  rejects uncertain commit execution and `git commit --no-verify`.
- CLI targets: `--staged`, `--tracked`, `--commit <rev>`, `--range <base>...<head>`,
  `--message <file>`, plus `audit` and its `scan` alias as shorthand for a full
  tracked-index scan.
- Optional `aimhooman init --global --yes` guards terminal Git in eligible non-bare
  repositories that do not override `core.hooksPath` locally.

### Host adapters

- Plugin-tier (live `PreToolUse` guard): Claude Code, Codex, GitHub Copilot CLI.
- Instruction-tier (ruleset text): Cursor, Cline, Windsurf, Kiro, Gemini CLI,
  Gemini Code Assist, Google Antigravity, plus `AGENTS.md` as a universal fallback.
- Host registry in `docs/hosts.json` records adapter, activation contract, and
  verification status for each host.

### Configuration

- Versioned `.aimhooman.json` project profiles with precedence over per-clone
  defaults; an individual `check` may escalate but cannot weaken the team profile.
- Per-clone local rule packs in `<git-common-dir>/aimhooman/rules/*.json`
  (core-first; local rules only add detection, never weaken a built-in block).
- Per-decision overrides (`allow` / `deny`) in
  `<git-common-dir>/aimhooman/overrides.json` (local, never committed).
- Malformed project policy fails closed with an actionable error.

### Engineering

- Zero-runtime-dependency Node ESM (Node 22.8+ and Git 2.28+), shipped as source.
- State lives in the git dir. Init normally adds no worktree file; when a
  repository already uses a worktree-relative `core.hooksPath`, that configured
  directory remains the hook location. Foreign Git hooks are chained and
  restored on uninstall.
- Published JSON schemas; machine reports include target policy identity,
  completeness, scan statistics, and commit/object metadata.
- Release pipeline publishes to npm on a `v*` tag push with SHA-pinned actions and
  npm build provenance.

### Security

- Malformed local rule packs are skipped with a warning on `clean`; `strict` fails
  closed. Corrupt enforcement state and unreadable Git targets return an error.
- `init --global` refuses to clobber a pre-existing `core.hooksPath`.
- The `PreToolUse` guard intercepts `git commit --no-verify` upstream of git, which
  a git hook cannot.
- Hardened command parser (quoted verbs, newline separators, pathed git binaries),
  bounded path-glob matching with character classes, and hook input validation.
