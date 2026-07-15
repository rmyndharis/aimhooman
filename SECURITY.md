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
- This repository's strict range scan explicitly acknowledges the validated
  `.aimhooman.json` path; `CODEOWNERS` assigns policy/workflow changes to the
  maintainer. Review-required paths and the release environment use direct-user
  reviewers whose write-equivalent repository permission can be checked by the
  repository workflow token. Organization-team reviewers fail closed. Branch
  protection must require code-owner review for that approval boundary to be effective.
- The release pipeline is configured to run behind a protected GitHub environment,
  pin actions to immutable commit SHAs, and publish with npm build provenance. The
  environment must set `NPM_EXCLUSIVE_PUBLISHER=true` only after this protected
  workflow is the package's sole authorized npm publisher. If another token or
  trusted publisher can publish it, release is blocked: npm dist-tag updates do
  not provide a compare-and-swap guard. The npm package is not claimed as
  available until that first release completes.
