# UI and Architecture Decisions for a Desktop Coding-Agent App

This document distills the important product, interaction, architecture, security, and testing decisions visible in this repository's Git history and pull requests. It is intended as a checklist and design guide for anyone building a similar Electron application around an agent runtime.

> **Scope and status:** This describes the durable direction of the project, including lessons from merged work and clearly marked unmerged work. The checked-out product is still named **Tau GUI**. PR #21 proposes renaming it to **AO** and changing storage ownership. Closed PRs #14 and #16 and the unmerged compaction-summary branch are historical or superseded work, not necessarily behavior available on `main`.

## 1. Start with the product model

This is a **desktop agent client**, not a terminal emulator and not a web chat wrapped in Electron.

The core product choices are:

- Preserve a terminal-inspired, transcript-first workflow.
- Keep the agent runtime behind a desktop application boundary rather than exposing it to the UI.
- Let multiple sessions continue working concurrently.
- Make model reasoning and tool execution legible without presenting every intermediate model message as a final answer.
- Prefer keyboard interaction, but retain normal mouse selection, links, scrolling, clipboard behavior, and accessible controls.
- Be honest about unsupported runtime capabilities. Disable them with an explanation rather than faking them or silently doing nothing.

A useful high-level model is:

```text
project/worktree
  └─ session
      ├─ durable transcript owned by the agent runtime
      ├─ one live runtime owner while active in the desktop app
      ├─ app-owned editable prompt queue
      └─ normalized state shown by the renderer
```

## 2. UI decisions

### 2.1 Keep the transcript as the primary surface

The interface deliberately avoids a conventional permanent app header and shortcut footer. The main visual hierarchy is:

```text
left project/session rail | transcript + bottom composer | optional context sidebar
```

Important details:

- Messages use vertical role bars rather than chat bubbles.
- The transcript remains visually dominant; status and controls are compact or disclosed on demand.
- The composer stays at the bottom.
- The session/context sidebar defaults to the right and can move left or be hidden.
- On narrow windows, secondary navigation becomes a drawer or is hidden instead of crushing the transcript.
- On macOS, `hiddenInset` title-bar styling and a transparent drag strip blend the native title bar into the app without adding visible chrome.
- The left sessions rail uses translucency and blur to reveal the desktop subtly, but text contrast and hit targets must remain usable.

**Lesson:** copy the source product's information hierarchy, not merely its colors. Several small commits adjusted sidebar order, width, translucency, labels, spacing, icon-only actions, and title-bar treatment because visual parity is an accumulation of details.

### 2.2 Render a turn as one answer plus an activity rail

Reasoning models may emit narration, reasoning, tool calls, and several assistant-shaped messages in one turn. Rendering each assistant message as an answer makes the transcript look fragmented and can cause users to mistake pre-tool narration for the final response.

The chosen presentation is:

- Group events explicitly by turn.
- Render only the assistant message that **closes the turn** as the answer.
- Put reasoning and pre-tool narration on the same compact activity rail as tool calls.
- Keep the rail visible while work is active.
- Collapse settled activity into a quiet summary such as `Worked for … · N tool calls` immediately before the answer.
- Render reasoning-only work as a collapsible `Thought for …` rail.
- Preserve the exact underlying content; changing presentation must not discard durable messages.
- Allow reasoning to be hidden (`Ctrl+T`) without hiding the final answer.

This also improves secondary behavior: completion notifications and copy controls can target the actual final answer rather than an intermediate narration message.

### 2.3 Treat tool execution as first-class semantic output

Tool activity is not generic text. It needs lifecycle and state:

- Running: orange.
- Success: green.
- Failure: red.
- Cluster related tool calls beneath the user turn.
- Show concise previews in the collapsed state.
- Keep exact commands, arguments, output, and patches available on expansion.
- Support both per-block expansion and a global toggle (`Ctrl+O`).
- Preserve readable tool-history font sizing; do not shrink old output merely because it is secondary.
- Render patches/diffs semantically while treating their contents as untrusted text.

Streaming updates should enrich the existing tool block rather than append duplicates. Authoritative end events should replace the matching in-progress message **in place**, preserving the order of tools and status blocks around it.

### 2.4 Composer behavior is part of the agent protocol

The composer is a controlled editor with product-specific semantics, not just a textarea.

#### Basic interaction

- `Enter`: submit normally; while a run is active, enqueue priority guidance.
- `Alt+Enter`: enqueue a follow-up.
- `Shift+Enter`: insert a newline.
- `Esc`: abort an active run.
- Empty-composer `Up`: recall editable queued work first, then previous submitted text.
- `Ctrl+C` with no text selection: clear the composer.
- `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, and `Ctrl+Y`: local undo/redo.
- Leading `!command`: run shell and include output in agent context.
- Leading `!!command`: run shell but exclude output from context.
- Dragged paths and `@` completion insert quoted paths at the caret.

#### Editor quality

- Grow from measured `scrollHeight`, not newline count, so soft-wrapped lines expand correctly.
- Cap growth at about ten lines, then scroll internally.
- Avoid a visually permanent focus ring when the composer normally owns focus, while preserving accessible focus treatment elsewhere.
- Restore focus after modal dismissal and session opening.
- Keep drafts in shared app state so modal selections and session changes do not accidentally destroy them.
- Undo/redo must include programmatic edits such as clearing, modal prefills, queued-message recall, and prompt-history replacement.
- Coalesce contiguous native insertions/deletions into useful undo steps and keep a bounded history.
- Preserve and restore selection positions with history entries.
- Do not steal focus after an intentional transcript text selection or interaction with a button, link, modal, or input.

### 2.5 The desired guidance/follow-up queue behavior

This is one of the most important interaction contracts in the project.

While the current agent turn is running:

1. `Enter` creates a **steering/guidance** item.
2. `Alt+Enter` creates a **follow-up** item.
3. Both appear as editable queued prompts above the composer.
4. They remain app-owned and editable until dispatch.
5. The active turn must reach a true terminal boundary before anything drains.
6. Guidance drains FIFO before follow-ups drain FIFO.
7. Exactly one queued item is claimed and sent as a **fresh prompt** at each terminal boundary; its resulting run must settle before the next item drains.

Why fresh prompts instead of native mid-turn steering?

- A queued item can be withdrawn or edited reliably.
- The app can present one predictable queue across runtime implementations.
- Native runtime queue updates are observational and may not offer the required editable semantics.

Recall behavior is intentionally different from dispatch order:

- Empty-composer `Up` atomically pops the **newest follow-up**, otherwise the newest guidance item.
- The item disappears from the queue and enters the composer.
- It returns only after explicit resubmission.
- Stable item IDs, not text equality, distinguish duplicate prompts.
- If navigation or typing races with the async recall, the claimed item is restored rather than lost.

Reliability rules:

- The queue lives in Electron's main process and is keyed by immutable session identity.
- A claimed item is removed before async dispatch so it cannot also be recalled.
- Failed dispatch reinstates it at the front of its original queue.
- Queue state survives a process crash/restart when the session identity is retained.
- Drain after `agent_settled`, not `agent_end`.
- Also drain after a normalized post-acceptance runtime error when no settle event will follow.
- Gate drains by per-session run lifecycle so duplicate or stale settle events cannot send two prompts.
- Ignore native `queue_update` as authority for GUI-created prompts.

### 2.6 Scrolling must distinguish reading from sending

A streaming transcript must not continually yank a reader to the bottom.

The adopted rules are:

- Incoming runtime output follows the tail only if the reader was already near the tail.
- If the reader scrolls up, preserve their position and show a compact “new output” affordance.
- Sending a prompt, guidance item, follow-up, or shell command is an explicit request to see the result, so jump to the tail even if the reader was scrolled up.
- Keep that programmatic pin active while virtualized blocks receive delayed height measurements.
- Compare against the browser-clamped maximum `scrollTop`; an unreachable estimated target can otherwise be misclassified as manual user scrolling.
- Ensure the newly sent user message is fully visible above the composer before assistant output arrives.
- Once a prompt scrolls above the viewport, pin an animated two-line preview over its response and replace it at the next prompt boundary; scrolling upward restores and animates the full prompt for the earlier response. Keep the pinned surface slightly inset from the window edge and visually consistent with the translucent gray user-message surface.
- Keep the active turn's prompt mounted across virtual-window boundaries so the pinned context does not disappear in long responses.

### 2.7 Virtualize without changing history semantics

Long coding sessions require transcript virtualization, but virtualization is presentation only:

- Never trim runtime context or durable history merely to reduce DOM size.
- Key height measurements by stable block/group IDs, not array position.
- Preserve measurements through filtering, insertions, and rail expansion.
- Render explicit “older/newer output” boundaries around the mounted window.
- Use a cheap tail fingerprint to trigger scroll anchoring without diffing the whole transcript.
- Test delayed measurements, realistic scroll geometry, and long-running streams.

An unmerged compaction-summary branch adds an additional desirable rule: user-triggered compaction should shrink model context without making the reader's visible history disappear. It retains the pre-compaction transcript, merges the runtime's kept tail without duplication, and renders compaction/branch summaries as collapsed expandable blocks. Treat this as a considered design direction, not current `main` behavior.

### 2.8 Make loading and navigation transitions atomic

When the user selects another session:

- Highlight the target and immediately clear the previous transcript/run state.
- Show a centered conversation skeleton with an accessible loading status.
- Gate transcript-scoped status and stream events during navigation.
- Hydrate the target from an authoritative snapshot and message read.
- Open the event gate only after hydration finishes.
- Discard stale reads when a newer navigation generation starts.
- On activation failure, reconcile with the session the runtime actually owns rather than leaving a cleared view attached to unrelated background output.

This avoids showing the old session's “running” state, tool calls, or messages under the newly selected session.

### 2.9 Organize sessions around working directories/worktrees

For coding agents, a project directory is a first-class navigation concept:

- Group recent sessions under collapsible working-directory entries.
- Persist user-selected working directories even when no session history exists yet.
- Use Electron's native folder chooser; never expose general filesystem access to the renderer.
- `/new` and `Ctrl+N` create a clean session in the active session's current directory/worktree.
- The rail plus button and `Shift+Ctrl/Cmd+N` choose a different directory.
- Refocus the composer after opening.
- Show a new session immediately, even before it has a generated name.
- Use the first user message as a fallback label and avoid surfacing truly empty stale sessions.
- Reorder recent sessions only on meaningful activity, not passive selection or hydration.
- Keep a forget action distinct from deleting runtime-owned session data.

### 2.10 Background agent delegation should remain visible and isolated

The embedded Pi runtime exposes an app-owned `spawn_session` tool so an agent can start independent work:

- The child runs in the current directory or another existing directory/worktree.
- The main process canonicalizes and validates the target.
- Spawning does not change the transcript currently being viewed.
- The child appears in the normal sessions rail and emits the same activity/settings events as user-created sessions.
- The initial prompt uses the same app-owned scheduler.
- Cap retained tool-created runtime sessions (currently fifteen) to bound recursive delegation.
- A supplied whitespace-only directory is an error; never silently fall back to the parent checkout.
- Propagate cancellation through transition waits, startup, and optional naming.
- If cancellation or failure occurs after a child is created, stop and unregister it so no write-capable orphan remains.

For parallel coding work, encourage an existing Git worktree as the target. A separate session alone does not isolate filesystem edits.

### 2.11 Completion and commands need explicit categories

Slash completion merges several concepts that must remain visibly distinct:

- GUI commands, handled locally.
- Runtime-reported commands.
- Custom prompt templates expanded by the runtime.
- Skills invoked with `/skill:<name>`.

The chosen behavior:

- Typing `/` lists built-in commands first under `Commands`.
- Custom prompts appear in a separate section.
- Individual skills appear only after `/skill:` is typed.
- Accepting the `/skill:` prefix does not add a trailing space, so skill completion stays open.
- Slash results may be long and scrollable; do not apply the small result cap used for file completion.
- Keyboard movement keeps the selected row in view.
- A synchronous slash query should select the newly top-ranked result when the query changes.
- An asynchronous/debounced `@` path query should preserve selection by identity while results refresh.
- Arrow navigation should remain stable until the query itself changes.
- `Tab` completes text; `Enter` can execute the selected slash command.
- Unknown slash text is an ordinary prompt rather than a silent no-op.
- GUI-owned commands must be parsed before prompting because a runtime prompt endpoint does not necessarily execute TUI commands.
- Every registered but unsupported command must carry an explicit unavailable reason.

Resource-backed directives are highlighted while typing so users know they will expand inside the runtime rather than execute as local GUI commands. PR #5 initially used colored pills behind a mirrored textarea. Commit `13bdd1c` deliberately simplified this to **accent-colored directive text** with no rounded background or padding. The mirrored backdrop remains useful because a native textarea cannot style text ranges while preserving caret, IME, selection, and clipboard behavior.

### 2.12 Use one accessible picker/modal system

Commands, models, themes, thinking levels, sessions, prompts, skills, and tree navigation should share a framework:

- Focus trap.
- Escape cancellation.
- Keyboard and mouse parity.
- Fuzzy filtering.
- Correct focus restoration.
- Stable selection across only those async refreshes where stability is desired.
- Accessible listbox/option relationships.

IDs require special care. Provider/model pairs must use a collision-safe tuple key; string concatenation can collide. DOM IDs must also use injective encoding—replacing punctuation with `_` can turn distinct model identities into duplicate option IDs and break `aria-activedescendant`.

### 2.13 Models, thinking, and app-owned preferences

- Show complete runtime-reported model metadata in a picker.
- `Ctrl+P` cycles models; `Shift+Tab` cycles thinking level.
- Scope/favorite models in app settings because neither runtime exposes a reliable scoped-model management API.
- Key favorites by canonical provider/model tuples and persist them in main-process settings.
- Toggling a favorite must not change the active model.
- Once at least two valid favorites are available, `Ctrl+P` cycles only those via ordinary `set_model` calls.
- With fewer than two valid favorites, fall back to the runtime's own cycle behavior so stale settings cannot trap the user.
- Update the full per-runtime favorite map atomically and validate/bound it at IPC and storage boundaries.

### 2.14 Sidebars should show useful, honest context

The right sidebar evolved away from speculative or noisy indicators toward actionable facts:

- Session title.
- Turn and tool-call counts without redundant idle/running prose.
- Usage/cache values only when reported or honestly derived; estimates use `~`.
- Existing context instruction files actually loaded for the session.
- Collapsible skill/prompt catalogs.
- Approximate aggregate skill footprint, using a deterministic one-token-per-four-characters estimate.

Only bounded metadata should enter renderer state. Resource bodies, credentials, and extension implementations remain in main/runtime code.

PR #14 explored a full in-app session-usage dashboard with cumulative-vs-visible metrics, bounded charts, pagination, and compaction-aware labels. It was closed as superseded by the Pi SDK migration and is not on `main`, but its general analytics lessons remain useful:

- Never imply visible transcript totals equal lifetime totals after compaction.
- Label cumulative runtime measurements separately from visible request detail.
- Bound chart samples, labels, and request rows for long sessions.
- Preserve useful cumulative cards when detailed historical requests are unavailable.

### 2.15 Themes and small affordances matter

- Support Tau dark, Tau light, high contrast, and true black themes through semantic CSS tokens.
- In true black, subtly distinguish user turns so role boundaries do not disappear.
- Reuse semantic role tokens for command/resource accents instead of hard-coded colors.
- Use compact icon actions for new session and abort, with tooltips and accessible labels.
- Show message copy controls on hover without changing layout or overlapping metadata.
- Allow native text selection and clipboard behavior.
- Open only safe external links through the main process.
- Notify on a completed turn only while the window is unfocused and notifications are enabled.
- Key notifications on a settle counter, not answer text, so repeated identical answers still notify.
- Keep the window title compact and activity-aware; avoid redundant title updates.

## 3. Architecture decisions

### 3.1 Preserve explicit Electron layers

The durable boundary is:

```text
React renderer
  UI + normalized reducer state + virtualization
        ↓ typed request/event contract
sandboxed preload
  narrow invoke + subscribe bridge, runtime validation
        ↓ Electron IPC
Electron main
  sessions, queues, settings, filesystem, notifications, diagnostics
        ↓ application runtime adapter
pinned Pi SDK
  models, providers, agent sessions, tools, resources
```

Rules:

- No Node integration in the renderer.
- No renderer process access, subprocess spawning, credentials, raw environment, or unrestricted filesystem API.
- Do not import SDK objects or runtime event types into React.
- Keep shared application-domain contracts runtime-independent.
- Normalize every runtime payload before IPC.
- Validate requests in main and events/results in preload; TypeScript types alone are not a trust boundary.

### 3.2 Prefer an embedded, pinned runtime behind an adapter

The project began with one strict JSONL adapter for Tau and Pi. It later moved production to a pinned Pi SDK in Electron main while retaining the same normalized domain boundary.

Reasons to embed and pin:

- No separately installed executable is required.
- The app controls runtime compatibility.
- Typed SDK calls replace shell/process protocol coupling.
- Provider auth and credentials remain in trusted main-process runtime code.
- App-owned tools such as `spawn_session` can be injected directly.

Reasons to retain an adapter even with an SDK:

- SDK types and events should not become the renderer contract.
- Runtime upgrades remain localized.
- Capability gating remains explicit.
- The deterministic JSONL fake can still test transport and UI contracts.

The legacy JSONL adapter is test-only and opt-in. If implementing such a transport, retain the lessons learned here: LF-only framing, bounded records, UTF-8 handling, serialized writes, stdin backpressure, stdout pause/resume, correlated request IDs, bounded diagnostics, and a strict distinction between protocol stdout and diagnostic stderr.

### 3.3 Normalize lifecycle semantics

Agent runtimes expose several boundaries that do not all mean “idle”:

```text
agent_start
  turn_start
  streaming messages/tools
  turn_end
agent_end          # may still compact/retry
agent_settled      # safe idle boundary
```

- Use `agent_settled` as the idle transition.
- `agent_end` may precede overflow compaction and automatic retry.
- A post-acceptance runtime error may have no later settle; normalize it into a terminal state and queue-drain opportunity.
- Streaming deltas should carry or be reconciled with cumulative authoritative snapshots so one dropped delta cannot permanently corrupt the transcript.
- Process status is separate from transcript events and should carry a complete normalized snapshot.

### 3.4 Make capabilities data, not assumptions

Different runtimes and migration stages support different operations. Maintain a capability table as a single source of truth and gate controls from it.

- Unsupported actions are disabled or shown unavailable with a reason.
- Never infer support from a command name appearing in completion.
- Never invent an RPC command to fill a UI gap.
- App-owned features are valid when clearly modeled as such—for example model favorites, recent-session references, working directories, and editable prompt queues.
- Reassess capabilities when moving from subprocess RPC to an SDK; SDK availability does not automatically imply the desktop has a bounded, tested UI contract for that feature.

### 3.5 One live owner per session

Concurrent sessions created the repository's most important race-condition fixes.

Main-process rules:

- Keep one `RuntimeManager` per live session.
- Reserve ownership from the **requested session reference**, not transient startup state.
- Never let two processes write the same session.
- Retain busy background runtimes when the user switches away.
- Even idle sessions may retain their own process rather than being switched in place.
- Serialize lifecycle transitions such as activation and shutdown.
- Make concurrent startup single-flight so React StrictMode effect replay cannot launch/replace duplicate runtimes.
- On partial startup failure, stop and unregister the process.
- Stop all runtime owners during app shutdown.

A particularly dangerous case is creating a new session on a busy runtime. A runtime-level `new_session` can swap the transcript under an active agent, causing the remainder of the old turn to be written into the new session. The correct behavior is to leave the busy runtime attached to its original session and allocate another runtime for the new session.

### 3.6 Address every command to immutable session identity

Do not route an action through “whatever session is selected when main handles it.” Selection can change while IPC is in flight.

- Renderer actions carry `{ runtime, sessionId }` for the transcript where the action originated.
- The runtime pool resolves the owner of that exact target.
- Prompting, aborting, model/thinking changes, reads, naming, forking, compaction, export, and shell execution all use explicit targets.
- Refuse a submission while a target session is still opening and therefore unknown.
- Include immutable session identity on every streamed event.
- Reducers reject events and authoritative reads for any identity other than the latest active snapshot.

### 3.7 Treat hydration as a versioned transaction

A session view is assembled from async state and message reads plus live events. Avoid mixing generations:

- Increment a navigation/hydration generation when selection starts.
- Clear old view state and close the stream gate.
- Bind all reads to the requested target.
- Discard responses from older generations.
- Apply an authoritative snapshot/messages pair atomically enough that no old-session frame is visible.
- Rehydrate after settle when needed to reconcile authoritative tool completion.

### 3.8 Keep ownership boundaries explicit

A similar app will contain data from several owners:

| Data                         | Recommended owner                    |
| ---------------------------- | ------------------------------------ |
| Provider credentials/auth    | Runtime/SDK in trusted main process  |
| Durable session transcript   | Runtime session store                |
| Recent-session references    | Desktop app settings                 |
| Working-directory list       | Desktop app settings                 |
| Editable queued prompts      | Desktop main process                 |
| UI theme/sidebar/preferences | Desktop app settings                 |
| Model favorites              | Desktop app settings                 |
| Skills/prompts content       | Runtime resource loader/main process |
| Bounded resource metadata    | Renderer, after validation           |

Never parse runtime session JSONL directly to implement convenience UI. Use runtime/SDK commands for messages, entries, trees, statistics, compaction, naming, switching, and export. App-owned metadata may reference a runtime ID/path but must not reinterpret the transcript.

PR #21 adds another important proposed boundary: an app renamed to AO should store app-owned sessions under `~/.ao-agent/sessions` while continuing to use Pi's standard agent directory for authentication, models, skills, and prompts. Its migration principles are broadly applicable:

- Migrations must be non-destructive and idempotent.
- Copy referenced legacy sessions rather than silently importing every runtime session.
- Preserve originals.
- Handle path collisions safely.
- Allow explicit opening of external runtime sessions without silently taking ownership of unrelated data.
- Prefix new environment variables for the new product while supporting deprecated aliases with defined precedence.
- Document which app owns each directory.

This proposal is open and not yet the checked-out `main` behavior.

### 3.9 Validate and bound every crossing

The security review history repeatedly found places where a typed value was not sufficiently bounded at runtime.

- Use one discriminated request schema for IPC.
- Return structured `{ ok, value | error }` envelopes.
- Convert exceptions to bounded prose; do not send stack traces to React.
- Validate inbound events in preload before React receives them.
- Validate service results as well as requests.
- Bound arrays, strings, paths, record sizes, diagnostics, file sizes, and catalog counts.
- Strip control characters from renderer-visible diagnostic/version text.
- The renderer must never name an executable to probe or launch.
- Spawn argument arrays directly; never build shell command strings from settings.

### 3.10 Treat model and extension content as hostile

- Tokenize Markdown and render React elements; never enable model-provided raw HTML.
- Only syntax-highlighter output may use injected HTML, and only if the highlighter escapes input.
- Do not fetch remote images from model Markdown.
- Render tool output, patches, and extension content as text.
- Parse links and allow only `https:`, `http:`, and `mailto:`.
- Open allowed links via a main-process action; deny renderer popups and arbitrary navigation.
- Disable third-party Pi extensions until there is an explicit trust decision and bounded desktop UI contract. Extensions execute arbitrary Node code and are not a sandbox.
- Consider a utility process for crash/isolation boundaries before enabling untrusted extensions.

### 3.11 Lock down Electron itself

Every window should use:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- `nodeIntegrationInWorker: false`
- `webviewTag: false`
- denied optional permission requests
- denied popups, with safe links routed externally
- blocked unexpected navigation
- strict CSP in both response headers and document metadata

Generate the header and meta CSP from one source so they cannot drift. Keep development allowances (Vite/HMR) narrowly separate from the packaged policy.

### 3.12 Filesystem and resource discovery require trust design

`@` path completion and skill/prompt discovery are filesystem features even if they look like simple UI.

For file completion:

- Run traversal in main, rooted at the session cwd.
- Skip heavy/sensitive directories such as `.git`, `node_modules`, build output, and virtual environments.
- Bound breadth, depth, and result count.
- Permit deliberate relative traversal only within a documented boundary; this app limits it to two levels above cwd and generally within home.
- Return no result for prohibited absolute/out-of-bound paths rather than leaking filesystem detail.
- Drag/drop should expose only display paths, not renderer filesystem handles.

For skills/prompts/context files:

- Let the runtime's authoritative resource loader read content.
- Project-local discovery requires an explicit trust basis; “default” is not equivalent to approved.
- Keep untrusted project paths unread until a positive decision.
- User/global resources may have a separate trust policy.
- Reject non-regular, oversized, malformed, invalid-UTF-8, or control-bearing resources.
- Send only bounded catalog metadata to the renderer.
- User-added resource directories must come from a native folder chooser and persisted validated settings.
- If changing resource directories requires runtime restart, preserve the viewed session and make the reload behavior explicit.

### 3.13 Diagnostics must be useful but ephemeral

- Separate protocol output from diagnostics.
- Keep a bounded in-memory ring (500 lines in this project).
- Avoid credentials, full environment contents, provider headers, and stack traces.
- Drop diagnostics on app exit unless the user explicitly exports a safe report.
- Sanitize and truncate executable/runtime version text.

## 4. Testing and delivery decisions

### 4.1 Test the boundaries, not only components

A similar application needs several layers of deterministic tests:

- Pure reducer tests for streaming, grouping, queue state, identity gating, and compaction.
- Transport/framing tests for malformed, partial, oversized, and burst JSONL.
- Runtime-manager/pool state-machine tests for startup, shutdown, failure, duplicate activation, and ownership.
- IPC contract tests for both accepted and rejected payloads/results.
- Renderer tests for keyboard behavior, focus, completion selection, scrolling, virtualization, and accessibility IDs.
- Electron Playwright tests for preload isolation, session switching, background work, cancellation, errors, notifications, modals, and crash/restart.
- Cross-runtime contract tests while multiple adapters exist.
- Optional visual snapshots for themes, diffs, tool states, modals, and layouts.
- Optional real-provider smoke tests only outside normal CI; paid access must never be required.

### 4.2 Use a deterministic fake runtime

The fake runtime should script:

- text/thinking deltas
- tool starts/updates/ends
- delayed session switches
- crashes and post-acceptance errors
- retries/compaction boundaries
- long output and delayed measurements
- duplicate settles or stale events for negative tests

This makes subtle races reproducible without provider cost or network variability.

### 4.3 Test exact lifecycle and race scenarios

High-value regressions from this history include:

- React StrictMode triggering startup twice.
- Two rapid clicks attempting to create duplicate session owners.
- A background tool event arriving during/after session selection.
- An old hydration response winning after a newer navigation.
- Opening a new session while the current runtime is busy.
- Picker launch failure while a prior session continues streaming.
- Queue recall racing with typing or navigation.
- Dispatch failure retaining a queued item.
- A runtime error with no `agent_settled` still draining the next prompt.
- A programmatic tail jump racing with virtualized height changes.
- Distinct model identities collapsing to the same DOM ID.
- Cancellation during a delayed background-session startup.

### 4.4 Keep E2E runs isolated and non-disruptive

PR #22 made local Electron E2E windows hidden so tests do not steal focus or cover the desktop. Important nuances:

- Enable hidden-window mode only with isolated test user data.
- Keep background rendering unthrottled or timing-sensitive tests may stall.
- On Linux CI, a visible window inside an isolated Xvfb display can avoid Chromium hidden-X11 throttling while remaining invisible to the user.
- Explicitly test that hidden mode is actually hidden.
- Strip inherited development-server environment variables so an E2E run cannot accidentally test another checkout's running Vite renderer instead of its own built bundle.

### 4.5 Keep changes and integration focused

Several PR reviews were complicated by feature branches containing dozens of unrelated ancestor commits. The process lessons are:

- Base feature work on the intended current integration branch.
- Keep each PR's diff focused enough to review independently.
- Separate prerequisite work or land it first.
- Re-run the whole cumulative suite after conflict resolution.
- Fix stale E2E accessibility labels when UI copy changes.
- Review the exact final head, including manually resolved conflicts.
- Use atomic commits with descriptive messages.
- Do not include unrelated user files or generated artifacts.

## 5. Recommended implementation order

1. **Domain contract:** define normalized sessions, messages, events, capabilities, and targets.
2. **Electron security:** sandboxed renderer, narrow preload, CSP, navigation/permission policy.
3. **Runtime adapter:** embedded SDK or strict protocol transport isolated in main.
4. **Single-session lifecycle:** startup, stream normalization, settle semantics, crash/restart.
5. **Transcript UI:** safe Markdown, semantic tools, turn grouping, composer, scrolling.
6. **Explicit addressing:** attach immutable target identity to every command/event/read.
7. **Runtime pool:** one owner per session, serialized transitions, background sessions.
8. **Atomic navigation:** generation-scoped hydration and event gates.
9. **Main-owned prompt queues:** editable guidance/follow-up lifecycle and recovery.
10. **Projects/worktrees:** directory grouping, native chooser, app-owned recents.
11. **Commands/resources:** categorized completion, trust-aware discovery, bounded metadata.
12. **Polish:** themes, focus, accessibility, notifications, copy controls, title-bar integration.
13. **Advanced flows:** compaction retention, analytics, agent-spawned background sessions, extensions.
14. **Packaging/migration:** signing, updates, app identity, storage ownership, non-destructive migration.

## 6. Design checklist

Before shipping a similar feature, ask:

- Which layer owns this state?
- Is it transcript/session-scoped, runtime-global, or app-global?
- Does every async action carry immutable session identity?
- Could selection change while this request is in flight?
- What is the authoritative completion boundary: turn end, agent end, settle, or error?
- Can a retry, compaction, crash, or restart occur before “idle”?
- Can two processes write the same session?
- What happens if the user navigates, types, or cancels midway?
- Is unsupported functionality clearly unavailable rather than guessed?
- Is every IPC request **and result/event** validated and bounded?
- Is untrusted Markdown/path/resource/tool content kept out of HTML and privileged APIs?
- Does virtualization preserve reading position and durable history semantics?
- Does keyboard behavior have mouse and accessibility parity?
- Can the behavior be tested deterministically without a paid provider?
- Does the test exercise the real Electron/preload/main boundary where necessary?

## 7. Historical provenance

The most influential repository changes and PRs behind these decisions are:

| Area                                                     | PRs / commits                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Foundation, secure Electron, normalized runtime contract | `b8238ea`, `d31b617`                                                                   |
| Desktop chrome and transcript-first layout               | `8ba0495`, `3242465`, UI refinement commits on 2026-08-19                              |
| Composer growth, focus, undo/redo                        | `bdee982`, PR #13                                                                      |
| Scroll pinning and virtualization                        | `a16aa11`, `e4eaf61`, PR #12                                                           |
| Tool clustering and one-answer-per-turn rail             | `5e5ec59`, `b7054b5`, PR #6                                                            |
| Concurrent sessions and ownership/routing                | `2f7bde9`, `d200eb3`, `439476a`, `e72a852`, `a22db0d`, `9847939`, `91c05ee`, `237d004` |
| Scoped/favorite models                                   | PR #4                                                                                  |
| Slash categories and resource directives                 | PRs #2 and #5, `13bdd1c`, closed PR #16                                                |
| Editable guidance/follow-up queues                       | PR #8                                                                                  |
| Working-directory session grouping                       | PR #10; same-worktree shortcut in PR #19                                               |
| Context files and skill estimates                        | PRs #11 and #9                                                                         |
| Session analytics exploration                            | closed PR #14                                                                          |
| Compaction transcript retention                          | unmerged `6c11e23` branch commit                                                       |
| Embedded Pi production runtime                           | `3df697f` / PR #18 prerequisite history                                                |
| Agent-created background sessions                        | PR #18                                                                                 |
| Product rename and storage isolation                     | open PR #21                                                                            |
| Non-disruptive Electron E2E                              | PR #22                                                                                 |

## Related repository documents

- [`docs/architecture.md`](docs/architecture.md) — current runtime/session architecture.
- [`docs/security.md`](docs/security.md) — concrete Electron, IPC, content, and filesystem controls.
- [`docs/rpc-protocol.md`](docs/rpc-protocol.md) — legacy test protocol and lifecycle details.
- [`docs/ui-principles.md`](docs/ui-principles.md) — concise visual principles.
- [`docs/roadmap-status.md`](docs/roadmap-status.md) — implemented, migrated, and pending surfaces.
- [`docs/development.md`](docs/development.md) — local verification and test model.
