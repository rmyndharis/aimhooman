# Secrets and aimhooman

aimhooman v0.3.0 removed built-in secret scanning. This page explains why and
shows the setup we recommend instead.

## Why the built-in scanner went away

aimhooman does one job: it keeps AI tooling residue (session files, local
state, AI attribution) out of Git history. Secret scanning is a different
craft. A serious scanner tracks hundreds of credential formats, tunes for
entropy and false positives, and ships pattern updates on its own cadence.
aimhooman's eight rules could not keep up with that, and a scanner that only
sometimes works is worse than none: it reads as coverage it never had. Use a
tool that does secrets full-time. We recommend [gitleaks](https://github.com/gitleaks/gitleaks).

Two things do stay. The agent-facing policy still tells agents never to commit
secrets, because an instruction costs nothing. And a local rule pack can still
declare `category: "secret"`; findings from such a rule keep their matched
text redacted in every report.

## Recommended setup: gitleaks

### Pre-commit hook (pre-commit.com)

Add this to `.pre-commit-config.yaml` and run `pre-commit install`:

```yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
```

The hook scans staged changes and stops the commit when a credential shows
up. Pin `rev` and bump it deliberately.

### GitHub Action

Laptops bypass hooks; CI should not. Add a workflow step that scans pull
requests:

```yaml
# .github/workflows/gitleaks.yml
name: gitleaks
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
```

`fetch-depth: 0` gives the action the full history so a secret introduced
three commits back still gets caught.

### Running it alongside aimhooman

The two tools do not overlap and do not fight. aimhooman owns Git's
`pre-commit`, `commit-msg`, `reference-transaction`, and `pre-push` hooks; gitleaks runs
as a pre-commit.com hook or in CI, so both fire on the same commit without
sharing state. A commit carrying an AI session file and an API key gets
stopped for both reasons, each reported by the tool that owns it. Keep
aimhooman for AI hygiene, keep gitleaks for secrets, and let each report in
its own words.

## Migrating from the built-in scanner

Two escape hatches left with the scanner:

- `aimhooman allow <path> --scope secret-path` is gone. Existing
  `secret-path` entries in `overrides.json` are dropped on load with a
  warning; the rest of the file keeps working.
- `aimhooman init --grandfather-secrets` is gone.

If secrets already sit in your history, aimhooman was never the fix and
removing it changes nothing about that: a committed credential is exposed.
Rotate it, then run `gitleaks git` (or `gitleaks detect`) over the repository
to find anything else that needs rotation. Scrubbing history is optional and
secondary; rotation is not.
