---
name: Bug report
about: Something aimhooman flagged incorrectly, missed, or did wrong
title: ""
labels: bug
assignees: ""
---

## Summary

<!-- One or two sentences: what happened, and what you expected. -->

## What kind of issue is it?

- [ ] False positive (flagged something it should not have)
- [ ] False negative (missed something it should have caught)
- [ ] A commit was cancelled / blocked when it should not have been
- [ ] AI attribution was not stripped from a commit message
- [ ] Crash or unexpected error
- [ ] Other

## Reproduction

```sh
# the exact commands or staged paths that trigger it
```

## Environment

- aimhooman version: <!-- `aimhooman version` -->
- Node version: <!-- `node --version` -->
- Profile: <!-- clean / strict / compliance (`aimhooman status`) -->
- Host: <!-- Claude Code / Codex / Copilot CLI / terminal git / other -->
- Rule id (if known): <!-- e.g. claude.session-state; `aimhooman explain <id>` -->

## Expected vs actual

**Expected:**
**Actual:**
