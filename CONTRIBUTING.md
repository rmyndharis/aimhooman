# Contributing to aimhooman

Thanks for considering a contribution. aimhooman is a small,
zero-runtime-dependency Node ESM tool, so most changes are approachable.

## Prerequisites

- **Node.js 22.8 or newer**
- **Git 2.28 or newer**
- **Go 1.25.x** for the pinned `actionlint` release gate

The published runtime has no dependencies. Development tools are locked in
`package-lock.json`.

## Getting started

```sh
git clone https://github.com/rmyndharis/aimhooman.git
cd aimhooman
node --version    # needs >= 22.8
npm ci --ignore-scripts
npm run verify    # schemas, workflows, dead code, coverage, package, installed hooks
```

## Ways to contribute

- **New detection rules** for an AI tool aimhooman doesn't cover yet.
- **New host adapters** for an AI coding tool not in the support matrix.
- **Bug fixes** and **documentation** improvements.

## Adding a rule

Rules live in `rules/` as JSON arrays: `paths.json` (staged paths),
`attribution.json` (commit-message lines), `markers.json` (staged content),
`secrets.json` (high-confidence secret patterns). Each
rule has the shape:

```json
{
  "id": "provider.state",
  "version": 1,
  "provider": "provider",
  "category": "ephemeral-state",
  "confidence": "high",
  "kind": "path",
  "match": { "paths": ["**/.provider/**"] },
  "actions": { "clean": "block", "strict": "block", "compliance": "block" },
  "reason": "Provider artifacts are local, not repository content.",
  "remediation": ["git restore --staged <path>"]
}
```

Notes:

- `kind`: `"path"`, `"message"`, or `"code"`.
- `match.paths` use glob syntax (`*`, `**`, `?`, `[class]`). In a pattern such as
  `**/.x/**`, the leading globstar matches zero or more directories, so one pattern
  covers both `.x/file` and `nested/.x/file`. An explicit `.x/**` companion is
  allowed for readability but is not required.
- `match.content` are regular expressions; prefix `(?i)` for case-insensitive.
  Local packs use the safe flat subset documented in the README; built-in packs are
  package-reviewed and may use the wider JavaScript syntax.
- Path matching is case-sensitive unless `match.path_case` is `"insensitive"`.
  Use that per rule only when the security name itself is case-insensitive; Git path
  and override identities remain unchanged.
- `actions` per profile (`clean` / `strict` / `compliance`). Residue should
  `block` on all three. Exact high-confidence AI attribution may `block` on
  clean/strict and `allow` on compliance; ambiguous identities should remain review-only.
- Add positive and near-miss fixtures in `tests/rule-contracts.test.mjs`. The
  contract test fails when a catalog rule has no fixture.

## Adding a host adapter

- **Plugin-tier** (live `PreToolUse` guard): see `.claude-plugin/`,
  `.codex-plugin/`, `.github/hooks/`. Claude and Codex load the packaged hook
  manifest. The Copilot repository hook calls `aimhooman` from `PATH`.
- **Instruction-tier** (ruleset text): copy `AGENTS.md` verbatim into the host's
  rule file, register it in `docs/hosts.json`, then run
  `npm run sync:ruleset` and `npm run sync:hosts`. The copy
  and package gates derive required adapter paths from that registry, check exact
  ordered ruleset regions, and reject unregistered copies.

See `docs/design/agent-portability.md` for the full host matrix.

### Local rules (don't commit these)

Personal, per-clone detection belongs in `<git-common-dir>/aimhooman/rules/*.json`
(local, never committed). Linked worktrees share it. Contribute general-purpose
rules to `rules/` instead.

## Commit policy (important)

This project keeps AI tooling residue out of history — **including its own**.
Commits must read as if a human wrote them:

- **No AI attribution** in commit messages: no `Co-authored-by:` naming an AI,
  no "Generated with/by …", no AI-service noreply emails. (Yes, aimhooman
  enforces this on itself.)
- Keep commits focused — one logical change per commit.

## Pull requests

1. Open a PR against `main`.
2. Include tests for any new behavior and run `npm run verify`.
3. Update `CHANGELOG.md` and `docs/` where relevant.
4. Make sure the PR follows the commit policy above.

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

This is a personal, owner-only repository. GitHub branch rules require the `tests`
workflow but no pull-request approval, code-owner review, last-push approval, or
other reviewer. The repository has no `CODEOWNERS` fallback.

Changes to agent instructions or `.aimhooman.json` are protected-path changes. CI
verifies the pinned repository and owner login plus numeric IDs through the GitHub
API, then fetches the exact workflow-run attempt. GitHub must attribute the
attempt's `actor` and `triggering_actor` to that owner's login and numeric ID. CI
binds that authorization to the exact
head, transition commit, path, resulting blob and regular-file mode, or deletion
tombstone. Policy migrations additionally bind the old and new policy objects.
Another commit, attempt, path result, mode, or migration needs fresh authorization.
A protected-path change by any non-owner fails closed.

The owner account and its credentials are the repository trust root. These checks
verify GitHub's actor attribution and bind the resulting objects; they do not prove
an interactive human action, provide independent review, or protect against a
compromised owner credential.

Releases publish to npm automatically when a `v*` tag is pushed. The workflow
installs dependencies, runs the test suite, and publishes with npm build provenance,
authenticated by the `NPM_TOKEN` secret. To cut a release: bump the version (keep
`package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and
`.claude-plugin/marketplace.json` in sync), add the `## [version]` CHANGELOG entry
and the matching README version badge, then tag and push:

```sh
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
```

Protect `v*` tags so only the owner can create them and tag update or deletion is
blocked. Use a granular, publish-only, package-scoped npm token with 2FA enabled
and rotate it regularly. Do not run `npm publish` or move dist-tags manually while
a release job is pending or running.
