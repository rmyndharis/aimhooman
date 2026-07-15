# Security Policy

aimhooman is itself a security-adjacent tool: it guards repositories against
AI-tool residue and secrets reaching Git history. This policy covers the
security of aimhooman itself.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email **yudhi@rmyndharis.com** with the subject `aimhooman security`. This is
the currently available private reporting route. Include:

- a description of the issue and its impact
- a minimal reproduction (a command or a small repo)
- the aimhooman version and Node version

We will acknowledge within 72 hours and aim for a fix or mitigation within
30 days. Coordinated disclosure is preferred; credit is given on request.

## Scope

**In scope:** the aimhooman codebase — the detection engine, the agent and git
hooks, the CLI, rule compilation (`globToRegExp`, `compileContent`), and the
shell-command parser that backs the agent PreToolUse guard (`parseGit` in
`src/hook.mjs`).

**Out of scope:** the contents of the built-in rule packs. False positives in
which paths are flagged are regular bugs (open a normal issue), not security
vulnerabilities. aimhooman is a hygiene guard, not a security-enforcement
mechanism against adversarial threats — a determined actor with commit access
can always defeat local tooling.

## Supported versions

Before the first public release, security fixes land on `main`. After publication,
only the latest minor release will receive security fixes.

## Security stance

- aimhooman **prevents leaks it has rules for**. It cannot catch novel AI-tool
  artifacts with no rule, and it does not rewrite existing history.
- The default (`clean`) profile repairs ordinary hygiene findings when it can.
  Invalid local rule packs are skipped with a warning, but corrupt override state,
  incomplete staged-content scans, and unreadable Git targets stop every profile.
  If any blocked path cannot be unstaged or safely repaired, the operation stops.
  The pinned-tree and final-ref guards also stop a remaining or pre-existing tracked
  block. `strict` vetoes instead of attempting clean/compliance repairs and also
  stops review decisions.
- Local hooks are not a security boundary. Team CI should scan an explicit Git
  range (`aimhooman check --range <base>...<head> --profile strict`), not the
  normally empty staged index of a CI checkout. Ensure the checkout contains
  the merge base (`fetch-depth: 0` on GitHub Actions).
- A committed `.aimhooman.json` provides the versioned team profile. Invalid
  project policy fails closed; per-clone allow/deny entries remain local and
  should be governed by team process where compliance requires it.
- This is a personal, owner-only repository with no GitHub approval, required
  reviewer, or `CODEOWNERS` gate. For protected-path changes, CI resolves the
  pinned repository and owner through the GitHub API and fetches the exact
  workflow-run attempt. GitHub must attribute both the actor and triggering actor
  to the owner's login and numeric ID. The resulting decision is bound to the exact head,
  transition commit, path, blob and regular-file mode, or deletion tombstone; a
  policy migration also binds its old and new objects. Non-owner changes fail
  closed with no reviewer fallback. The owner is the trust root, not an independent
  reviewer. These checks verify GitHub attribution, not an interactive human action,
  and cannot defend against malicious or compromised owner credentials.
- The release pipeline pins actions to immutable commit SHAs and publishes with npm
  build provenance. Pushing a `v*` tag runs the workflow: it installs dependencies,
  runs the test suite, then publishes to npm authenticated by the `NPM_TOKEN` secret
  (use a granular, publish-only, package-scoped npm token with 2FA enabled; rotate it
  regularly). Protect `v*` tags so only the owner can create them and tag update or
  deletion is blocked. Do not publish or move dist-tags manually while a release job
  is pending or running. The npm package is not claimed as available until the release
  workflow completes.
