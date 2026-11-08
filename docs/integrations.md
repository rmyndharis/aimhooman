# Integrations

aimhooman runs wherever commits get checked: as a pre-commit.com hook, as a
GitHub Action, and next to other hook tooling. This page shows each setup and
what it does and does not cover.

## pre-commit.com

The repository ships a `.pre-commit-hooks.yaml`, so pre-commit installs
aimhooman straight from Git. Add this to `.pre-commit-config.yaml` and run
`pre-commit install`:

```yaml
repos:
  - repo: https://github.com/rmyndharis/aimhooman
    rev: v0.6.0
    hooks:
      - id: aimhooman
```

pre-commit npm-installs the package at the pinned revision and runs
`aimhooman check --staged` on every commit. Pin `rev` to a tag and bump it
deliberately.

The hook checks the staged tree, so it passes no filenames. Any non-zero
exit fails it: 10 for a policy violation, 11 for a review-required finding on
a non-clean profile, 20 for a usage or configuration error, 30 for a Git or
I/O error, 31 when a scan budget leaves the scan incomplete on `strict` or at
the final ref guard (`clean`/`compliance` warn and continue). On the default
`clean` profile a review-only finding exits 0, so reviews alone do not fail
the hook. Blocks always do.

This hook is the CLI check only. It does not install aimhooman's managed Git
hooks or the agent guard; `aimhooman init` in the repository adds those.

`pre-commit run --all-files`, the usual CI and pre-commit.ci invocation, runs
the hook against an empty index, so it checks nothing there. In CI, scan the
pull-request range with the action below instead.

## GitHub Actions

The repository root has an `action.yml`, so a workflow can scan the exact
pull request range:

```yaml
# .github/workflows/aimhooman.yml
name: aimhooman
on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: rmyndharis/aimhooman@v0.6.0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
```

`fetch-depth: 0` is required. The range is triple-dot, so the scan starts at
the merge base of the two commits, and a shallow checkout does not have that
commit. The action installs aimhooman from npm and defaults to the `strict`
profile.

`profile:` under `with:` follows the same rule as `check --profile`: it can
repeat the repository's own profile or raise it to `strict`, nothing else.
`strict` works in any repository. `clean` works where `.aimhooman.json` is
absent or says `clean`, and `compliance` only where the committed
`.aimhooman.json` says `compliance`. Any other combination stops with exit 20
and names the profile the repository uses.

Under `strict`, a pull request that adds or changes an agent instruction file
(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`) or
`.aimhooman.json` fails the check, and the action has no step that approves
it. Under `clean` those changes are notices and the check passes; under
`compliance` they exit 11 and fail it. aimhooman's own repository accepts them
from its owner through CI scripts that ship with neither the action nor the
npm package ([docs/policy.md](policy.md#owner-authorization-in-ci)).

Pinning the action tag (`@v0.6.0`) pins only the action's steps, not the CLI:
the action npm-installs aimhooman at run time, and the `version` input
defaults to `latest`. Set `version:` under `with:` (for example
`version: 0.6.0`) to pin the CLI itself.

For `push` events, use `base: ${{ github.event.before }}` and
`head: ${{ github.event.after }}`. On the first push to a branch `before` is
all zeros. The action then scans from the branch's merge base with
`origin/<default branch>` and passes when the branch adds no commits, so
history the default branch already carries is not judged again. An orphan
branch, and the first push of the default branch itself, scan from the root
commit.

CI is the enforcement tier that travels with the repository: local hooks do
not govern another clone, and a laptop can skip its own hooks. The action
cannot.

## Secrets

aimhooman does not scan for secrets. Pair it with
[gitleaks](https://github.com/gitleaks/gitleaks), either as a pre-commit.com
hook or as a second CI job next to the action above.
[docs/secrets.md](secrets.md) explains why the built-in scanner was removed
and shows both gitleaks setups.

## husky

husky 9 sets `core.hooksPath` to `.husky/_` (older versions used `.husky`).
`aimhooman init` refuses to install into or over an external or shared hooks
directory by design: it is worktree content, and a dispatcher written there
would stage this machine's absolute CLI and Node paths for everyone who clones
(`src/githooks.mjs` has the full rule set). Three ways out:

- Keep husky and call `aimhooman check --staged` from `.husky/pre-commit`.
  You get the CLI check only. The agent-tier guard (PreToolUse) asks for
  aimhooman's own managed hooks and refuses guarded commits without them, so
  agent-driven commits stay unguarded in this setup.
- Drop husky for the guarded hooks and let `aimhooman init` manage them.
  Existing hooks are not lost: init preserves each one as a chained
  predecessor, and the dispatcher runs it before its own check.
- Keep the hooks path local: add it to `.git/info/exclude` (for husky 9,
  `.husky/_/`) and re-run `aimhooman init`. It then manages that directory and
  chains husky's shim, and nothing machine-specific is shared with clones.

## lint-staged

lint-staged builds a list of staged files and runs one command per batch.
aimhooman does not fit that shape: it reads the whole index and commit from
Git and takes no file list, so a per-batch invocation would check the same
index several times. Run it at hook level instead, through its own managed
hooks or the pre-commit.com setup above.
