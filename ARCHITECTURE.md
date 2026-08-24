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
| `src/extension.js` | Single-file activation entry, session state, orchestration loop, tool approvals, cancellation, localization refresh, and persistence. |
| `language-packs/*/messages.json` | Flat plugin-owned UI catalogs for `en`, `zh-CN`, and `ja`. |
| `scripts/package.mjs` | Dependency-free deterministic build, integrity generation, ZIP creation, CRC verification, and artifact verification. |
| `tests/extension.test.mjs` | Contract-level orchestration tests with a mock Plugin API 1.4 host. |
| `tests/package.test.mjs` | Determinism, archive boundary, integrity, and locale parity tests. |
| `.github/workflows/*.yml` | Three-platform CI and tag-gated release artifact publication. |

## Plugin API Contract

The manifest requires BOBOCLOUD `>=2.7.0 <3.0.0`, Plugin API `^1.4.0`, and only these capabilities:

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

Persistent state uses schema version 1:

```text
preferences
  mode, reasoningEffort, modelRef, skillIds
activeSessionId
sessions[]
  id, title, timestamps, status
  mode, reasoningEffort, opaque modelRef, opaque skillIds
  messages[], timeline[], optional goal
```

At most 100 sessions, 200 messages per session, and 240 timeline items per session are retained. The host separately validates every state snapshot before rendering it.

Approval ids and in-flight model/tool execution state are deliberately memory-only. The Agent state sent from the Worker contains only `{ id }`; the workbench resolves all approval details from the canonical main-process broker. On activation, a persisted `running` or `waiting-approval` session becomes `cancelled`; stale approval state is never replayed after restart.

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

One run keeps one plugin-generated `requestId` across all model rounds. Cancel calls only `context.models.cancel(requestId)` when a model request is active and discards late results through an in-memory run token. Pending approval cancellation only clears plugin orchestration state; process-tree cancellation belongs to the trusted workbench and main-process broker.

## Goal and Reasoning Modes

Goal mode publishes four visible steps: understand, inspect, act and verify, summarize. Tool execution advances those steps, completion closes them, and rejection or an unrecoverable error leaves the goal blocked. Chat mode skips goal state and favors direct responses.

Reasoning effort is sent both as the broker's structured `reasoningEffort` and as orchestration guidance. Providers that support native reasoning can consume the structured value; other providers still receive the behavioral instruction without a provider-specific dependency in this plugin.

## Skills

The host discovers Skills and returns opaque ids plus bounded metadata. The plugin reads only ids selected in the Agent UI, limits each loaded Skill to 64 KiB and combined Skill context to 160 KiB, and includes that content in the run's system message. A Skill never expands the plugin's permissions or bypasses approval.

## Tools and Approval

Read-only tools execute immediately. `workspace_write` and `process_run` return an opaque host-issued approval id without executing. The plugin publishes only `{ id }` and pauses. The trusted workbench resolves and renders canonical tool, summary, risk, expiry, and operation details from the main-process broker. After the host approves, rejects, or cancels the operation, it invokes the plugin command with the matching id and a validated, bounded `approvalResult`.

The Worker-facing `context.tools` surface contains only `invoke(tool, input)`. There are no Worker methods for approve, reject, or cancel, so downloaded code cannot redeem or control an approval capability directly.

The plugin checks that the returned action, approval id, optional tool name, and result disposition match its pending call, then adds that trusted result as the model's tool message and resumes the same run. The host remains responsible for path normalization, workspace identity checks, symlink containment, write conflict hashes, process allowlists, `shell: false`, timeouts, output bounds, process-tree cancellation, result sanitization, and invalidating approvals on workspace or plugin lifecycle changes.

## Cross-Platform Strategy

All package code is standard JavaScript and JSON. Platform-sensitive behavior is intentionally delegated to BOBOCLOUD's Electron main process. The same `.boboplugin` artifact is therefore portable across Windows, macOS, and Linux; CI runs its source and package tests on all three systems.

Portability does not mean every executable exists everywhere. The host's process allowlist and the user's installed toolchain determine whether an approved structured command can start, and failures return through the same bounded tool result path.
