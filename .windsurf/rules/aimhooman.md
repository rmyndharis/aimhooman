---
trigger: always_on
---

# aimhooman

<!-- aimhooman:ruleset-start -->
This repository uses aimhooman to keep AI tooling artifacts out of Git history.
Its policy:

- Never stage or commit local AI session/state files. Examples include
  `.claude.json`, `.claude/session*.json`,
  `.claude/history*`, `.claude/todos/*`, `.claude/shell-snapshots/*`,
  `.claude/statsig/*`, `.claude/projects/*`, `.claude/logs/*`,
  `.codex/sessions/*`, `.codex/history*`, `.codex/log/*`, `.codex/logs/*`,
  `.copilot/*`, `.cursor/session*`, `.cursor/chats/*`, `.cursor/logs/*`,
  `.aider.*`, `.specstory/*`, `.continue/sessions/*`, `.playwright-mcp/*`,
  `.remember/*`, `.superpowers/*`, and `.agent/*`. The examples are not
  exhaustive; the packaged `rules/paths.json` is the detection source of truth.
  If one is staged, unstage it and keep it out of Git instead.
- Never commit secrets: a real `.env` (not `.env.example`), private keys
  (`id_rsa` and files containing a private-key header), `.aws/credentials`,
  `.claude/.credentials.json`, service-account keys, or a provider API key
  (GitHub, GitLab, npm, Slack, Anthropic, OpenAI, Google, Stripe, Hugging Face,
  SendGrid). Public certificates are allowed.
- Never add AI attribution to commit messages: no `Co-authored-by` trailer naming
  an AI (Claude, Copilot, Codex), no "Generated with/by <AI>" lines, no AI-service
  noreply emails. A commit message reads as if a human wrote it.
- Write in a human voice, not an AI voice. No `delve`, `leverage`, `utilize`,
  `seamless`, `robust`, `comprehensive`, `underscore`, `foster`, `pivotal`, `myriad`,
  `tapestry`, `landscape`; no "This PR addresses…", "adversarial self-review",
  "live-verified", "thoroughly tested with comprehensive examples", "in today's",
  "let's dive in", "in conclusion"; no bold lead-in on every bullet and no paired
  em-dash asides. Say what broke or what changed, pick the plain short verb, name the
  number, and vary sentence length. If the first line could open any PR on any repo,
  delete it.
- Treat `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md`
  as review-required: they may be intentional team config, so confirm before
  committing them.

Project map:

- `src/scan.mjs` and `src/rules.mjs` load rules and make policy decisions.
- `src/hook.mjs` and `src/githooks.mjs` enforce them in agent and Git hooks.
- `src/state.mjs` owns local policy state. `bin/aimhooman.mjs` is the CLI.
- `tests/` mirrors the production paths and includes real temporary Git repos.

Use Node.js 22.8 or newer. Before finishing a change, run:

```sh
npm run check
npm test
npm run test:coverage
```

aimhooman also enforces this at commit time, so a blocked commit means a real
violation to fix, not a check to bypass. The rule is simple: AI works, hoomans
ship.
<!-- aimhooman:ruleset-end -->
