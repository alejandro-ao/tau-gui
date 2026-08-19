# Tau/Pi RPC protocol reference

Audited against `tau` (`src/tau_coding/rpc.py`, `tests/test_rpc.py`) and Pi
(`packages/coding-agent/src/modes/rpc/*`). Tau's RPC mode is a deliberate clone of
Pi's JSONL protocol, which is what makes a single desktop adapter possible.

This document is the contract implemented by `src/main/rpc/*` and
`src/main/runtime/*`. The renderer never sees any of these shapes; they are
normalized into `src/shared/domain.ts` first.

## Launch

```text
tau --mode rpc --cwd DIR [--provider NAME] [--model ID] [--session ID]
                        [--approve | --no-approve] [extra args…]
pi  --mode rpc          [--provider NAME] [--model ID] [extra args…]
```

- Tau resumes by indexed **session id** (`--session`); Pi resumes by **session
  path** through `switch_session` after start. `buildLaunchSpec` encodes this
  difference (`src/main/runtime/spec.ts`).
- Tau has no interactive project trust in RPC mode: unresolved trust declines
  unless `--approve` is passed. `ProjectTrust` maps to `--approve`/`--no-approve`.
- Arguments are always passed as an array. No shell interpolation, ever.
- stdout is protocol; stderr is diagnostics (Tau routes extension UI there).

## Framing

- Records are separated by `\n` only. A single trailing `\r` is tolerated.
- UTF-8; output is compact and may contain raw non-ASCII.
- `U+2028`/`U+2029` are ordinary characters — never use a splitter that treats
  them as line terminators.
- Blank lines are skipped. Tau enforces a 16 MiB maximum record size.
- Writes are serialized by the runtime, so responses and events never interleave
  partially.
- stdin EOF requests clean shutdown (cancels in-flight work, closes providers).

## Requests

Envelope: `{"id": <any>, "type": "<command>", …params}`. Responses:

```json
{"type":"response","command":"prompt","success":true,"id":"r1"}
{"type":"response","command":"set_model","success":false,"error":"…","id":"r7"}
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: …"}
```

`data` is omitted when null, except `cycle_model`/`cycle_thinking_level` no-ops
which return `"data": null`. Errors are plain prose, no codes.

| Command                                        | Params                                                | `data`                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt` / `steer` / `follow_up`               | `message`, `streamingBehavior?` (`steer`\|`followUp`) | —                                                                                                                                              |
| `abort`                                        | —                                                     | —                                                                                                                                              |
| `get_state`                                    | —                                                     | model, thinkingLevel, isStreaming, isCompacting, sessionFile, sessionId, sessionName, autoCompactionEnabled, messageCount, pendingMessageCount |
| `get_messages`                                 | —                                                     | `{messages: AgentMessage[]}`                                                                                                                   |
| `get_available_models`                         | —                                                     | `{models: Model[]}`                                                                                                                            |
| `set_model`                                    | `modelId`, `provider?` (required on Pi)               | `Model`                                                                                                                                        |
| `cycle_model`                                  | —                                                     | `{model, thinkingLevel, isScoped}` \| `null`                                                                                                   |
| `get_available_thinking_levels`                | —                                                     | `{levels: string[]}` (may be empty)                                                                                                            |
| `set_thinking_level`                           | `level`                                               | — (Pi returns `{level}`)                                                                                                                       |
| `cycle_thinking_level`                         | —                                                     | `{level}` \| `null`                                                                                                                            |
| `compact`                                      | `customInstructions?`                                 | `{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, details}`                                                                     |
| `set_auto_compaction`                          | `enabled` (bool)                                      | —                                                                                                                                              |
| `bash`                                         | `command`, `excludeFromContext?`                      | `{output, exitCode, cancelled, truncated}`                                                                                                     |
| `abort_bash`                                   | —                                                     | Tau: always fails. Pi: supported                                                                                                               |
| `new_session`                                  | —                                                     | `{cancelled}`                                                                                                                                  |
| `switch_session`                               | `sessionId` (Tau) or `sessionPath`                    | `{cancelled}`                                                                                                                                  |
| `set_session_name`                             | `name`                                                | —                                                                                                                                              |
| `fork`                                         | `entryId`                                             | `{text, cancelled}`                                                                                                                            |
| `get_entries`                                  | `since?`                                              | `{entries, leafId}`                                                                                                                            |
| `get_tree`                                     | —                                                     | `{tree: {entry, children}[], leafId}`                                                                                                          |
| `get_session_stats`                            | —                                                     | tokens/cost/contextUsage summary                                                                                                               |
| `export_html`                                  | `outputPath?`                                         | `{path}`                                                                                                                                       |
| `get_commands`                                 | —                                                     | `{commands: {name, description, …}[]}`                                                                                                         |
| `get_fork_messages`, `get_last_assistant_text` | —                                                     | user-entry list / last text                                                                                                                    |

Pi-only: `set_steering_mode`, `set_follow_up_mode`, `set_auto_retry`,
`abort_retry`, `clone`, `images` on prompts, extension-UI subprotocol.

Important behavioral details the adapter relies on:

- `prompt` responds **after** the first event is produced, so pre-flight failures
  (already running, bad skill reference, provider config) arrive as a correlated
  failure and nothing streams.
- Post-acceptance failures never produce a second response; they arrive as
  `{"type":"rpc_error","error":"…"}` and **no** `agent_settled` follows. The
  adapter must clear "running" on `rpc_error` too.
- `compact`, `bash`, and `export_html` are synchronous and can be slow: request
  them without a timeout.
- Tau's direct `bash` does not stream and cannot be cancelled.

## Events

All payload keys are camelCase.

```text
agent_start
turn_start
  message_start / message_end          (user, assistant, toolResult, …)
  message_update {message, assistantMessageEvent}   ← streaming deltas
  tool_execution_start / _update / _end
turn_end
[compaction_start / compaction_end]    (overflow path only)
[auto_retry_start / … / auto_retry_end]
agent_end {messages, willRetry}
agent_settled
queue_update {steering, followUp}      (native queue observation only)
rpc_error {error}
```

`assistantMessageEvent.type` is one of `start`, `text_start|delta|end`,
`thinking_start|delta|end`, `toolcall_start|delta|end`, `done`, `error`. Each
carries a cumulative `partial`/`message` snapshot, so a dropped delta cannot
corrupt the transcript.

**`agent_settled`, not `agent_end`, means idle.** `agent_end` is also emitted
before overflow compaction and the subsequent automatic retry. GUI submissions
made during a run are held in the app-owned main-process queue; after this idle
boundary they are dispatched as fresh `prompt` requests. Native `queue_update`
events are therefore not authoritative for editable GUI prompts.

Tau never emits `bash_execution_update`, `extension_error`, `entry_appended`,
`session_info_changed`, or `thinking_level_changed`. Pi emits the first two.

## Message shapes

Roles: `user` (content is a string or text/image blocks), `assistant` (text /
thinking / toolCall blocks plus `usage`, `stopReason`, `errorMessage`),
`toolResult`, `bashExecution` (Pi only; Tau appends a formatted `user` message),
`custom`, `branchSummary`, `compactionSummary`.

`stopReason` ∈ `stop | length | toolUse | error | aborted`.

## Session entries

Projected entry types: `message`, `custom_message`, `model_change`,
`thinking_level_change`, `compaction`, `branch_summary`, `custom`, `label`,
`session_info`. `leaf` entries are filtered out by the runtime; `leafId` marks
the active branch tip. Timestamps are ISO-8601 UTC.

Session JSONL files are runtime-owned. The GUI never reads them.

## Capability differences

| Capability                         | Tau            | Pi                    |
| ---------------------------------- | -------------- | --------------------- |
| text prompt, steering, follow-ups  | yes            | yes                   |
| image prompts                      | no             | yes                   |
| direct bash                        | yes (blocking) | yes (streaming)       |
| cancel direct bash                 | no             | yes                   |
| queue modes / retry controls       | no             | yes                   |
| session clone                      | no             | yes                   |
| portable session listing           | no             | no                    |
| extension dialogs/widgets          | no             | yes (own subprotocol) |
| scoped model list/toggle commands  | no             | no                    |
| `/system`, `/tools`, login, reload | no             | partial               |

`src/main/runtime/spec.ts` is the single source of truth for these flags in the
app, and the renderer must gate optional controls on them rather than guessing.

Neither runtime exposes a command to list or edit scoped models; `cycle_model`
only reports the runtime's own `isScoped` flag for the model it selected. The
GUI therefore owns scoped ("favourite") models itself: the list lives in
`AppSettings.scopedModels` and is applied with plain `set_model` calls. No
scoped-model command is ever sent to a runtime.
