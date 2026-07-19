<div align="center">

  <img src="docs/logo/aimhooman-logo.png" alt="aimhooman - AI works. Hoomans ship." width="120">
</div>

<h1 align="center">AI’m Hooman</h1>

<p align="center">"beep boop ... ai'm hooman"</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/rmyndharis/aimhooman/test.yml?branch=main&label=CI" alt="CI">
  <img src="https://img.shields.io/badge/version-v0.3.0-blue" alt="v0.3.0">
  <img src="https://img.shields.io/badge/node-%E2%89%A522.8-339933?logo=node.js&logoColor=white" alt="Node 22.8+">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT">
  <img src="https://img.shields.io/npm/dm/@rmyndharis/aimhooman?label=downloads" alt="Downloads">
  <img src="https://img.shields.io/github/stars/rmyndharis/aimhooman?style=social" alt="GitHub Stars">
</p>

<p align="center">aimhooman: <i>AI works. Hoomans ship.</i></p>

> **Human-owned, not human-washed.** aimhooman removes tooling residue and sets human
> ownership. It does not fake authorship or strip disclosure your policy requires.

## TL;DR

Keep AI session files and stray `Co-authored-by:` lines out of your Git history —
a vendor-neutral guard, repair-first by default, without a per-tool ignore list and
without faking who wrote the code. Zero runtime dependencies. Node 22.8+, Git 2.28+.

## The problem

Your AI agent works in your repo and quietly leaves state behind: `.claude/session.json`,
chat history, caches, and `Co-authored-by:` an AI. One `git add -A` later, it is in your
history. Ignore lists are per-tool and never complete, and a local git hook is one
`--no-verify` away from being skipped.

## How it works

One detection core, many enforcement surfaces. On the default profile the ordinary commit
path repairs hygiene findings when it can; `commit-msg` checks the pinned would-be tree,
and the final ref boundary independently scans every commit introduced to `HEAD` or a
branch. A block that survives repair stops the commit; an incomplete scan warns on
`clean`/`compliance` and still vetoes at the final ref guard.

```mermaid
flowchart TD
    SESS([Session start]) -. once .-> EXCL["Auto-exclude known<br/>AI artifacts in .git/info/exclude"]
    AGENT([Agent calls a tool]) -. proactive .-> ADV["PreToolUse parses the command,<br/>resolves repo/policy, and checks bypass risk"]
    RUN([You run the CLI]) -. on demand .-> CLI["check · fix · explain"]

    COMMIT([Ordinary git commit or merge]) --> PRE["pre-commit / pre-merge-commit<br/>run predecessor, resolve staged policy,<br/>scan exact index"]
    DIRECT([Sequencer or direct ref path<br/>cherry-pick · rebase · fetch · worktree · update-ref]) --> REF
    PRE -->|clean: safe repair| MSG["commit-msg snapshots would-be tree,<br/>runs predecessor, then checks<br/>the message and pinned full tree"]
    PRE -->|strict violation, incomplete scan,<br/>or failed repair| BLOCK([Operation stops])
    MSG -->|message and tree accepted| REF["reference-transaction prepared<br/>scans what each introduced commit changes<br/>(messages of locally authored commits only)"]
    MSG -->|unsafe or unrepairable| BLOCK
    REF -->|accepted| SHIP([Ref update commits])
    REF -->|violation or incomplete scan| BLOCK

    classDef entry fill:#f8fafc,stroke:#94a3b8,color:#0f172a,stroke-width:1.5px
    classDef hook fill:#eef2ff,stroke:#6366f1,color:#312e81,stroke-width:2px
    classDef ok fill:#ecfdf5,stroke:#10b981,color:#064e3b,stroke-width:1.5px
    classDef stop fill:#fef2f2,stroke:#ef4444,color:#7f1d1d,stroke-width:2px

    class SESS,AGENT,RUN,COMMIT,DIRECT entry
    class PRE,MSG,REF hook
    class SHIP ok
    class BLOCK stop
```

- **Prevent:** known AI artifacts go into `.git/info/exclude` on session start, so they never show in `git status`.
- **Catch:** `pre-commit` unstages what slips through; `commit-msg` removes exact high-confidence attribution lines.
- **Advise:** the plugin's `PreToolUse` reports paths early and denies protected commit/ref operations it cannot prove safe.
- **Block:** `strict` cancels instead of repairing; on every profile the final ref guard stops an unscannable or blocked commit.

## Quick start

```sh
npm install -g @rmyndharis/aimhooman
aimhooman init            # git hooks + local excludes; normally no worktree files
git commit -m "ship it"   # guarded automatically
```

- `aimhooman init --gitignore` also writes the managed ignore block into the worktree
  `.gitignore` — commit it to share the ignore set with every clone. Default stays local.
- `aimhooman init --global --yes` is the advanced one-time setup for terminal Git: it
  changes global `core.hooksPath` for every inheriting repository — caveats in
  [docs/cli-reference.md](docs/cli-reference.md).

## Profiles

- **Default (`clean`):** repairs and warns; the final ref guard still vetoes what it cannot fully scan.
- **Strict for teams:** findings cancel the commit; commit `.aimhooman.json` so every clone shares the baseline.

`compliance` repairs like `clean` but keeps required AI attribution. Details: [docs/policy.md](docs/policy.md).

## What it catches

- **AI session/state artifacts**: `.claude/session*.json`, `.codex/sessions/`, `.aider.*`
  — catalog: [docs/catalog.md](docs/catalog.md). Just want the ignore list? [docs/ai-artifacts.gitignore](docs/ai-artifacts.gitignore).
- **AI attribution** in commit messages (`Co-authored-by:` an AI, "Generated with" lines, AI noreply trailers) and **AI markers** left in code.
- **Review-required** files: `.aimhooman.json`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`.

Secret scanning is out of scope since v0.3.0 — [docs/secrets.md](docs/secrets.md) has the why and the gitleaks setup.

## Use it in your AI coding tool

Claude Code runs the plugin hook every session; Codex after you trust the hooks with
`/hooks`; Copilot's repository hook needs `aimhooman` on `PATH`. None replaces the Git
guard from `aimhooman init` — full matrix: [docs/design/agent-portability.md](docs/design/agent-portability.md).

| Host | File |
| --- | --- |
| Claude Code / Codex | `.claude-plugin/` / `.codex-plugin/` + `hooks/hooks.json` |
| GitHub Copilot | `.github/hooks/aimhooman.json`, `.github/copilot-instructions.md` |
| Cursor | `.cursor/rules/aimhooman.mdc` |
| Cline | `.clinerules/aimhooman.md` |
| Windsurf | `.windsurf/rules/aimhooman.md` |
| Kiro | `.kiro/steering/aimhooman.md` |
| Gemini CLI / Code Assist | `.gemini/settings.json`, `GEMINI.md` |
| Google Antigravity | `.agents/rules/aimhooman.md` (set the rule to Always On) |
| Any agent | `AGENTS.md` or `skills/aimhooman/SKILL.md` |

## Run it in CI

The repository ships a `.pre-commit-hooks.yaml` for pre-commit.com and an `action.yml`
GitHub Action that scans the exact pull-request range — the tier a laptop cannot skip.
Setups, plus gitleaks, husky, and lint-staged: [docs/integrations.md](docs/integrations.md).

## Docs

| Page | Covers |
| --- | --- |
| [docs/catalog.md](docs/catalog.md) | every built-in rule, per profile |
| [docs/policy.md](docs/policy.md) | team policy, overrides, local rule packs |
| [docs/cli-reference.md](docs/cli-reference.md) | commands, flags, exit codes |
| [docs/faq.md](docs/faq.md) | hiding AI use, canceled commits, bypasses, speed |
| [docs/integrations.md](docs/integrations.md) | pre-commit.com, GitHub Action, gitleaks, husky |
| [docs/secrets.md](docs/secrets.md) | why secret scanning left, the gitleaks setup |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for rules, host
adapters, tests, and the commit policy. This project has a [code of conduct](CODE_OF_CONDUCT.md);
by participating you agree to abide by it. To report a security issue, see
[SECURITY.md](SECURITY.md). Architecture notes live in [docs/design/](docs/design).

## License

This project is licensed under the **MIT License** – free for personal and commercial use.

See [LICENSE](./LICENSE) for details.

---

<br />
<br />

<p align="center">
  Made with ❤️ by <a href="https://github.com/rmyndharis">Yudhi Armyndharis</a> &amp; aimhooman contributors
</p>
