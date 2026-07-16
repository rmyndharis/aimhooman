# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
