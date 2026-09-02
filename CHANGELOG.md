# Changelog

## Unreleased

## 1.4.0 - 2026-09-01

- Add dynamic Goal plans through a bounded plugin-internal `goal_update` tool while preserving host-owned tool authority.
- Load selected Skills progressively from metadata, bind reads to the discovered revision, deduplicate concurrent loads, and keep bounded loaded guidance across checkpoints.
- Replace append-only compaction segments with repeatable rolling context checkpoints sized from declared model context and output limits.
- Discover Plugin API 1.6 tool descriptors and parallelize only bounded batches marked both read-only and parallel-safe; Plugin API 1.5 falls back to list/read-only compatibility rules and keeps search serial.
- Stream ordered content and reasoning events into draft messages and non-persistent thought timelines, rejecting malformed or duplicate event sequences.
- Publish streaming progress through versioned incremental Agent state operations and recover a CAS miss or unsupported host with a complete state snapshot.
- Preserve requested reasoning preferences while reporting the host/model effective tier, including models that expose no native reasoning tier.
- Retain all 1.3.2/1.3.3 approval-terminal and unknown-side-effect protections, plus cancellation cleanup for in-flight progressive Skill events.
- Preserve API 1.6 nullable capability declarations, honor the host effective-effort map and the lower of provider/output request limits, and cancel malformed streams promptly.
- Stop every later sibling tool after a failed parallel read batch, and preserve explicitly updated blocked, pending, or in-progress Goal steps instead of fabricating completion.

## 1.3.3 - 2026-09-01

- Treat unknown `workspace_write` and `process_run` outcomes uniformly for approval and direct `auto`/`full` execution results.
- Block only the matching normalized write target or process invocation during the current run, while retaining read-only verification and unrelated side-effect targets.
- Include the original unknown tool-call id in a blocked retry result so the model can correlate the safety decision without another host invocation.
- Recover expired or evicted approvals whose trusted terminal envelope omits `tool`, but only for an exact pending id and the two explicit approval-unavailable error codes.

## 1.3.2 - 2026-09-01

- Consume host-reported post-approval execution failures as failed tool results instead of leaving a session waiting forever or reporting a user rejection.
- Preserve compatibility with older plugins through the existing rejected-result branch while requiring BOBOCLOUD 2.8.1 for reliable terminal delivery.
- Mark potentially started process failures as unknown outcomes, tell the model not to retry automatically, and block another `process_run` during that model run.

## 1.3.1 - 2026-08-31

- Stop rejected, cancelled, timed-out, or failed tool operations from executing stale sibling calls.
- Add bounded tool-call, repeated-call, and cumulative-result circuit breakers while preserving valid JSON results.
- Coalesce host state and storage snapshots, reject stale catalog refreshes, and clean late surface registrations during shutdown.
- Keep provider reasoning out of durable storage while exposing only a sanitized, bounded in-session thought summary and duration.
- Treat model output-limit finishes as incomplete runs and strengthen pre-loop failure recovery.
- Harden archive and checksum verification against duplicate entries, traversal, inconsistent ZIP metadata, stale workspace bytes, and mismatched release files.

## 1.3.0 - 2026-08-25

- Summarize the first request into a Unicode-safe, width-bounded session title, with optional low-cost model refinement and deterministic fallback.

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
