import {
  THINKING_LEVELS,
  type SidebarPosition,
  type ThinkingLevel,
  type ThemeName,
} from '../../../../shared/domain.js';
import type { Actions } from '../../state/store.js';
import type { AppState } from '../../state/types.js';

export type CommandGroup =
  'session' | 'model' | 'thinking' | 'view' | 'theme' | 'runtime' | 'diagnostics';

export interface AppCommand {
  id: string;
  /** Display title. Slash commands use their `/name` form. */
  title: string;
  description: string;
  group: CommandGroup;
  /** `backend` needs the runtime, `frontend` is GUI-only. */
  origin: 'backend' | 'frontend';
  /** Slash form, when the command is reachable from the composer. */
  slash: string | null;
  /** Human-readable reason when the command cannot run. */
  unavailable: string | null;
  /** Run the full composer invocation, including any arguments. */
  run: (invocation?: string) => void;
}

/**
 * Input shape for `add`. A command either carries a real handler or states why
 * it cannot run: an entry without `run` must declare `unavailable`, so nothing
 * can be advertised as available and then silently do nothing.
 */
type CommandSpec = Omit<AppCommand, 'run' | 'unavailable'> &
  (
    | { run: (invocation?: string) => void; unavailable?: string | null }
    | { run?: undefined; unavailable: string }
  );

/** Return everything after the slash-command name without losing internal spacing. */
function commandArgs(invocation: string | undefined): string {
  return (invocation ?? '').trim().replace(/^\/\S+\s*/, '');
}

function parseExport(
  invocation: string | undefined,
): { format: 'html'; destination?: string } | { error: string } {
  const usage = 'Usage: /export [--format html] [destination]';
  const parts = commandArgs(invocation).split(/\s+/).filter(Boolean);
  let destination: string | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part === '--format') {
      const format = parts[++index];
      if (!format) return { error: usage };
      if (format !== 'html') return { error: 'JSONL export is not exposed by the runtime RPC.' };
    } else if (part.startsWith('--format=')) {
      if (part.slice('--format='.length) !== 'html') {
        return { error: 'JSONL export is not exposed by the runtime RPC.' };
      }
    } else if (part.startsWith('-') || destination) {
      return { error: usage };
    } else {
      destination = part;
    }
  }
  return { format: 'html', destination };
}

const THEMES: ThemeName[] = ['tau-dark', 'tau-light', 'high-contrast', 'pure-black'];
const SIDEBARS: SidebarPosition[] = ['right', 'left', 'off'];

/**
 * Single source of truth for the palette and slash completion.
 *
 * Capability-gated commands are always listed with the reason they cannot run so
 * missing RPC surfaces are visible instead of silently failing.
 */
export function buildCommands(state: AppState, actions: Actions): AppCommand[] {
  const capabilities = state.snapshot.capabilities;
  const commands: AppCommand[] = [];

  const add = (command: CommandSpec): void => {
    const unavailable = command.unavailable ?? null;
    commands.push({
      ...command,
      unavailable,
      // Unimplemented entries explain the gap instead of no-oping, even if a
      // caller bypasses the picker's unavailable guard.
      run:
        command.run ??
        ((): void =>
          actions.notice(`${command.title} is unavailable: ${unavailable ?? 'unknown'}`)),
    });
  };

  const gate = (supported: boolean, reason: string): string | null => (supported ? null : reason);

  /**
   * Reason for a command the GUI has no implementation for: the capability gap
   * when the runtime lacks the surface, otherwise the missing-GUI work.
   */
  const missing = (supported: boolean, capabilityReason: string): string =>
    supported ? 'this is not implemented in the desktop app yet' : capabilityReason;

  /* ------------------------------------------------------------- sessions */

  add({
    id: 'session.new',
    title: '/new',
    description: 'Start a new session',
    group: 'session',
    origin: 'backend',
    slash: '/new',
    unavailable: null,
    run: () => void actions.newSession(),
  });
  add({
    id: 'session.details',
    title: '/session',
    description: 'Session details and statistics',
    group: 'session',
    origin: 'frontend',
    slash: '/session',
    unavailable: null,
    run: () => actions.openModal('details'),
  });
  add({
    id: 'session.name',
    title: '/name',
    description: 'Rename the current session',
    group: 'session',
    origin: 'backend',
    slash: '/name',
    unavailable: null,
    run: (invocation) => {
      const name = commandArgs(invocation);
      if (name) void actions.nameSession(name);
      else actions.openModal('details');
    },
  });
  add({
    id: 'session.resume',
    title: '/resume',
    description: 'Recent sessions owned by this app',
    group: 'session',
    origin: 'frontend',
    slash: '/resume',
    unavailable: null,
    run: (invocation) => {
      const sessionId = commandArgs(invocation);
      if (sessionId) void actions.switchSession(sessionId);
      else actions.openModal('session');
    },
  });
  add({
    id: 'session.tree',
    title: '/tree',
    description: 'Browse the session tree and fork',
    group: 'session',
    origin: 'backend',
    slash: '/tree',
    unavailable: gate(
      capabilities.sessionTree,
      'this runtime does not expose session tree inspection',
    ),
    run: () => actions.openModal('tree'),
  });
  add({
    id: 'session.compact',
    title: '/compact',
    description: 'Compact the conversation context',
    group: 'session',
    origin: 'backend',
    slash: '/compact',
    unavailable: null,
    run: (invocation) => void actions.compact(commandArgs(invocation) || undefined),
  });
  add({
    id: 'session.export',
    title: '/export',
    description: 'Export the session as HTML (may include system prompts)',
    group: 'session',
    origin: 'backend',
    slash: '/export',
    unavailable: null,
    run: (invocation) => {
      const parsed = parseExport(invocation);
      if ('error' in parsed) actions.notice(parsed.error);
      else void actions.exportHtml(parsed.destination);
    },
  });
  add({
    id: 'session.clone',
    title: '/clone',
    description: 'Clone the session',
    group: 'session',
    origin: 'backend',
    slash: '/clone',
    // No GUI implementation exists yet, whatever the runtime supports.
    unavailable: capabilities.sessionClone
      ? 'clone is not implemented in the desktop app yet'
      : 'this runtime cannot clone sessions',
  });
  add({
    id: 'app.quit',
    title: '/quit',
    description: 'Stop the runtime and close the window',
    group: 'runtime',
    origin: 'frontend',
    slash: '/quit',
    unavailable: null,
    run: () => void actions.quit(),
  });

  /* --------------------------------------------------------------- models */

  add({
    id: 'model.pick',
    title: '/model',
    description: 'Pick a model',
    group: 'model',
    origin: 'backend',
    slash: '/model',
    unavailable: null,
    run: (invocation) => {
      const requested = commandArgs(invocation);
      if (!requested) {
        actions.openModal('model');
        return;
      }
      const model = state.models.find(
        (candidate) =>
          candidate.id === requested || `${candidate.provider}:${candidate.id}` === requested,
      );
      if (!model) {
        actions.notice(`Unknown model: ${requested}`);
        return;
      }
      void actions.setModel({ provider: model.provider, modelId: model.id });
    },
  });
  add({
    id: 'model.cycle',
    title: '/cycle-model',
    description: 'Cycle to the next model (Ctrl+P)',
    group: 'model',
    origin: 'backend',
    slash: '/cycle-model',
    unavailable: null,
    run: () => void actions.cycleModel(),
  });
  add({
    id: 'model.scoped',
    title: '/scoped-models',
    description: 'Manage scoped/favourite models',
    group: 'model',
    origin: 'backend',
    slash: '/scoped-models',
    unavailable: missing(
      capabilities.scopedModels,
      'scoped model management needs runtime RPC support',
    ),
  });
  add({
    id: 'thinking.pick',
    title: '/thinking',
    description: 'Pick a thinking level',
    group: 'thinking',
    origin: 'backend',
    slash: '/thinking',
    unavailable: null,
    run: (invocation) => {
      const level = commandArgs(invocation);
      if (!level) actions.openModal('thinking');
      else if (state.thinkingLevels.includes(level as ThinkingLevel)) {
        void actions.setThinking(level as ThinkingLevel);
      } else actions.notice(`Unknown thinking level: ${level}`);
    },
  });

  /* ----------------------------------------------------------------- view */

  add({
    id: 'view.expand',
    title: '/expand',
    description: 'Toggle expansion of every block (Ctrl+O)',
    group: 'view',
    origin: 'frontend',
    slash: '/expand',
    unavailable: null,
    run: () => actions.toggleExpandAll(),
  });
  add({
    id: 'view.thinking',
    title: '/show-thinking',
    description: state.settings.showThinking ? 'Hide thinking blocks' : 'Show thinking blocks',
    group: 'view',
    origin: 'frontend',
    slash: '/show-thinking',
    unavailable: null,
    run: () => void actions.updateSettings({ showThinking: !state.settings.showThinking }),
  });
  add({
    id: 'view.theme',
    title: '/theme',
    description: 'Pick a local theme',
    group: 'theme',
    origin: 'frontend',
    slash: '/theme',
    unavailable: null,
    run: (invocation) => {
      const theme = commandArgs(invocation);
      if (!theme) actions.openModal('theme');
      else if (THEMES.includes(theme as ThemeName)) {
        void actions.updateSettings({ theme });
      } else {
        actions.notice(`Unknown theme: ${theme}\nAvailable themes: ${THEMES.join(', ')}`);
      }
    },
  });
  add({
    id: 'view.hotkeys',
    title: '/hotkeys',
    description: 'Keyboard shortcut reference',
    group: 'view',
    origin: 'frontend',
    slash: '/hotkeys',
    unavailable: null,
    run: () => actions.openModal('hotkeys'),
  });
  add({
    id: 'view.settings',
    title: '/settings',
    description: 'Application settings',
    group: 'view',
    origin: 'frontend',
    slash: '/settings',
    unavailable: null,
    run: () => actions.openModal('settings'),
  });
  add({
    id: 'view.diagnostics',
    title: '/diagnostics',
    description: 'Runtime diagnostics',
    group: 'diagnostics',
    origin: 'frontend',
    slash: '/diagnostics',
    unavailable: null,
    run: () => actions.openModal('diagnostics'),
  });
  for (const position of SIDEBARS) {
    add({
      id: `view.sidebar.${position}`,
      title: `sidebar: ${position}`,
      description: 'Sidebar position',
      group: 'view',
      origin: 'frontend',
      slash: null,
      unavailable: null,
      run: () => void actions.updateSettings({ sidebarPosition: position }),
    });
  }

  /* -------------------------------------------------------------- runtime */

  add({
    id: 'runtime.restart',
    title: '/restart',
    description: 'Restart the runtime process (Ctrl+R)',
    group: 'runtime',
    origin: 'frontend',
    slash: '/restart',
    unavailable: null,
    run: () => void actions.restart(),
  });
  add({
    id: 'runtime.directory',
    title: '/cwd',
    description: 'Open a project directory',
    group: 'runtime',
    origin: 'frontend',
    slash: '/cwd',
    unavailable: null,
    run: () => void actions.openDirectory(),
  });
  add({
    id: 'runtime.commands',
    title: '/commands',
    description: 'Commands, skills, and prompts discovered from the runtime',
    group: 'runtime',
    origin: 'backend',
    slash: '/commands',
    unavailable: null,
    run: () => actions.openModal('commands'),
  });
  add({
    id: 'runtime.skills',
    title: '/skills',
    description: 'Browse and insert a loaded skill',
    group: 'runtime',
    origin: 'backend',
    slash: '/skills',
    unavailable:
      state.snapshot.runtime === 'tau' ? null : 'resource discovery is currently available for Tau',
    run: () => actions.openModal('skills'),
  });
  add({
    id: 'runtime.prompts',
    title: '/prompts',
    description: 'Choose a loaded prompt template',
    group: 'runtime',
    origin: 'backend',
    slash: '/prompts',
    unavailable:
      state.snapshot.runtime === 'tau' ? null : 'resource discovery is currently available for Tau',
    run: () => actions.openModal('prompts'),
  });
  add({
    id: 'runtime.tools',
    title: '/tools',
    description: 'Inspect the tool catalog',
    group: 'runtime',
    origin: 'backend',
    slash: '/tools',
    unavailable: missing(
      capabilities.toolCatalog,
      'tool catalog inspection needs runtime RPC support',
    ),
  });
  add({
    id: 'runtime.system',
    title: '/system',
    description: 'Inspect the system prompt',
    group: 'runtime',
    origin: 'backend',
    slash: '/system',
    unavailable: missing(
      capabilities.systemPromptInspection,
      'system prompt inspection needs runtime RPC support',
    ),
  });
  add({
    id: 'runtime.reload',
    title: '/reload',
    description: 'Reload skills, prompts, and extensions',
    group: 'runtime',
    origin: 'backend',
    slash: '/reload',
    unavailable: missing(capabilities.resourceReload, 'resource reload needs runtime RPC support'),
  });
  for (const action of ['login', 'logout'] as const) {
    add({
      id: `runtime.${action}`,
      title: `/${action}`,
      description: `Provider ${action}`,
      group: 'runtime',
      origin: 'backend',
      slash: `/${action}`,
      unavailable: missing(
        capabilities.providerLogin,
        'provider credential management needs runtime RPC support',
      ),
    });
  }
  for (const kind of ['tau', 'pi'] as const) {
    add({
      id: `runtime.switch.${kind}`,
      title: `runtime: ${kind}`,
      description:
        state.settings.agentRuntime === kind ? 'Current runtime' : `Switch the runtime to ${kind}`,
      group: 'runtime',
      origin: 'frontend',
      slash: null,
      unavailable: null,
      run: () => void actions.switchRuntime(kind),
    });
  }

  /* ------------------------------------------------- runtime-discovered */

  const registeredSlashes = new Set(
    commands.flatMap((command) => (command.slash ? [command.slash.slice(1)] : [])),
  );
  for (const command of state.commands) {
    // Tau reports built-ins from get_commands too. Keep the GUI implementation
    // above rather than adding a duplicate that would incorrectly prompt the model.
    if (registeredSlashes.has(command.name)) continue;
    add({
      id: `discovered.${command.name}`,
      title: `/${command.name}`,
      description: command.description,
      group: 'runtime',
      origin: command.source === 'runtime' ? 'backend' : 'frontend',
      slash: `/${command.name}`,
      unavailable: 'the runtime lists this command but does not expose command execution over RPC',
    });
  }

  return commands;
}

/** Palette-only entries: themes, models, thinking levels, and recent sessions. */
export function buildPaletteExtras(state: AppState, actions: Actions): AppCommand[] {
  const extras: AppCommand[] = [];

  for (const theme of THEMES) {
    extras.push({
      id: `theme.${theme}`,
      title: `theme: ${theme}`,
      description: state.settings.theme === theme ? 'Current theme' : 'Apply this theme',
      group: 'theme',
      origin: 'frontend',
      slash: null,
      unavailable: null,
      run: () => void actions.updateSettings({ theme }),
    });
  }

  for (const model of state.models) {
    extras.push({
      id: `model.${model.provider}.${model.id}`,
      title: `model: ${model.name}`,
      description: `${model.provider} · ${model.id}`,
      group: 'model',
      origin: 'backend',
      slash: null,
      unavailable: null,
      run: () => void actions.setModel({ provider: model.provider, modelId: model.id }),
    });
  }

  const levels = state.thinkingLevels.length > 0 ? state.thinkingLevels : [];
  for (const level of levels) {
    extras.push({
      id: `thinking.${level}`,
      title: `thinking: ${level}`,
      description: THINKING_LEVELS.includes(level) ? 'Set the thinking level' : 'Thinking level',
      group: 'thinking',
      origin: 'backend',
      slash: null,
      unavailable: null,
      run: () => void actions.setThinking(level),
    });
  }

  for (const session of state.settings.recentSessions) {
    const ref = session.path ?? session.id;
    extras.push({
      id: `session.recent.${session.id}`,
      title: `session: ${session.name ?? session.id}`,
      description: `${session.runtime} · ${session.path ?? session.cwd ?? 'unknown location'}`,
      group: 'session',
      origin: 'backend',
      slash: null,
      unavailable: null,
      run: () => void actions.switchSession(ref),
    });
  }

  return extras;
}
