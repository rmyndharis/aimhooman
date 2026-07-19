# aimhooman: Repair-First, Layered Enforcement

This document describes aimhooman's enforcement model. aimhooman is designed to
prevent known AI-tool residue from leaking into Git history **without editing
`.gitignore` by default, and with repair before rejection on the default ordinary
commit path.** Plugin startup provides best-effort prevention without `init`;
complete Git-boundary enforcement requires local or global hook setup.

## Goals

- **Zero-activation for Claude Code:** the plugin is active every session
  (SessionStart), no `init`.
- **No `.gitignore` burden by default:** known AI artifacts are auto-excluded via
  `.git/info/exclude` (local, never committed). `init --gitignore` is the opt-in
  variant that writes the same managed block to the worktree `.gitignore`, so a
  team can commit it and share the ignore set across clones.
- **Repair-first for hygiene by default:** AI artifacts are excluded before
  staging or unstaged at commit. If a block cannot be repaired or remains in the
  pinned tree, the operation stops. An incomplete scan warns on
  `clean`/`compliance` and stops on `strict`; the final ref guard stops on it
  at every profile.
- **Broad, community-updatable rule catalog:** covers many AI tools; extendable
  via PR (core) and local rules (personal).
- **Block remains available as opt-in** (`strict` profile) for teams that want
  hard enforcement.

## Non-goals

- Rewriting existing git history (out of scope; this prevents future leaks only).
- Catching truly novel AI tools that have no rule yet (coverage is
  rule-dependent; cannot be 100%).
- A live community registry fetched over the network (rejected: breaks offline /
  zero-dependency ethos, introduces supply-chain risk).

## Constraints (honest)

1. **Git has no universal "guard every repo" hook.** `npm install -g` only places a
   binary on PATH. Auto-activation is achieved via (a) the Claude Code plugin
   (SessionStart, zero-init) and (b) an optional one-time `aimhooman init --global`
   that sets `core.hooksPath` for eligible non-bare repositories without a local
   or worktree-scoped override.
2. **"Prevent leak without blocking" requires exclusion, not just warning.**
   Either exclude before staging (`.git/info/exclude`) or unstage at commit
   (`pre-commit` hook). Pure warnings do not prevent leaks.
3. **PreToolUse cannot unstage.** It runs before the tool executes; at `git add X`,
   X is not staged yet. So unstage is a git-tier (`pre-commit`) capability; the
   plugin tier does prevention (excludes) plus advisory (warn).
4. **`.gitignore` stays clean by default** because aimhooman writes
   `.git/info/exclude` (local, not committed). The opt-in `init --gitignore`
   writes the same managed block to `.gitignore` for teams that want it committed.

## Design

### Layered enforcement (default ordinary path = repair-first)

| Layer | Mechanism | Tier | Blocking? |
| --- | --- | --- | --- |
| 0. Prevention | Auto-write `.git/info/exclude` from unambiguous residue rules | plugin SessionStart + init/agent hook refresh | none (best effort) |
| 1. Catch-all | `pre-commit` hook unstages AI artifacts from the index | git hook | proceeds after repair; stops if repair fails |
| 2. Agent guard | PreToolUse reports paths and rejects unprovable protected Git mutations | plugin | advisory for paths; fail-closed for boundary bypass |
| 3. Strict policy | `strict` profile blocks instead of repairing (exit 10) | both | block |
| 4. Pinned tree | `commit-msg` checks the exact would-be tree and message | git hook | blocks a remaining violation; an incomplete scan warns on clean/compliance, stops on strict |
| 5. Final ref check | prepared `reference-transaction` scans what each commit introduced to `HEAD` or a branch changes (and the message of commits authored locally) | git hook | blocks a violation or incomplete scan |

Default profile `clean` uses layers 0, 1, 2, 4, and 5. Successful repair keeps the
ordinary path low-friction. The pinned-tree and final-ref scans deliberately stop if
a block remains on a path the commit actually changes. The final-ref scan also stops
when it is incomplete, on every profile; an incomplete pinned-tree scan warns on
`clean`/`compliance` and stops on `strict`.
A file already in history is not re-tried on every later commit: the final ref check
judges a commit by its change set, so an inherited path no longer blocks unrelated
work. Use `aimhooman check --tracked` (or scan the PR range in CI) to surface legacy
artifacts without bricking the branch.
Git 2.54 also emits an earlier `preparing` reference-transaction callback. The
hook checks dispatcher integrity there without scanning unresolved references,
then keeps the scan veto at `prepared`, after Git has locked them.

### Frictionless agent guard (the everyday commands run)

The layer-2 PreToolUse guard reports paths and refuses unprovable protected Git
mutations. It does not stand between a developer and the commands they run to read a
repository. A read-only Git subcommand piped to a filter is a source: `git log | head`,
`git status | grep modified`, `git diff | cat`, and the `cd repo && git log | head`
prefix produce stdout for the downstream filter and cannot hide or feed a commit, so
they run with no refusal. Build and test toolchains (`npm`, `cargo`, `make`, `jest`,
`eslint`, `tsc`, `pytest`, ...) are allowed as a source for the same reason. The listing
forms of branch/tag/remote/stash/notes move no ref and run; their mutating forms
(`git branch -D`, `git tag v1`) still reach the reference-transaction guard. A commit
made of already-safe halves runs as a whole: `build && git add . && git commit` is
allowed, because an unmodelled prefix is not a bypass and pre-commit still scans the real
index at commit time.

What stays refused is what can actually get past the scan. Git as a pipe sink
(`cat patch | git apply`) reads stdin, which can drive `apply`/`am`/`hash-object`.
Pipe-to-shell, subshells, `eval`, command substitution, and readers that execute their
own input stay opaque. `git commit --no-verify`, an explicit `core.hooksPath` override,
and `git push` refuse on the tiers that own them. The boundary that decides whether a
commit is scanned is the pre-commit and reference-transaction hook, never a denial of the
shell line that reads the repo. Refusing the read taught agents to drop the `&&` gate
rather than run the command on its own, which is the friction this tier exists to avoid.

### Components

1. **Rule catalog** — `rules/paths.json`, `rules/attribution.json`,
   `rules/markers.json`. Covers Claude, Codex, Copilot, Cursor, Aider, SpecStory,
   Continue, Playwright MCP, Remember, Superpowers, and a generic agent dir.
   Community extends via PR (core); personal extensions via
   `<common-git-dir>/aimhooman/rules/*.json` (local, shared by linked worktrees,
   loaded after core, and only able to add restrictions).
2. **Auto-exclude** — `applyExclude` writes patterns derived from unambiguous
   `ephemeral-state` and `local-settings` rules to `.git/info/exclude` from
   SessionStart, init, and the agent guard. Review-required and policy paths
   remain visible.
3. **Git boundary** — the `pre-commit` hook scans staged paths; for any AI
   artifact it removes it from the index, then lets the commit proceed only when
   that repair succeeds. `commit-msg` removes complete exact high-confidence attribution lines
   (on `clean`), keeps them (on `compliance`), or blocks (on `strict`). An unterminated
   exact final line stops unchanged; broader attribution candidates remain review notices.
   `commit-msg` evaluates the message and full snapshot against a pinned would-be
   tree. The `reference-transaction` hook checks guard integrity during Git
   2.54's early `preparing` callback, then independently scans every introduced
   commit at `prepared` before Git changes `HEAD` or a branch ref; it does not trust
   an attestation from an earlier hook. This covers ordinary commits, sequencers,
   fetch/worktree branch creation, and direct ref commands.
4. **Auto-activation** — the plugin's SessionStart ensures excludes + injects the
   ruleset (no `init`). `aimhooman init --global` sets `core.hooksPath` once for
   terminal git.
5. **Strict policy** — the `strict` profile blocks findings instead of attempting
   the clean/compliance repairs.
6. **Team baseline** — an optional, versioned `.aimhooman.json` selects the
   repository profile and takes precedence over per-clone defaults. Invalid
   project policy fails closed; local exceptions remain in Git state.

### Local rule loading

`loadRules(stateDir?)` reads `<stateDir>/rules/*.json` using the published local-pack
schema, the stricter regex subset, and a bounded path-glob matcher when a repo context
exists, merged after core packs. Core-first ordering
means local rules only add restrictions and can never override a core block.

## Implementation notes

- **Category-aware failure.** On `clean`, a malformed local rule pack is skipped
  with a warning because built-in rules remain active. Corrupt override state and
  unreadable Git inputs stop every profile. An incomplete staged-content scan warns
  on `clean`/`compliance` and stops `strict`; the final ref guard fails closed on it
  at every profile.
  Any automatic unstage failure stops; allowing it through would only defer the
  same block to the pinned-tree or final-ref scan. `strict` also vetoes policy
  findings and reviews.
- **`init --global` refuses to clobber.** It will not overwrite a pre-existing
  global `core.hooksPath`, and `aimhooman uninstall --global` reverses it. A
  repository-local/worktree override takes precedence; local `init` refuses a
  shared or external effective hook directory. Global reference dispatchers are
  transparent in unsupported bare repositories.
- **HEAD-safe unstage.** `git restore --staged` needs HEAD; on a repository's
  initial commit it falls back to `git rm --cached --ignore-unmatch`.
- **Repair never mints an empty commit.** When the pre-commit repair unstages the last
  staged path (stage only a `.claude.json`, then `git commit`), it exits 10 so Git stops, the
  same outcome as committing with nothing staged. Carrying on would create a commit Git
  itself would have refused and leave the developer a junk commit to `git reset --hard`.
- **Anchored attribution rules.** The AI-noreply rule is anchored to trailer
  lines (`*-by:`) so it never strips a prose line that merely mentions the email.
- **`compliance` keeps disclosure.** AI-attribution rules resolve to `allow`
  under `compliance`, so nothing is stripped and the disclosure is preserved.

## Testing

`npm run verify` is the release-equivalent local gate. It validates generated
artifacts and JSON, compiles every published schema, lints workflows, checks for
dead code, runs coverage (including release-critical scripts), verifies the
packed manifest, and exercises installed hooks. The tests cover profiles,
overrides, commit-message repair, strict `--no-verify` rejection, local rules,
rename/type-change detection, staged/commit/range/tracked targets, linked
worktrees, hook ownership and chaining, sequencer/direct-ref flows, and initial
commits.
