# UI principles

- Preserve Tau's transcript-first design: no conventional shortcut footer; keep the compact main-view tab header limited to **Conversation** and **Session usage**.
- Keep the multiline composer at the bottom and the session sidebar on the right by default.
- Use vertical role bars rather than boxed chat bubbles.
- Use Tau's dark, light, and high-contrast palettes, plus a true-black theme with subtly differentiated user turns.
- Render tool activity semantically: orange running, green success, red failure.
- Replace the composer's Tau prompt with one compact CLI-style spinner during active model work.
- Mark resource-backed slash directives (skills, custom prompts) as coloured pills while typing, so drafts that expand inside the runtime read differently from GUI commands.
- Interleave reasoning and clustered tool calls on one compact rail below the active user turn.
- Render only the assistant message that closes a turn as the answer; reasoning and the narration a model writes before a tool call stay on the rail.
- Collapse settled activity into a quiet duration/tool-count summary immediately before the answer.
- Keep exact commands, arguments, output, and patches available through expansion.
- Optimize for keyboard use without sacrificing mouse selection, scrolling, links, and native clipboard behavior.
- Virtualize long transcripts without changing runtime context or durable history.
- Derive session analytics only from normalized RPC messages and stats. Label missing provider data and unsupported export event markers honestly; never inspect session JSONL in the renderer.
- Treat `agent_settled`, not `agent_end`, as the transition to idle.
