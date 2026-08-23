# Product Requirements: Interactive Coding-Agent Application

- **Status:** Normative product specification
- **Audience:** A coding agent or engineering team implementing the product from scratch
- **Implementation constraint:** Stack agnostic
- **Reference products:** Tau TUI and Tau GUI

## 1. Instructions to the implementer

Build a complete, usable coding-agent application that satisfies this document.

You may choose any programming language, UI framework, runtime, persistence format, model SDK, or deployment format. The product may be a terminal application, native desktop application, local web application, or another interactive client.

This document specifies **observable behavior**, not implementation architecture. Do not copy technology choices from the reference products unless they are appropriate for your implementation.

When a requirement leaves room for interpretation:

1. Preserve user work and session integrity.
2. Prefer explicit, reversible behavior over hidden automation.
3. Keep the transcript readable during long agent runs.
4. Keep the user informed about what the agent is doing.
5. Never imply an unsupported capability exists.
6. Choose secure defaults.

A feature is not complete merely because a control exists. It is complete when its behavior, errors, loading states, keyboard/mouse interaction, persistence, and acceptance scenarios work.

---

## 2. Product definition

The product is an interactive coding assistant that works inside a user-selected project directory.

A user can:

- Ask the agent to inspect, explain, modify, and test a codebase.
- Watch text, reasoning, and tool activity stream in real time.
- Interrupt, steer, or queue more work while the agent is running.
- Review exact commands, file operations, outputs, and patches.
- Resume durable sessions and branch from earlier history.
- Switch providers, models, and reasoning effort.
- Supply project instructions, reusable skills, and prompt templates.
- Run shell commands directly when desired.
- Understand context usage, cost, caching, and compaction.
- Work efficiently with keyboard or pointer input.

The application is **not** a generic chat client. Its defining qualities are:

- project/worktree awareness;
- transparent tool execution;
- durable, branchable work history;
- active-run control;
- model/provider flexibility;
- safe access to local files and commands;
- a dense, transcript-first interface.

---

## 3. Product goals

### G1. Useful within one minute

A new user should be able to open a project, connect a model provider, submit a prompt, observe the agent inspect the repository, and receive a result without reading documentation.

### G2. Trust through transparency

The user must be able to see what the agent is doing, which files it touches, what commands it runs, and whether each operation succeeded.

### G3. Fast interactive control

The application must remain usable while the agent works. The user can cancel, steer, queue follow-up work, inspect earlier output, and prepare the next prompt without waiting.

### G4. Durable continuity

Sessions survive restart. Resuming restores the conversation, tool history, model identity, working directory, and active branch without corrupting provider message history.

### G5. Long-session usability

Streaming, scrolling, context accounting, compaction, and transcript rendering remain responsive and understandable in long sessions.

### G6. Implementation independence

The requirements must be achievable using an embedded agent engine, an external runtime, a local service, or direct provider integrations.

---

## 4. Non-goals

The first complete version does not need to:

- Be a full IDE or replace the user's editor.
- Provide a general-purpose terminal emulator.
- Synchronize sessions across devices.
- Support collaborative multi-user editing.
- Execute arbitrary third-party plugins without a trust model.
- Reproduce every visual detail of Tau.
- Support every model provider on launch.
- Hide uncertainty about provider capabilities or usage data.

---

## 5. Priority levels

- **P0 — Core:** Required for the product to qualify as a coding-agent application.
- **P1 — Complete:** Required for a strong Tau-like product.
- **P2 — Advanced:** Differentiating behavior that may follow after P0/P1 is stable.

The Definition of Done in section 25 states the minimum one-shot delivery target.

---

## 6. Core product concepts

### 6.1 Project

A project is the working directory in which the agent reads files, writes files, and runs commands.

Requirements:

- Every session has an explicit working directory.
- The active directory is always visible or easy to inspect.
- Relative paths resolve from that directory.
- Opening another project does not silently redirect an active session.
- Existing Git worktrees are treated as distinct working directories.

### 6.2 Session

A session is one durable conversation and its agent activity.

It includes:

- user messages;
- assistant messages;
- reasoning/thinking when available;
- tool calls and results;
- model/provider changes;
- compaction and branch summaries;
- session name;
- working directory;
- active history branch;
- usage metadata when available.

### 6.3 Run

A run starts when a user prompt is accepted and ends only when the agent has no immediate tool execution, retry, compaction, or continuation remaining.

The product must distinguish:

- **idle** — ready for a new prompt;
- **working** — model or tools are active;
- **retrying** — recovering from a transient failure;
- **compacting** — reducing context;
- **cancelling** — cancellation requested but cleanup is incomplete;
- **failed** — the run ended unsuccessfully;
- **disconnected** — the runtime is unavailable.

### 6.4 Turn

A turn contains one user message and the model/tool activity caused by it. One run may contain multiple model continuations because tool results are fed back to the model.

### 6.5 Tool

A tool is a typed action the model can request. P0 tools are:

- read a file;
- create or overwrite a file;
- apply exact edits to a file;
- execute a shell command.

### 6.6 Resource

A resource is reusable context or behavior, including:

- project instructions;
- skills;
- prompt templates;
- optional extensions.

---

## 7. Primary user experience

### 7.1 Default layout — P0

The default interface is transcript-first.

It must contain:

1. A scrollable transcript occupying most of the available space.
2. A multiline prompt composer near the bottom.
3. A compact indication of active model and run status.
4. Access to sessions, settings, commands, and context details without permanently overwhelming the transcript.

A wide layout should provide optional project/session navigation and context metadata beside the transcript. A narrow layout may collapse these into drawers, pickers, or compact rows.

Do not use chat bubbles as the primary message style. User, assistant, reasoning, status, and tool content must be visually distinguishable without excessive boxes.

### 7.2 Responsive behavior — P1

- The transcript and composer remain usable at the minimum supported size.
- Sidebars hide, collapse, or become drawers when space is limited.
- Important status moves into a compact form rather than disappearing.
- Modals/pickers fit within the viewport and remain scrollable.
- Long paths and model names truncate without hiding their full value from accessible text or a detail view.

### 7.3 Theme behavior — P1

Provide at least:

- dark theme;
- light theme;
- high-contrast theme.

Theme colors must have semantic roles for:

- accent/focus;
- user content;
- assistant content;
- reasoning;
- running tool;
- successful tool;
- failed tool;
- warning;
- error;
- muted metadata;
- shell mode.

Theme changes persist and update the entire application consistently.

---

## 8. Transcript requirements

### 8.1 Message presentation — P0

The transcript must render:

- user messages;
- streaming and completed assistant messages;
- reasoning/thinking when supplied;
- tool execution;
- direct shell execution;
- errors;
- cancellation status;
- retry status;
- compaction summaries;
- branch summaries;
- transient application notices.

User-authored text must be visually distinct from model output. Tool and status blocks must not look like assistant answers.

### 8.2 One clear answer per turn — P1

Models may emit narration before tool calls and several assistant fragments during a turn.

The product should present:

- intermediate narration, reasoning, and tool calls as one ordered activity sequence;
- the assistant message that closes the turn as the clear final answer;
- reasoning-only activity as a collapsible thought sequence;
- all original content when expanded.

Do not discard intermediate content. This is a presentation rule, not a history rewrite.

### 8.3 Ordered activity — P0

Preserve the order in which reasoning, assistant text, tool calls, and tool results occurred. Never move all reasoning to the start or all tools to the end if the runtime interleaved them.

### 8.4 Markdown and code — P0

Assistant content supports readable Markdown:

- headings;
- paragraphs;
- lists;
- quotes;
- emphasis;
- links;
- inline code;
- fenced code blocks.

Unknown code-language labels must fall back to plain code. Malformed Markdown must not crash the transcript.

Untrusted content must never gain privileged execution, markup injection, local-file access, or unsafe navigation.

### 8.5 Copying and selection — P0

- Users can select and copy transcript text normally.
- Individual messages provide a copy action where the interface supports it.
- Copy controls do not alter layout when they appear.
- Copying a wrapped line produces the intended source text.
- Tool details and patches remain copyable.

### 8.6 Tool presentation — P0

Each tool call shows:

- action/tool name;
- concise human-readable purpose;
- running/success/failure state;
- elapsed time for work long enough to matter;
- relevant path or command summary;
- expandable exact arguments;
- expandable result/output;
- error details when failed.

Status colors:

- running: warm/orange;
- success: green;
- failure: red.

Long output is collapsed to a bounded preview by default. The complete result remains available in durable history and through expansion or an explicit full-output view.

### 8.7 Tool grouping — P1

Adjacent related tool calls from one model response should group into one readable activity block.

Examples:

- several reads list the files read;
- several edits list changed files and aggregate failures;
- serialized edits/writes to the same file may appear as one logical action;
- shell commands remain distinct unless they are clearly one batch.

Grouping must never:

- combine calls from different model responses;
- cross intervening assistant text or reasoning;
- hide an individual failure;
- remove exact per-call details from expansion;
- alter execution or persistence.

### 8.8 Diffs and patches — P1

Successful edits should expose a readable diff or patch showing additions and removals. The compact state may show only the changed file and line summary.

### 8.9 Streaming behavior — P0

- New text appears incrementally.
- Tool progress updates appear while the tool is running, not only after completion.
- Final authoritative content replaces or finalizes its in-progress representation without duplication.
- High-frequency deltas may be visually batched, but all pending text flushes at message, tool, error, cancellation, and run boundaries.
- A slow stream must not freeze composer input, scrolling, or navigation.

### 8.10 Optimistic user message — P1

A plain submitted prompt appears immediately, before provider work or persistence completes.

When the authoritative user message arrives:

- exact duplicates are merged;
- transformed prompts replace the optimistic text in place;
- resource/template expansions do not show both raw and expanded copies;
- failed preflight submissions clearly reconcile or remove the optimistic row.

### 8.11 Scroll behavior — P0

- Follow streaming output only while the reader is at or near the bottom.
- If the user scrolls upward, do not force them back down.
- Show a “new output” affordance while output arrives off-screen.
- Returning to the bottom resumes following.
- Sending a new prompt explicitly jumps to the tail and keeps the sent message visible above the composer.
- Delayed layout/measurement changes must not break a programmatic tail pin.

### 8.12 Long transcript performance — P1

The application must remain responsive with thousands of transcript items.

It may window or virtualize presentation, provided that:

- complete display state and durable history remain intact;
- scrolling can reach all content;
- stable item identity preserves expansion and measured size;
- filtering reasoning does not reorder messages;
- presentation optimization never performs context compaction.

---

## 9. Composer requirements

### 9.1 Basic editing — P0

The composer supports:

- multiline text;
- soft wrapping;
- native selection and clipboard behavior;
- undo and redo;
- insertion at the caret;
- reliable input-method editor behavior;
- a visible disabled/unavailable state only when submission truly cannot proceed.

It grows with content to a reasonable maximum, then scrolls internally.

### 9.2 Submission controls — P0

Default actions:

| Input                            | Behavior                                                              |
| -------------------------------- | --------------------------------------------------------------------- |
| Enter while idle                 | Submit prompt                                                         |
| Enter while running              | Queue steering/guidance                                               |
| Alt+Enter while running          | Queue follow-up                                                       |
| Shift+Enter                      | Insert newline                                                        |
| Escape while running             | Request cancellation                                                  |
| Up on empty composer             | Recall latest editable queued item, otherwise latest submitted prompt |
| Clear shortcut with no selection | Clear composer                                                        |

Shortcuts may be remappable, but these behaviors must remain discoverable.

### 9.3 Draft preservation — P0

- Opening and closing a picker does not lose the draft.
- Switching sessions preserves a per-session draft or asks before destructive replacement.
- Failed submission preserves or restores the text.
- Prefilling from a skill, template, history branch, or file completion is undoable.
- Undo restores selection as well as text.

### 9.4 Large paste — P1

A very large paste must not make the interface unusable.

The application may replace it visually with a placeholder that shows character, line, and size counts, while retaining the full content for submission.

If the placeholder is removed or edited beyond recognition, its hidden content must not be submitted accidentally.

### 9.5 File insertion — P1

- Dragging one or more files inserts their paths at the caret.
- Existing draft text is preserved.
- Paths containing spaces are quoted or escaped appropriately.
- Dropping while the application is not keyboard-focused still works where the host environment allows it.
- A dropped path grants no broader filesystem permission than the user action requires.

### 9.6 Direct shell mode — P0

A leading shell prefix runs a command directly rather than sending it to the model:

- `! command`: execute and add command/output to conversation context.
- `!! command`: execute and display it without adding it to model context.

The composer must clearly change appearance in shell mode. The result is rendered like tool activity and states whether it was added to context.

Direct shell execution must not cancel or replace an active agent run unless the user explicitly requests that behavior.

---

## 10. Steering and follow-up queues

This section is normative and must be implemented precisely.

### 10.1 User-visible concepts — P0

While a run is active:

- **Steering** is priority guidance intended to affect the current work at the earliest safe intervention point.
- **Follow-up** is a new user request that waits until the current run would otherwise finish.

Both remain visible above the composer until accepted for execution.

### 10.2 Queue ordering — P0

- Steering items are FIFO among steering items.
- Follow-ups are FIFO among follow-ups.
- Steering has priority over follow-up when both are eligible.
- An item is removed from the visible queue only when atomically claimed for delivery or explicitly recalled/deleted.
- Duplicate text is allowed and each item has distinct identity.

### 10.3 Delivery semantics — P0

Preferred behavior:

1. Deliver steering at the earliest safe model-turn boundary during the active run.
2. Deliver follow-up only after the active run would otherwise settle.
3. Each follow-up begins a distinct user turn.

If the underlying agent engine cannot safely inject steering into an active run, the application may deliver steering as the first fresh prompt after settlement. In that mode it must:

- preserve steering-before-follow-up priority;
- describe the behavior honestly in help text;
- never pretend guidance affected work that had already completed.

### 10.4 Recall/edit behavior — P0

With an empty composer, the recall action:

1. recalls the newest queued follow-up;
2. otherwise recalls the newest queued steering item;
3. otherwise recalls the latest submitted prompt.

Recalling a queued item:

- atomically removes that exact item from the queue;
- places its text in the composer;
- lets the user edit, delete, or resubmit it;
- does not silently requeue it;
- restores it to its previous queue position if the recall cannot be applied because the user navigated or typed first.

### 10.5 Failure and lifecycle behavior — P0

- Failed queue delivery retains the item for retry/editing.
- Cancellation does not silently discard queued work; the application must either continue with it, retain it, or ask the user what to do.
- A runtime crash/restart retains queues associated with the same durable session.
- Duplicate lifecycle events cannot deliver the same item twice.
- A terminal runtime error that emits no normal settle event must still release the queue scheduler safely.
- Queue state is session-specific and never appears in another session.

### 10.6 Queue acceptance scenarios

1. **Steering priority:** Given one active run, two follow-ups, and two later steering items, eligible delivery order is steering 1, steering 2, follow-up 1, follow-up 2.
2. **Duplicate text:** Two queued items with identical text can be independently recalled and delivered.
3. **Recall:** Up on empty composer recalls the newest follow-up before any steering item.
4. **Race:** If the user changes session before recall completes, the item remains queued in the original session.
5. **Failure:** A delivery failure leaves the item visible at the front of its original queue.
6. **Isolation:** Settling session A never drains session B's queue.

---

## 11. Cancellation, retries, and failures

### 11.1 Cancellation — P0

- Cancellation is an intentional stop, not an error.
- The first cancel action requests graceful cancellation of provider work and tools.
- If graceful cancellation stalls, a second explicit cancel may force interruption.
- The UI immediately shows that cancellation was requested.
- Late events from the cancelled run cannot mutate a newer run.
- Any interrupted tool call receives a valid terminal result in durable history so future provider requests remain structurally valid.

### 11.2 Provider failures — P0

- Display the most useful safe provider error, not a generic “failed” message.
- The run must return to a usable state.
- The user can retry or submit another prompt in the same session.
- Empty/invalid failed assistant turns must not poison later model history.
- Diagnostics are available without exposing credentials.

### 11.3 Automatic retries — P1

- Retry transient transport, throttling, and provider-overload failures.
- Show retry attempt, delay, and concise reason.
- Do not duplicate partial assistant text or tool calls.
- If an error occurs after meaningful partial output, prefer ending clearly over replaying work that could duplicate side effects.
- A fully recovered retry produces one settled run and one completion notification.

### 11.4 Runtime disconnection — P1

- Show disconnected/failed state clearly.
- Offer restart/reconnect.
- Preserve session identity, draft, and queued prompts.
- Do not create a second owner that can concurrently write the same session.

---

## 12. Coding tools

### 12.1 Read — P0

The read tool:

- reads UTF-8 text;
- supports offset and limit;
- has bounded output;
- reports remaining content and how to continue;
- distinguishes missing file, directory, invalid encoding, and out-of-range offset;
- may support safe image attachments for vision-capable models;
- never pressures a text-only model to invent image contents.

### 12.2 Write — P0

The write tool:

- creates or replaces a complete text file;
- creates missing parent directories when appropriate;
- reports the path changed;
- prevents concurrent operations from interleaving writes to the same file.

### 12.3 Edit — P0

The edit tool performs one or more exact replacements in one file.

Requirements:

- each old text is non-empty;
- each old text matches exactly once;
- edits do not overlap;
- all edits validate before any write occurs;
- failure leaves the file unchanged;
- successful output includes a diff/patch and changed-location summary;
- dominant line endings are preserved.

### 12.4 Shell — P0

The shell tool:

- runs in the session working directory;
- captures combined output and exit status;
- supports optional timeout;
- can be cancelled;
- terminates descendants on timeout/cancellation where the platform permits;
- returns the useful tail of oversized output;
- preserves full oversized output in a temporary/log artifact when practical;
- clearly states truncation and where full output can be found.

### 12.5 Tool safety — P0

- Tool arguments are typed and validated.
- Tool output is treated as untrusted.
- The user can inspect exact operations.
- The application never fabricates success.
- Tool completion is durably recorded before the session is considered settled.

---

## 13. Commands and completion

### 13.1 Command behavior — P0

Only registered commands execute locally. Unknown slash-prefixed text is sent as an ordinary prompt. This protects absolute paths and user text from being silently discarded.

Minimum commands:

| Command               | Behavior                                         |
| --------------------- | ------------------------------------------------ |
| `/new`                | Start a fresh session in the current project     |
| `/resume`             | Search and resume a previous session             |
| `/name`               | Rename the session                               |
| `/session`            | Show session/model/context/tool/resource details |
| `/model`              | Choose provider and model                        |
| `/compact`            | Summarize and reduce active model context        |
| `/tree`               | Browse history and branch from an earlier entry  |
| `/export`             | Export the session                               |
| `/skills`             | Browse and insert a skill invocation             |
| `/prompts`            | Browse and insert a prompt template              |
| `/tools`              | Browse active tool descriptions                  |
| `/theme`              | Choose theme                                     |
| `/hotkeys`            | Show shortcuts                                   |
| `/login`              | Connect a provider                               |
| `/logout`             | Remove saved credentials for a provider          |
| `/reload`             | Reload resources and project context             |
| `/quit` or equivalent | Exit cleanly                                     |

### 13.2 Command output — P1

- Short confirmations use transient notices.
- Long reference output uses a dismissible, searchable, or scrollable view.
- Display-only command output is not sent to the model or persisted as conversation content unless explicitly designed to be.
- Busy commands explain why they cannot run and preserve the draft.
- No command silently does nothing.

### 13.3 Completion sources — P1

Completion supports:

- registered commands;
- custom prompt templates;
- `/skill:<name>`;
- command argument values such as model, provider, theme, and session;
- `@` file references;
- shell paths after `!` and `!!`.

### 13.4 Completion behavior — P1

- Results are categorized rather than mixed indiscriminately.
- Commands appear before custom prompts for a bare `/` query.
- Skills appear after the `/skill:` namespace is entered.
- The best synchronous match is initially selected.
- User arrow navigation remains selected until the query changes.
- Asynchronous file-result refreshes preserve selection identity when possible.
- Enter applies a highlighted completion when applying would change the draft; it does not accidentally submit.
- Tab inserts/accepts completion.
- The selected row remains visible during keyboard navigation.
- Completion replacement occurs at the caret, not always at the end.
- File completion replaces the active token and preserves surrounding text.
- Suggestion UI has stable enough dimensions that typing does not make the layout jump.

### 13.5 File completion — P1

- Search from the project directory.
- Include dot-prefixed files when explicitly relevant.
- Skip known metadata/generated directories.
- Bound traversal and results.
- Cache or debounce expensive scans so large repositories do not drop keystrokes.
- Allow deliberate parent-relative completion without broadly scanning unrelated filesystem areas.

---

## 14. Sessions and history

### 14.1 Persistence — P0

Sessions are durable and recoverable after normal exit, crash, and restart.

Requirements:

- Persist complete messages and tool results at a clear durable boundary.
- Do not rely on UI consumption to persist cleanup events.
- Avoid creating empty sessions merely because the app opened.
- First durable content creates/indexes the session.
- Interrupted tool calls are repaired into provider-valid history.
- Repeating recovery is idempotent.
- Corrupt records fail safely and preserve recoverable originals.

The physical storage format is implementation-defined.

### 14.2 Session picker — P0

The session picker shows:

- name or useful fallback title;
- last activity time;
- working directory/project;
- model/provider when known;
- active/running state when relevant.

It supports search, keyboard navigation, pointer selection, and cancellation.

### 14.3 New session — P0

- Starting a new session never changes the durable transcript underneath an active run.
- If another session is working, it may continue in the background.
- The new session opens immediately with an empty transcript and preserved project context.
- New sessions gain a fallback title from the first prompt.
- Optional automatic naming is non-blocking and non-fatal.

### 14.4 Concurrent sessions — P1

- Multiple sessions may work concurrently.
- Switching views does not stop background work.
- Background events update that session's activity indicator but never enter the visible transcript of another session.
- Every action and event is bound to the session where it originated.
- Rapid switching, duplicate clicks, and delayed loads cannot create duplicate owners or mixed transcripts.
- Opening a session is an atomic visual transition: clear old content, show loading, then reveal authoritative target content.

### 14.5 Project grouping — P1

Group sessions by working directory or worktree. Let users remember projects even before they contain session history.

Provide:

- new session in current project;
- choose another project directory;
- collapse/expand project groups;
- forget an app-owned recent reference without claiming to delete runtime-owned data.

### 14.6 Branching — P1

A session may branch from any earlier valid entry.

The tree/history view must:

- scale to long sessions without recursive traversal limits;
- show user, assistant, tool, model-change, and summary entries intelligibly;
- optionally hide tool details;
- let the user continue from the selected point;
- preserve abandoned branches;
- offer a generated summary of the branch being left;
- accept custom summary focus instructions;
- fall back to a deterministic summary if model summarization fails.

Selecting an earlier user message should prefill it for editing when replaying it directly would duplicate the turn.

### 14.7 Export — P1

Support at least one human-readable self-contained export and one machine-readable complete export.

A rich export should include:

- transcript;
- tool calls/results;
- reasoning when available;
- session tree/branches;
- timestamps;
- model/provider metadata;
- compactions;
- usage/cache/cost analytics when available;
- controls to hide tools, reasoning, or session events;
- disclosure of any included system/project instructions before sharing.

Export success displays the destination without adding that notice to model context.

---

## 15. Models, providers, and authentication

### 15.1 Provider connection — P0

- Support at least one real model provider and one deterministic fake/local mode.
- Authentication may use API key, OAuth, subscription flow, or local endpoint.
- Missing authentication produces an actionable login flow rather than a startup crash.
- Credentials are never displayed in the transcript, logs, exports, or model-visible context.

### 15.2 Model picker — P0

The model picker shows:

- provider;
- model name/identifier;
- reasoning support;
- input modalities when known;
- context limit when known.

Selecting a model from another provider switches provider and model atomically. Never combine a model with an incompatible provider.

### 15.3 Favorite/scoped models — P1

- Users can mark favorite models.
- A quick-cycle action rotates among valid favorites.
- With fewer than two valid favorites, fall back to a useful full-model behavior.
- Favorite changes do not change the active model unless explicitly selected.
- Stale favorites do not prevent startup or model switching.

### 15.4 Thinking effort — P1

- Expose only effort levels supported by the selected model.
- Allow cycling effort quickly.
- Remember preferred effort per model.
- Validate remembered values after catalog/provider updates.
- A change during a run applies at the next safe model request and is described honestly.

### 15.5 Provider/model restoration — P0

On resume and history navigation:

- restore provider and model as one validated identity;
- preserve the current active choice when historical navigation should not change runtime configuration;
- handle removed/unavailable models with a clear fallback choice;
- never fail with an internal stack trace because old preferences reference removed catalog entries.

### 15.6 Usage and cost — P1

When data is available, show:

- input tokens;
- output tokens;
- reasoning tokens;
- cache reads/writes;
- latest-request cache hit rate;
- cumulative session cache hit rate;
- estimated cost;
- active context used/limit.

Rules:

- Mark estimates as estimates.
- Show unavailable values as unavailable, not zero.
- Distinguish cumulative usage from active context.
- After compaction, cumulative usage continues while active context can decrease.
- Do not imply visible transcript detail equals lifetime totals when older request detail is unavailable.

---

## 16. Context, instructions, skills, and prompts

### 16.1 Project trust — P0

Before loading project-controlled instructions, resources, or executable extensions, establish an explicit trust decision.

- Default interactive behavior asks.
- Headless/non-interactive behavior safely declines unless explicitly approved.
- Declining project inputs still permits ordinary operation with user-level configuration.
- Trust controls loading; it is not presented as an execution sandbox.
- A project cannot redefine the global trust policy.

### 16.2 Project instructions — P0

Discover standing instructions such as `AGENTS.md` from user and project scopes with documented precedence.

The user can inspect which files were loaded. Unreadable or conflicting instruction files produce clear diagnostics.

### 16.3 System prompt controls — P1

Allow user-level and trusted project-level replacement or appended system instructions.

- Precedence is deterministic and inspectable.
- Reload applies changes to future requests without rewriting session history.
- The user can inspect the active system prompt.
- Export warns before sharing sensitive prompt content.

### 16.4 Skills — P1

A skill is reusable task knowledge with:

- unique name;
- description;
- complete instructions;
- optional supporting files;
- origin/scope;
- optional “user invocation only” flag.

Behavior:

- The model receives a bounded index of eligible skill names/descriptions.
- Full skill instructions enter context only when invoked or read.
- `/skill:<name> optional request` explicitly expands and runs a skill.
- User-only skills remain available to the picker but are absent from model-visible discovery.
- A searchable skill picker inserts an invocation without immediately submitting.
- The user can inspect the full skill without adding it to model context.

### 16.5 Prompt templates — P1

Prompt templates are reusable prompts invoked by name.

They support:

- description;
- positional arguments;
- all-arguments expansion;
- defaults;
- simple slices;
- quoted arguments;
- appending arguments when no placeholder exists.

A searchable picker inserts a template invocation. Editing a template reloads resources after save.

### 16.6 Resource precedence and conflicts — P1

- User and project scopes have documented deterministic precedence.
- Higher precedence may override lower precedence by name.
- Conflicts produce visible diagnostics with both origins.
- Invalid resources are skipped or rejected explicitly; never silently interpreted as another resource type.
- Resource catalogs are bounded for display and context.
- Show approximate skill-index context cost when possible.

### 16.7 Reload — P1

Reloading resources:

- refreshes instructions, skills, prompts, tools, and permitted extensions;
- affects future requests;
- preserves the active session and draft;
- reports failures without corrupting the previous working configuration;
- does not add reload diagnostics to model context unless explicitly requested.

---

## 17. Context management and compaction

### 17.1 Context status — P0

Show active context usage against model limit when known. Make clear that it is different from cumulative token usage.

### 17.2 Automatic compaction — P1

- Trigger before the provider's hard context limit with a configurable reserve/threshold.
- Summarize older active context while preserving recent useful turns.
- Continue the interrupted run after successful overflow compaction.
- Show compaction and retry status.
- If compaction fails, expose the original overflow/failure clearly.
- Never report the run as settled between compaction and its automatic continuation.

### 17.3 Manual compaction — P1

- `/compact` accepts optional focus instructions.
- Show active working state and allow cancellation.
- Prevent overlapping compactions.
- Prevent compaction from racing an active/queued run unless the engine explicitly supports it.
- Notify on completion while the application is unfocused.

### 17.4 History preservation — P1

Compaction changes model context, not durable history.

- Original entries remain available in session history/export.
- The visible transcript should remain readable rather than suddenly deleting the conversation the user was viewing.
- Compaction summaries are collapsed by default and expandable/copyable.
- Merging post-compaction state must not duplicate retained messages.

---

## 18. Side information and status

### 18.1 Session/context panel — P1

When space permits, show:

- session name;
- project/worktree;
- provider and model;
- thinking effort;
- turn and tool counts;
- active context usage;
- cumulative token/cost/cache metrics;
- compaction state;
- loaded tools;
- skills and prompt templates grouped by origin;
- loaded instruction/context files;
- extensions;
- runtime/application version.

Dense lists should collapse, scroll, or truncate with explicit “N more” indicators. Do not fabricate missing statistics.

### 18.2 Activity indicator — P0

Show one clear run-wide activity indicator near the composer. Avoid multiple competing global spinners.

Tool rows may show their own state marker, but the global indicator answers “is the agent still working?”

### 18.3 Window/tab title and notifications — P1

- Show session identity in the host window/tab title where supported.
- Animate or mark the title while working.
- Sanitize and bound title text.
- Notify only when a run fully settles and the application is unfocused.
- Repeated identical answers still produce distinct completion notifications.
- Do not notify separately for intermediate retry/compaction boundaries.
- Notification behavior is configurable and degrades safely on unsupported hosts.

---

## 19. Pickers, modals, and accessibility

### 19.1 Shared behavior — P0

All pickers and modal views provide:

- clear title and purpose;
- initial focus;
- visible selected item;
- Up/Down navigation;
- Enter/select;
- Escape/cancel;
- pointer selection where supported;
- search where lists can be long;
- scrolling;
- focus restoration on close;
- no draft loss on cancel.

### 19.2 Accessibility — P0

- Every icon-only action has an accessible name and tooltip/help text.
- Focus order is logical.
- Focus is trapped inside modal interactions.
- Color is not the only status signal.
- Text and controls meet reasonable contrast requirements.
- Distinct options have distinct stable identities, including provider/model pairs with punctuation.
- Loading and error states are announced through the host platform's accessibility mechanism where available.
- Keyboard use can complete every P0 flow.

---

## 20. Background work and delegation

### 20.1 Background sessions — P2

An active agent may start an independent child session for delegated work.

Requirements:

- Child has its own durable session and run lifecycle.
- Default working directory is explicit; another existing directory/worktree may be selected.
- A supplied empty/whitespace directory is rejected rather than silently replaced.
- Child appears in normal session navigation and activity status.
- Current viewed transcript does not change automatically.
- Child cancellation/failure cleans up all pending startup work.
- Cap recursively agent-created active sessions.
- Explain that separate sessions in one directory do not isolate filesystem edits; recommend worktrees for parallel writes.

---

## 21. Extensions — P2

If extensions are supported:

- Extension trust is explicit.
- Extensions may add tools, commands, renderers, dialogs, and bounded UI regions.
- One broken extension cannot crash the session.
- Failures are diagnosed and the extension may be quarantined.
- Tool-authorization failures default to safe denial.
- Reload waits for old-generation shutdown before activating the new generation.
- Stale background tasks cannot mutate the new extension generation.
- Untrusted executable extensions are never described as sandboxed unless they actually are.

Extensions are optional; do not weaken core security merely to include them.

---

## 22. Security, privacy, and data integrity

These requirements are product-level and apply regardless of stack.

### 22.1 Credentials — P0

- Store credentials only in an appropriate private credential store or protected user configuration.
- Never send credentials to UI state that does not need them.
- Never write credentials, authorization headers, or full environment variables to logs or exports.
- Logout removes only the intended saved credential.

### 22.2 Untrusted content — P0

Treat as untrusted:

- model Markdown;
- links;
- tool output;
- patches;
- filenames;
- resource metadata/content;
- extension output;
- imported sessions.

Untrusted content must not become executable UI markup or privileged commands.

### 22.3 External links — P0

- Permit only explicit safe URL schemes.
- Ask the operating environment to open links externally.
- Never allow a model-generated link to navigate the privileged application surface.

### 22.4 Filesystem scope — P0

- All tool actions are anchored to the session working directory unless the user explicitly provides another path and policy permits it.
- File completion is bounded and avoids sensitive/unrelated traversal.
- Project resources load only after trust approval.
- User-selected directories are explicit and inspectable.

### 22.5 Command execution — P0

- Never interpolate untrusted settings into a hidden shell command when direct argument execution is available.
- Show the user exact model-requested shell commands before or while they execute.
- Distinguish model tool commands from user direct-shell commands.
- Enforce timeout and cancellation where possible.

### 22.6 Session integrity — P0

- Never allow two independent owners to append conflicting activity to one session.
- Persist tool calls and corresponding results in provider-valid order.
- Preserve original history during migration, repair, compaction, and branching.
- Migrations are non-destructive, idempotent, collision-safe, and recoverable.

### 22.7 Diagnostics — P0

- Provide bounded diagnostics useful for troubleshooting.
- Remove control characters from renderer-visible process/version text.
- Avoid stack traces in normal user-facing errors.
- Keep sensitive diagnostics local and ephemeral unless the user explicitly exports them.

---

## 23. Performance and reliability requirements

### 23.1 Responsiveness

- Composer input remains responsive during streaming and tools.
- Plain prompt submission appears immediate.
- Streaming does not trigger full transcript reconstruction per token.
- Reasoning visibility toggles without rebuilding unrelated transcript content.
- File completion does not rescan a large repository on every keystroke.
- Session/tree views handle long histories without recursion limits.
- Model quick-cycle does not reload the entire application.

### 23.2 Race safety

The product must handle:

- rapid session switching;
- late events from old sessions/runs;
- simultaneous startup requests;
- cancellation during tool execution;
- cancellation during child-session startup;
- queued-message recall racing with typing/navigation;
- compaction and retry boundaries;
- provider/model change during delayed UI work;
- settings updates from multiple application instances.

### 23.3 Offline/test mode — P0

Provide a deterministic mode that requires no network or paid provider and can simulate:

- text streaming;
- reasoning streaming;
- tool progress/success/failure;
- cancellation;
- retries;
- provider errors;
- compaction;
- long output;
- session switching;
- stale/late events.

This mode must exercise the same user-visible state transitions as a real provider.

---

## 24. Acceptance test catalog

A delivered application should include automated or reproducible acceptance coverage for these scenarios.

### A. First run

1. Launch with no credentials.
2. Select a project.
3. Receive an actionable provider login/model setup flow.
4. Connect or choose deterministic mode.
5. Submit “summarize this project.”
6. Observe immediate user message, streaming activity, at least one file read, and final answer.

### B. Tool transparency

1. Ask the agent to edit a known file and run tests.
2. Observe running, success/failure, paths, exact command, output preview, and patch.
3. Expand to see complete details.
4. Resume the session and confirm details persist.

### C. Scroll independence

1. Start a long streaming response.
2. Scroll upward.
3. Confirm the application does not yank the reader down.
4. Confirm new-output affordance appears.
5. Submit a new prompt and confirm the view returns to the sent message/tail.

### D. Steering/follow-up

1. Start a slow tool-using run.
2. Queue two follow-ups and two steering items.
3. Confirm all appear above the composer.
4. Recall and edit the newest follow-up.
5. Resubmit it.
6. Confirm steering is delivered before follow-ups and no item duplicates/disappears.

### E. Cancellation

1. Start a cancellable long command.
2. Cancel it.
3. Confirm cancellation is status, not error.
4. Confirm the session becomes usable.
5. Resume/restart and confirm provider-valid tool history.

### F. Session isolation

1. Start work in session A.
2. Open session B while A is working.
3. Confirm B never displays A's events.
4. Return to A and confirm its completed work.
5. Rapidly switch several times and confirm no duplicate runtime/session owner appears.

### G. Persistence

1. Complete a tool-using turn.
2. Exit and restart.
3. Resume the session.
4. Confirm transcript, tool details, model/provider, session name, project, usage data, and branch are restored.

### H. Branch and compact

1. Build a multi-turn session.
2. Branch from an earlier user turn and submit edited text.
3. Confirm the original branch remains available.
4. Compact the active branch.
5. Confirm active context shrinks while durable/visible history remains inspectable.

### I. Commands and completion

1. Open bare slash completion.
2. Confirm categorized commands and prompts.
3. Enter `/skill:` and confirm skill-only results.
4. Type an absolute path beginning with `/` that is not a command and confirm it is sent normally.
5. Complete an `@` path in the middle of a multiline prompt and confirm caret placement.

### J. Security

1. Render model text containing raw HTML/script-like content and unsafe links.
2. Confirm it remains inert.
3. Decline project trust and confirm project resources are not loaded.
4. Trigger malformed/oversized resources and confirm bounded diagnostics.
5. Export logs/session and confirm credentials/environment secrets are absent.

### K. Accessibility

1. Complete first-run, prompt, cancel, model select, session resume, and export using keyboard only.
2. Confirm modal focus is trapped and restored.
3. Confirm running/success/failure are distinguishable without color alone.
4. Confirm option identities remain unique for punctuation-heavy provider/model names.

### L. Failure recovery

1. Simulate transient error and successful retry.
2. Simulate terminal error with no normal settle event.
3. Confirm UI returns to usable state and queue handling continues once.
4. Simulate runtime crash and restart without losing target session, draft, or queue.

---

## 25. Definition of Done

### 25.1 Minimum one-shot delivery

A one-shot implementation is acceptable only if all of the following P0 capabilities work end to end:

- Select/open a project directory.
- Connect at least one real provider **or** document a fully working provider configuration path.
- Deterministic offline/test mode.
- Submit and stream prompts.
- Render assistant Markdown safely.
- Execute and display read/write/edit/shell tools.
- Show tool states, arguments, bounded output, and edit patches.
- Cancel active work.
- Queue, display, recall, and deliver steering/follow-ups with session isolation.
- Preserve composer drafts and undo/redo.
- Run direct `!`/`!!` shell commands.
- Persist and resume sessions.
- Select provider/model and show active identity.
- Provide the minimum command set or equivalent discoverable controls.
- Enforce project trust before loading project-controlled context.
- Keep credentials and untrusted content out of privileged UI/execution paths.
- Include automated tests for the critical acceptance scenarios.
- Include concise setup/run/test documentation.

### 25.2 Strong Tau-like delivery

A strong implementation also includes the P1 capabilities:

- one-answer-per-turn activity presentation;
- grouped tool activity;
- responsive side information;
- long-transcript optimization;
- atomic concurrent session navigation;
- project/worktree grouping;
- session tree branching;
- manual and automatic compaction with history preservation;
- searchable commands/models/sessions/skills/prompts/tools;
- categorized slash and file completion;
- skills, prompt templates, and project instructions;
- favorite models and thinking effort;
- usage/cache/cost reporting;
- rich exports;
- themes, notifications, and accessibility completion.

### 25.3 Quality bar

The product is not done if:

- stale events can appear in another session;
- cancellation corrupts session history;
- a queued prompt can disappear or execute twice;
- unsupported actions silently no-op;
- the UI freezes during ordinary streaming;
- model output can inject privileged markup or navigation;
- credentials appear in logs/UI/export;
- tests require paid provider access;
- only the happy path is implemented.

---

## 26. Suggested implementation sequence

This is a dependency order, not a stack prescription.

1. Define user-visible session, run, message, tool, and lifecycle behavior.
2. Implement deterministic fake/offline agent events.
3. Build transcript, composer, safe rendering, and scroll rules.
4. Add real provider/model integration.
5. Add coding tools and durable tool-result history.
6. Add cancellation, retries, and terminal failure recovery.
7. Add main prompt plus steering/follow-up queues.
8. Add durable sessions and resume.
9. Add explicit session identity and concurrent/background isolation.
10. Add commands, pickers, and completion.
11. Add project trust, instructions, skills, and prompt templates.
12. Add branching, compaction, usage, and export.
13. Add responsive polish, themes, notifications, accessibility, and advanced delegation.

At every step, preserve deterministic testability and session integrity.

---

## 27. Final product principles

1. **The transcript is the product.** Keep it readable, truthful, and durable.
2. **Events are ordered facts.** Presentation may group them but must not falsify them.
3. **Session identity is explicit.** Never route work through whichever session happens to be selected later.
4. **Settled means truly idle.** Retries, compaction, tools, and queued continuations must be finished.
5. **User work is recoverable.** Drafts, queues, history, and migrations favor preservation.
6. **Tool use is transparent.** Exact operations and outcomes remain inspectable.
7. **Unknown is not zero.** Missing capabilities, costs, or usage are shown honestly.
8. **Cancellation is normal.** It is safe, visible, and does not poison history.
9. **Security is a product behavior.** Trust prompts, inert content, credential privacy, and bounded access are visible requirements.
10. **Performance protects agency.** The user can keep reading, typing, navigating, and steering while the agent works.
