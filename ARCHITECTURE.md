# Architecture

## Ownership

```text
Agent workbench UI
  -> host AgentStateStore and command routing
    -> isolated plugin Worker (this repository)
      -> permissioned host brokers
        -> model profiles / workspace / process / Skills / plugin storage
```

The host owns presentation, accessibility, tabs, session navigation, input controls, permission grants, workspace identity, secret model configuration, filesystem and process policy, canonical approval records, approval execution, and approval UI. The plugin owns orchestration, prompts, goal progress, session content, tool sequencing, and persistence schema.

No plugin-provided HTML, CSS, SVG, DOM callback, executable path, shell string, environment value, network URL, API key, or absolute local path crosses this boundary.

## Modules

| Repository module | Responsibility |
| --- | --- |
| `src/extension.js` | Single-file activation entry, session state, orchestration loop, context compaction, tool approvals, cancellation, localization refresh, and persistence. |
| `language-packs/*/messages.json` | Flat plugin-owned UI catalogs for `en`, `zh-CN`, and `ja`. |
| `scripts/package.mjs` | Dependency-free deterministic build, integrity generation, ZIP creation, CRC verification, and artifact verification. |
| `tests/extension.test.mjs` | Contract-level orchestration tests with a mock Plugin API 1.5 host. |
| `tests/package.test.mjs` | Determinism, archive boundary, integrity, and locale parity tests. |
| `.github/workflows/*.yml` | Three-platform CI and tag-gated release artifact publication. |

## Plugin API Contract

Version `1.2.0` targets BOBOCLOUD `>=2.8.0 <3.0.0` and Plugin API `^1.5.0`.

The runtime uses only these capabilities:

| Permission | Used for |
| --- | --- |
| `commands.register` | Register the nine commands referenced by the Agent descriptor. |
| `agents.register` | Publish one host-rendered provider and bounded state snapshots. |
| `models.generate` | List opaque model references, generate responses, and cancel an active request. |
| `workspace.read` | List, read, and search the current workspace through named tools. |
| `workspace.write` | Request and complete an approval-bound file write. |
| `process.execute` | Request and complete an approval-bound allowlisted process. |
| `skills.read` | Discover metadata and read only explicitly selected Skills. |
| `storage.local` | Persist bounded plugin-owned JSON under the host's user-data policy. |

The plugin intentionally does not request `commands.execute`, network access, generic contributions, services, SCM mutation, or document access.

## Session State

Persistent state uses schema version 2 and accepts schema version 1 for migration:

```text
preferences
  mode, reasoningEffort, accessMode, modelRef, skillIds
activeSessionId
sessions[]
  id, title, timestamps, status
  mode, reasoningEffort, accessMode, opaque modelRef, opaque skillIds
  messages[], timeline[], optional goal
  compaction summary and bounded metrics
```

At most 100 sessions, 200 messages per session, and 240 timeline items per session are retained. The host separately validates every state snapshot before rendering it.

Approval ids and in-flight model/tool execution state are deliberately memory-only. The Agent state sent from the Worker contains only `{ id }`; the workbench resolves all approval details from the canonical main-process broker. On activation, a persisted `running` or `waiting-approval` session becomes `cancelled`; stale approval state is never replayed after restart.

The public active-session snapshot exposes `compacting` plus bounded compaction metrics: `count`, `compactedMessages`, `estimatedTokensBefore`, `estimatedTokensAfter`, and `compactedAt`. The recovery summary itself never enters renderer state. It remains in plugin-local storage and is injected only into model context as lower-priority, untrusted background.

## Run State Machine

```text
idle/completed/failed/cancelled
  -> send
running
  -> final model response        -> completed
  -> tool result                 -> running
  -> approval-gated tool         -> waiting-approval
  -> model/tool error            -> failed
  -> cancel                      -> cancelled

waiting-approval
  -> trusted host approvalResult -> running
  -> trusted host rejection      -> running (goal remains blocked)
  -> cancel/restart/expiry       -> cancelled or failed
```

One run keeps one plugin-generated primary `requestId` across normal model rounds. A compaction request gets a separate plugin-generated id, never receives tools, and temporarily becomes the active cancellable request. Cancel calls `context.models.cancel(activeRequestId)` and discards late results through an in-memory run token. Pending approval cancellation only clears plugin orchestration state; process-tree cancellation belongs to the trusted workbench and main-process broker.

## Goal and Reasoning Modes

Goal mode publishes four visible steps: understand, inspect, act and verify, summarize. Tool execution advances those steps, completion closes them, and rejection or an unrecoverable error leaves the goal blocked. Chat mode skips goal state and favors direct responses.

Reasoning effort is sent both as the broker's structured `reasoningEffort` and as orchestration guidance. Providers that support native reasoning can consume the structured value; other providers still receive the behavioral instruction without a provider-specific dependency in this plugin.

The five values are `low`, `medium`, `high`, `xhigh`, and `max`, with bounded output budgets of 4,096, 8,192, 12,288, 16,384, and 24,576 tokens respectively. The plugin does not translate these values to provider-specific model names.

`ask`, `auto`, and `full` are session-scoped access-mode mirrors supplied by the host UI. They tune prompt expectations only. The plugin never treats them as authority, never skips `context.tools.invoke`, and never fabricates an approval result. The main-process access broker remains the sole source of effective policy and approval decisions.

## Context Compaction

Before a normal generation, the plugin estimates context size using a deterministic character-based heuristic. At approximately 49,152 estimated tokens it attempts to reduce context toward 24,576 tokens. It retains the preceding recent turn, the latest real user request, and at least the last three assistant interaction groups in the latest turn. An interaction group contains an assistant tool call and all following tool results, so compaction cannot split their causal pair. This also allows a single long user task with many tool rounds to compact before a second user message exists.

The summarizer receives at most 240 KiB of earlier raw history and a dedicated system prompt. It has no tool definitions and is instructed to preserve progress, constraints, preferences, decisions, critical references, tool and approval outcomes, verification, remaining work, and blockers in fewer than 1,200 words. Existing recovery summaries are deliberately excluded from the summarizer request. Each successful summary is appended as an immutable, timestamped segment capped at 12 KiB; all segments together are capped at 48 KiB. This makes recovery additive and prevents recursive summary-of-summary drift.

After success, only compacted persisted user and assistant messages are removed. The normal system policy, access guidance, selected Skills, durable recovery summary, and retained recent turns are rebuilt before generation. A visible `compaction` timeline event and bounded state metrics record the operation. If summarization fails, the event becomes failed and the run continues with original context; it will not retry compaction in every later round of that run. When the cumulative summary bound is reached, compaction stops rather than silently deleting old recovery data.

At most one successful compaction occurs per run. Starting, selecting, or sending to another session cancels an in-flight run in the previously active session before the host policy context changes. Session preference updates change only fields explicitly present in the trusted command payload, so a missing `accessMode` cannot inherit another session's policy mirror.

## Skills

The host discovers Skills and returns opaque ids plus bounded metadata. The plugin reads only ids selected in the Agent UI, limits each loaded Skill to 64 KiB and combined Skill context to 160 KiB, and includes that content in the run's system message. A Skill never expands the plugin's permissions or bypasses approval.

After context compaction, the plugin rebuilds the full system policy and reinjects selected Skills after the durable recovery summary. Skills and compacted history remain untrusted relative to system policy and cannot authorize tools.

## Tools and Approval

Read-only tools execute immediately. `workspace_write` and `process_run` return an opaque host-issued approval id without executing. The plugin publishes only `{ id }` and pauses. The trusted workbench resolves and renders canonical tool, summary, risk, expiry, and operation details from the main-process broker. After the host approves, rejects, or cancels the operation, it invokes the plugin command with the matching id and a validated, bounded `approvalResult`.

The Worker-facing `context.tools` surface contains only `invoke(tool, input)`. There are no Worker methods for approve, reject, or cancel, so downloaded code cannot redeem or control an approval capability directly.

The plugin checks that the returned action, approval id, optional tool name, and result disposition match its pending call, then adds that trusted result as the model's tool message and resumes the same run. The host remains responsible for path normalization, workspace identity checks, symlink containment, write conflict hashes, process allowlists, `shell: false`, timeouts, output bounds, process-tree cancellation, result sanitization, and invalidating approvals on workspace or plugin lifecycle changes.

## Cross-Platform Strategy

All package code is standard JavaScript and JSON. Platform-sensitive behavior is intentionally delegated to BOBOCLOUD's Electron main process. The same `.boboplugin` artifact is therefore portable across Windows, macOS, and Linux; CI runs its source and package tests on all three systems.

Portability does not mean every executable exists everywhere. The host's process allowlist and the user's installed toolchain determine whether an approved structured command can start, and failures return through the same bounded tool result path.
