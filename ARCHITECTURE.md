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
| `src/extension.js` | Single-file activation entry, session state, dynamic Goal orchestration, progressive Skills, rolling checkpoints, streaming, bounded tool batching, approvals, cancellation, and persistence. |
| `language-packs/*/messages.json` | Flat plugin-owned UI catalogs for `en`, `zh-CN`, and `ja`. |
| `scripts/package.mjs` | Dependency-free deterministic build, integrity generation, ZIP creation, CRC verification, and artifact verification. |
| `tests/extension.test.mjs` | Contract-level orchestration tests with mock Plugin API 1.5 and 1.6 hosts. |
| `tests/package.test.mjs` | Determinism, archive boundary, integrity, and locale parity tests. |
| `.github/workflows/*.yml` | Three-platform CI and tag-gated release artifact publication. |

## Plugin API Contract

Version `1.4.0` targets BOBOCLOUD `>=2.8.1 <3.0.0` and Plugin API `^1.5.0`. The manifest remains compatible with API 1.5; every 1.6 optimization is selected by validated runtime fields or optional methods, never by guessing from a version string.

The runtime uses only these capabilities:

| Permission | Used for |
| --- | --- |
| `commands.register` | Register the nine commands referenced by the Agent descriptor. |
| `agents.register` | Publish one host-rendered provider, complete snapshots, and optional versioned incremental state operations. |
| `models.generate` | List opaque model references and capabilities, generate or stream responses, and cancel an active request. |
| `workspace.read` | List, read, and search the current workspace through named tools. |
| `workspace.write` | Request and complete an approval-bound file write. |
| `process.execute` | Request and complete an approval-bound allowlisted process. |
| `skills.read` | Discover metadata and read only explicitly selected Skills. |
| `storage.local` | Persist bounded plugin-owned JSON under the host's user-data policy. |

The plugin intentionally does not request `commands.execute`, network access, generic contributions, services, SCM mutation, or document access.

## Session State

Persistent state uses schema version 3 and accepts schema versions 1 and 2 for migration:

```text
preferences
  mode, reasoningEffort, accessMode, modelRef, skillIds
activeSessionId
sessions[]
  id, title, timestamps, status
  mode, requested/effective reasoning effort, accessMode, opaque modelRef, opaque skillIds
  messages[], timeline[], optional goal
  rolling checkpoint and bounded compaction-compatible metrics
```

At most 100 sessions, 200 messages per session, and 240 timeline items per session are retained. The host separately validates every state snapshot before rendering it.

State publication and storage use latest-value coalescing. On API 1.6, streamed progress uses only the four schema-owned operations `state.merge`, `session.merge`, `message.upsert`, and `timeline.upsert` against the provider's last acknowledged version. An unapplied CAS operation, invalid response, missing `updateState`, or patch failure immediately falls back to `setState()` with a complete current snapshot. API 1.5 always uses complete snapshots. Shutdown rejects late model/catalog/surface results, disposes registrations that finish after deactivation, waits for an active storage write, and then writes one final bounded state snapshot.

Approval ids and in-flight model/tool execution state are deliberately memory-only. The Agent state sent from the Worker contains only `{ id }`; the workbench resolves all approval details from the canonical main-process broker. On activation, a persisted `running` or `waiting-approval` session becomes `cancelled`; stale approval state is never replayed after restart.

The public active-session snapshot exposes `compacting` plus bounded checkpoint metrics through the compatible compaction shape: `count`, `compactedMessages`, `estimatedTokensBefore`, `estimatedTokensAfter`, and `compactedAt`. The checkpoint text itself never enters renderer state. It remains in plugin-local storage and is injected only into model context as lower-priority, untrusted background. API 1.6 also displays `effectiveReasoningEffort`; API 1.5 snapshots omit that unknown field.

Provider reasoning text is never persisted. During the active process lifetime, ordered reasoning deltas or a final response may publish a control-character-sanitized thought summary capped at 8 KiB plus a localized duration; every storage snapshot clears that detail. Loading older schema-1, schema-2, or schema-3 state removes stored message/timeline reasoning and re-sanitizes session titles before the host sees them.

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

One run keeps one plugin-generated primary `requestId` across normal model rounds. A checkpoint request gets a separate plugin-generated id, never receives tools, and temporarily becomes the active cancellable request. When `models.generateStream` exists and the selected model has not explicitly declared `streaming: false`, the plugin attempts the compatible stream path; events must carry the exact request id and a strictly increasing sequence. Content deltas update one draft message; reasoning deltas update one non-persistent thought item; tool-call deltas are informational and only the final returned result can authorize orchestration. Duplicate, malformed, or unknown protocol events fail safely and immediately request cancellation of the matching model stream; a canonical terminal model error remains a normal failed terminal event. Late results are discarded through an in-memory run token.

A run is capped at 64 tool calls, three consecutive identical calls, 96 KiB per model-facing tool result, and 512 KiB of cumulative model-facing tool results. Oversized results remain valid JSON with bounded head/tail previews. Invalid arguments, invocation errors, non-zero process exits, timeouts, cancellations, and rejected approvals stop the remaining sibling calls from that model turn so the model must observe the result and replan. Model finish reasons that indicate an output limit preserve partial text but fail the run instead of reporting false completion.

## Goal and Reasoning Modes

Goal mode starts with one localized planning placeholder and exposes the plugin-internal `goal_update` model tool. A valid update atomically replaces the visible title and one to twelve bounded task-specific steps while preserving ids explicitly returned by an earlier update. This control tool has no host permission or side-effect authority. A run that never replaces the placeholder may close that placeholder on success. Once the model explicitly updates the Goal, final text cannot fabricate completion: completed, blocked, pending, and in-progress step states remain authoritative, and the aggregate Goal is derived from them. Rejection, an unresolved tool failure, or an unknown side effect still blocks the Goal. Chat mode does not expose `goal_update` and skips Goal state.

Requested reasoning effort is sent both as the broker's structured `reasoningEffort` and as orchestration guidance. API 1.6 model metadata declares the portable tiers the selected connection can actually implement. The plugin first applies the host's requested-to-effective `effectiveEffortMap`, falls back to the nearest declared tier without exceeding the request only when no mapping exists, then accepts the host's final `effectiveReasoningEffort` (including `none`) as authoritative. API 1.5 keeps requested and effective behavior compatible without adding an unknown renderer field.

The five values are `low`, `medium`, `high`, `xhigh`, and `max`, with bounded output budgets of 4,096, 8,192, 12,288, 16,384, and 24,576 tokens respectively. The plugin does not translate these values to provider-specific model names.

`ask`, `auto`, and `full` are session-scoped access-mode mirrors supplied by the host UI. They tune prompt expectations only. The plugin never treats them as authority, never skips `context.tools.invoke`, and never fabricates an approval result. The main-process access broker remains the sole source of effective policy and approval decisions.

## Rolling Context Checkpoints

Before a normal generation, the plugin estimates message and tool-schema size using a deterministic character heuristic. If API 1.6 declares a real context window and maximum output, the checkpoint threshold reserves the requested output, a safety margin, and tool definitions from that window; threshold and target remain positive and never exceed the declared window, even for a very small connection-specific limit. `maxOutputTokens` remains the provider's real model capability, while an optional `requestOutputLimitTokens` is the host's safer per-request ceiling; generated requests use the lower applicable limit without rewriting the provider capability. Only an unknown context window uses the API 1.5 fallback of approximately 49,152 tokens toward 24,576. Host-valid positive token limits are preserved exactly, including output limits below 1,024, and a missing request-limit field retains API 1.5 and early API 1.6 behavior. It retains recent turns, the latest real user request, and at least the last three assistant interaction groups in the current turn. An interaction group contains an assistant tool call and all following tool results, so checkpointing cannot split their causal pair.

The checkpoint model receives at most 240 KiB of newly retired history plus the previous bounded checkpoint in separate untrusted-data sections. It has no tools and must return one self-contained checkpoint under 1,200 words, preserving progress, constraints, decisions, critical references, exact tool and approval outcomes, verification, remaining work, and blockers while dropping superseded facts. A successful result atomically replaces the previous checkpoint instead of growing an append-only summary forever.

After success, only checkpointed persisted user and assistant messages are removed. The normal system policy, access guidance, Skill catalog, already loaded Skill bodies, rolling checkpoint, and retained recent turns are rebuilt before generation. A visible compatible `compaction` timeline item records the checkpoint. If generation fails, the event becomes failed and the run continues with original context without retrying every round.

Up to six checkpoints may occur in a single long run, but another checkpoint is considered only after new causal messages were added. Starting, selecting, or sending to another session cancels an in-flight run in the previously active session before the host policy context changes. Session preference updates change only fields explicitly present in the trusted command payload, so a missing `accessMode` cannot inherit another session's policy mirror.

## Skills

The host discovers Skills and returns opaque ids plus bounded metadata. API 1.6 also supplies revision, byte size, and estimated tokens. The initial system message contains only bounded metadata for explicitly selected Skills. The model must call the plugin-internal, read-only `skill_load` tool when one is relevant; the plugin verifies selection, passes the discovered revision to `skills.read`, deduplicates concurrent reads, caches the body for the run, and enforces per-Skill, total-character, count, and model-window-derived limits. A model without tool support receives the selected bodies eagerly as a compatibility fallback. A Skill never expands permissions or bypasses approval.

After a rolling checkpoint, already loaded Skill bodies are reinjected after the system policy and remain available without another read. Skill metadata, bodies, tool output, and checkpoint text remain untrusted relative to system policy and cannot authorize tools.

## Tools and Approval

On API 1.6, `tools.list()` supplies bounded descriptions, input schemas, risk, workspace requirements, and `readOnly`/`parallelSafe` flags. Capability booleans remain three-state: only explicit `tools: false` disables tools, while `null` retains the compatible tool path; `streaming: null` likewise tries an available stream API, while parallel execution remains conservative and requires explicit `parallelToolCalls: true`. The model receives only the validated tool catalog plus applicable internal control tools. Consecutive model calls are parallelized in batches of at most four only when every call is host-declared read-only and parallel-safe and the model declares parallel-tool support. Results are restored to original call order. Any failure in that batch is returned to the model and short-circuits every later sibling call, so a following write or process cannot run from stale or incomplete inspection. On API 1.5, only `workspace_list` and `workspace_read` use that fallback; `workspace_search` stays serial because the legacy broker permits one search per plugin. Writes, processes, unknown tools, and Goal updates are always sequential.

`workspace_write` and `process_run` return an opaque host-issued approval id without executing when trusted policy requires it. The plugin publishes only `{ id }` and pauses. The trusted workbench resolves and renders canonical tool, summary, risk, expiry, and operation details from the main-process broker. After the host approves, rejects, or cancels the operation, it invokes the plugin command with the matching id and a validated, bounded `approvalResult`.

The Worker-facing `context.tools` surface contains `invoke(tool, input)` and, on API 1.6, read-only `list()`. There are no Worker methods for approve, reject, decide, or cancel, so downloaded code cannot redeem or control an approval capability directly. A catalog descriptor is metadata, not authority.

The plugin checks that the returned action, approval id, optional tool name, and result disposition match its pending call, then adds that trusted result as the model's tool message and resumes the same run. If the host consumes an approval but the operation subsequently fails, it uses the compatible reject command with `{ rejected: true, failed: true, tool, errorCode, errorMessage, outcome, mayHaveExecuted }`; the plugin marks the tool failed, preserves the exact failure for the next model round, and never labels it as a user rejection. If a host reload or bounded tombstone eviction makes the canonical tool unavailable, the plugin accepts an omitted `tool` only for an exact pending approval id and the explicit `AGENT_APPROVAL_NOT_FOUND` or `AGENT_APPROVAL_EXPIRED` terminal codes; empty, mismatched, and other toolless failures remain rejected. The pending call supplies the internal tool identity before the result reaches orchestration. Unknown side-effect outcomes are tracked for both approval recovery and direct `auto`/`full` results. During that run, `workspace_write` is keyed by its normalized target path and `process_run` by command, arguments, and working directory. The matching target is blocked before another broker call, while read-only verification and unrelated targets remain available; a new user turn starts a fresh run. The host remains responsible for path normalization, workspace identity checks, symlink containment, write conflict hashes, process allowlists, `shell: false`, timeouts, output bounds, process-tree cancellation, result sanitization, and invalidating approvals on workspace or plugin lifecycle changes.

Catalog refreshes carry a monotonically increasing local sequence so an older model/Skill query cannot overwrite a newer result. Locale-triggered surface rebuilds capture their runtime owner; partial or late command/provider registrations are disposed if the plugin is replaced or deactivated before registration finishes.

## Package Verification

The deterministic package verifier compares the current archive with the workspace manifest and every packaged file, verifies the checksum filename and digest, and requires the reviewed permission/localization/integrity sets exactly. ZIP parsing rejects duplicate or escaping paths, unsupported flags or compression, inconsistent local/central metadata, oversized entries, malformed lengths, CRC mismatches, and decompression beyond the package limit.

## Cross-Platform Strategy

All package code is standard JavaScript and JSON. Platform-sensitive behavior is intentionally delegated to BOBOCLOUD's Electron main process. The same `.boboplugin` artifact is therefore portable across Windows, macOS, and Linux; CI runs its source and package tests on all three systems.

Portability does not mean every executable exists everywhere. The host's process allowlist and the user's installed toolchain determine whether an approved structured command can start, and failures return through the same bounded tool result path.
