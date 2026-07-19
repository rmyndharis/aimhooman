# AI-artifact catalog

<!-- Generated from rules/*.json by `npm run sync:catalog`; do not edit by hand. -->

aimhooman watches commits for AI residue: tooling artifacts (session files,
local settings, and agent state that belong on your machine, not in history)
and AI attribution (co-author trailers, "generated with" lines, leftover
markers in code). The table lists every built-in rule and what each profile
does when it matches: `block` stops the commit, `review` asks a human to
confirm, `allow` lets it through.

Secret scanning is out of scope since v0.3.0. See
[docs/secrets.md](secrets.md) for the reasoning and the gitleaks setup we
recommend instead.

<!-- aimhooman:catalog-start -->
| Rule | Provider | Category | Kind | clean | strict | compliance | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `attribution.claude-coauthor` | claude-code | ai-attribution | message | block | block | allow | Unwanted AI co-author attribution (Claude). |
| `attribution.copilot-coauthor` | copilot | ai-attribution | message | block | block | allow | Unwanted AI co-author attribution (Copilot). |
| `attribution.codex-coauthor` | codex | ai-attribution | message | block | block | allow | Unwanted AI co-author attribution (Codex). |
| `attribution.bot-coauthor` | generic | ai-attribution | message | review | review | allow | Unwanted bot co-author attribution. |
| `attribution.generated-with` | generic | ai-attribution | message | block | block | allow | Unwanted AI generation attribution in the message. |
| `attribution.ai-noreply` | generic | ai-attribution | message | review | review | allow | AI service noreply email in the message. |
| `marker.corner-cut` | generic | ai-marker | code | review | block | review | AI-tooling corner-cut marker left in committed code. |
| `marker.ai-authored` | generic | ai-marker | code | review | block | review | AI-authored code marker left in committed code. |
| `claude.local-settings` | claude-code | local-settings | path | block | block | block | Personal Claude Code settings are not intended for source control. |
| `claude.session-state` | claude-code | ephemeral-state | path | block | block | block | Claude Code session and state artifacts are local, not repository content. |
| `codex.session-state` | codex | ephemeral-state | path | block | block | block | Codex session, history, and log artifacts are local, not repository content. |
| `copilot.session-state` | copilot | ephemeral-state | path | block | block | block | Copilot local state is not repository content. |
| `cursor.session-state` | cursor | ephemeral-state | path | block | block | block | Cursor session artifacts are local, not repository content. |
| `aider.history` | aider | ephemeral-state | path | block | block | block | Aider dotfiles are local, not repository content. |
| `specstory.history` | specstory | ephemeral-state | path | block | block | block | SpecStory session history is local, not repository content. |
| `continue.sessions` | continue | ephemeral-state | path | block | block | block | Continue session artifacts are local, not repository content. |
| `generic.agent-instructions` | generic | ambiguous-instructions | path | review | block | review | Agent instruction files may be intentional team config. Review before committing. |
| `generic.project-policy` | aimhooman | policy-config | path | review | block | review | Versioned enforcement policy changes require explicit human review. |
| `playwright-mcp.state` | playwright-mcp | ephemeral-state | path | block | block | block | Playwright MCP session artifacts are local, not repository content. |
| `remember.state` | remember | ephemeral-state | path | block | block | block | Remember second-brain data is local, not repository content. |
| `superpowers.state` | superpowers | ephemeral-state | path | block | block | block | Superpowers plugin state is local, not repository content. |
| `agent.state` | generic | ephemeral-state | path | block | block | block | Generic agent state is local, not repository content. |
<!-- aimhooman:catalog-end -->
