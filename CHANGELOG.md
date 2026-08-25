# Changelog

## 1.2.0 - 2026-08-25

- Integrate with the refreshed host workbench controls embedded beside the Agent composer.
- Expose `goal` and `chat` as host slash-command modes through `/goal` and `/chat`.
- Keep five reasoning efforts and three access policies session-scoped while preserving host-owned authority.
- Preserve the Plugin API 1.5 capability contract without adding permissions or privileged plugin code.

## 1.1.0 - 2026-08-25

- Add `xhigh` and distinct bounded output budgets for all five reasoning efforts.
- Mirror host-owned `ask`, `auto`, and `full` access modes without granting plugin authority.
- Add threshold-based, recoverable, non-recursive context compaction with visible state and timeline events.
- Strengthen planning, evidence, structured-tool, approval, verification, and concise final-response guidance.
- Migrate local session storage to schema 2 while accepting schema 1 data.

## 1.0.0

- Add the official host-rendered AI Agent workbench provider.
- Add persistent sessions, chat and goal modes, four reasoning effort levels, and Skill selection.
- Add structured workspace read/search/list tools and approval-gated write/process tools.
- Add model cancellation and host-owned approval/process cancellation with stale-result rejection.
- Add English, Simplified Chinese, and Japanese localization.
- Add deterministic dependency-free packaging, cross-platform CI, and release automation.
