# UI principles

- Preserve Tau's transcript-first design: no conventional permanent header or shortcut footer.
- Keep the multiline composer at the bottom and the session sidebar on the right by default.
- Use vertical role bars rather than boxed chat bubbles.
- Use Tau's dark, light, and high-contrast palettes, plus a true-black theme with subtly differentiated user turns.
- Render tool activity semantically: orange running, green success, red failure.
- Replace the composer's Tau prompt with one compact CLI-style spinner during active model work.
- Interleave reasoning and clustered tool calls on one compact rail below the active user turn.
- Render only the assistant message that closes a turn as the answer; reasoning and the narration a model writes before a tool call stay on the rail.
- Collapse settled activity into a quiet duration/tool-count summary immediately before the answer.
- Keep exact commands, arguments, output, and patches available through expansion.
- Optimize for keyboard use without sacrificing mouse selection, scrolling, links, and native clipboard behavior.
- Virtualize long transcripts without changing runtime context or durable history.
- Treat `agent_settled`, not `agent_end`, as the transition to idle.
