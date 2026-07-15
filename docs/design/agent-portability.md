# Agent portability

aimhooman is a vendor-neutral guard: one rule set, shipped as Node source, with a thin
adapter per host. An activated plugin-tier adapter runs the live `PreToolUse` guard;
instruction-tier hosts load the ruleset. The Git-boundary guard comes from
`aimhooman init`, independent of the host.

## Prerequisite

Install once so hooks can call it (Node 22.8+ and Git 2.28+):

```sh
npm install -g @rmyndharis/aimhooman
```

Claude Code and Codex plugin bundles ship the `.mjs` source and run it with the
`node` already on your machine. The Copilot repository hook calls the installed
`aimhooman` binary and otherwise fails open with no live guard.

## Supported hosts

The registry in `docs/hosts.json` records the adapter, activation contract,
official specification, and last verification date. The table below is generated
from that registry.

<!-- aimhooman:host-table-start -->
| Host | Tier | Files | Activation | Version checked | Evidence |
| --- | --- | --- | --- | --- | --- |
| Claude Code | plugin | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `skills/aimhooman/SKILL.md` | Install the marketplace plugin; Git hooks still require aimhooman init. | web spec (unversioned) | static (2026-07-15) |
| OpenAI Codex | plugin | `.codex-plugin/plugin.json`, `hooks/hooks.json`, `skills/aimhooman/SKILL.md` | Install the plugin, start a new session, then review and trust its hooks with /hooks. | 0.144.3 minimum contract | static (2026-07-15) |
| GitHub Copilot CLI | plugin | `.github/hooks/aimhooman.json` | The repository hook calls aimhooman from PATH and is advisory until Git hooks are installed. | web spec (unversioned) | static (2026-07-15) |
| GitHub Copilot editor | instruction | `.github/copilot-instructions.md` | Loaded from the repository by supported Copilot editors. | web spec (unversioned) | static (2026-07-15) |
| Cursor | instruction | `.cursor/rules/aimhooman.mdc` | Loaded as an always-on project rule. | web spec (unversioned) | static (2026-07-15) |
| Cline | instruction | `.clinerules/aimhooman.md` | Loaded from the project clinerules directory. | web spec (unversioned) | static (2026-07-15) |
| Windsurf | instruction | `.windsurf/rules/aimhooman.md` | Loaded through the supported legacy .windsurf/rules workspace fallback; current hosts prefer .devin/rules. | web spec (unversioned) | static (2026-07-15) |
| Kiro | instruction | `.kiro/steering/aimhooman.md` | Loaded as always-included steering by default. | web spec (unversioned) | static (2026-07-15) |
| Gemini CLI | instruction | `.gemini/settings.json`, `GEMINI.md` | The repository setting loads AGENTS.md; GEMINI.md is also shipped as default context. | 0.50.0 source contract | static (2026-07-15) |
| Gemini Code Assist | instruction | `GEMINI.md` | Loaded as agent-mode context in supported editors. | web spec (unversioned) | static (2026-07-15) |
| Google Antigravity | instruction | `.agents/rules/aimhooman.md` | Add the workspace rule in Antigravity and set it to Always On. | web spec (unversioned) | static (2026-07-15) |
<!-- aimhooman:host-table-end -->

## Adapter rule

Keep adapters thin. Claude and Codex share `hooks/hooks.json`; the Copilot CLI uses
`.github/hooks/aimhooman.json`. Both hook formats call `aimhooman hook ...`.
Instruction-tier adapters carry the ruleset text verbatim from `AGENTS.md`; the test
`tests/copies.test.mjs` fails if any copy drifts.

## Enforcement matrix

| Host kind | Agent ruleset | Agent PreToolUse guard | Git commit / reference guards |
| --- | --- | --- | --- |
| Plugin-tier (after host activation) | yes | yes | yes (after `aimhooman init`) |
| Instruction-tier | yes | no | yes (after `aimhooman init`) |
| No host / CI | no | no | yes (git hooks, or `aimhooman check` in CI) |

## Hook output

aimhooman emits one JSON object that satisfies every host: Claude and Codex read
`hookSpecificOutput.permissionDecision`, Copilot reads the top-level
`permissionDecision`. No host detection is needed.

## The `--no-verify` gap

`git commit --no-verify` skips the ordinary `pre-commit` and `commit-msg` hooks.
On `strict`, the agent-tier `PreToolUse` guard rejects that flag before Git runs
for supported plugin hosts. The prepared `reference-transaction` hook is not a
verify hook and checks the resulting commit before the branch ref changes, but
it cannot provide clean-profile auto-repair after the earlier hooks were skipped.
Local tooling is still not a server boundary; for team-wide enforcement, scan
the actual PR range in CI rather than the normally empty CI index:
`aimhooman check --range origin/main...HEAD --profile strict`. A shallow checkout
may not contain the merge base; use `fetch-depth: 0` or deepen it first.
