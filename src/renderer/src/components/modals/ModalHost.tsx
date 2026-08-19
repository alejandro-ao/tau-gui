import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { CommandsModal } from './CommandsModal.js';
import { DetailsModal } from './DetailsModal.js';
import { DiagnosticsModal } from './DiagnosticsModal.js';
import { HotkeysModal } from './HotkeysModal.js';
import { ModelModal } from './ModelModal.js';
import { PaletteModal } from './PaletteModal.js';
import { ScopedModelsModal } from './ScopedModelsModal.js';
import { SessionModal } from './SessionModal.js';
import { SettingsModal } from './SettingsModal.js';
import { ThemeModal } from './ThemeModal.js';
import { ThinkingModal } from './ThinkingModal.js';
import { TreeModal } from './TreeModal.js';

/** Renders the single active modal described by `state.modal`. */
export function ModalHost(): ReactNode {
  const { state } = useStore();
  switch (state.modal) {
    case null:
      return null;
    case 'palette':
      return <PaletteModal />;
    case 'model':
      return <ModelModal />;
    case 'scoped':
      return <ScopedModelsModal />;
    case 'session':
      return <SessionModal />;
    case 'tree':
      return <TreeModal />;
    case 'theme':
      return <ThemeModal />;
    case 'thinking':
      return <ThinkingModal />;
    case 'hotkeys':
      return <HotkeysModal />;
    case 'details':
      return <DetailsModal />;
    case 'settings':
      return <SettingsModal />;
    case 'diagnostics':
      return <DiagnosticsModal />;
    case 'commands':
      return <CommandsModal />;
  }
}
