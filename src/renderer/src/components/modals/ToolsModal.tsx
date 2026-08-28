import type { ReactNode } from 'react';
import { useStore } from '../../state/store.js';
import { CopyButton } from '../CopyButton.js';
import { Modal } from './Modal.js';

/** Bounded, plain-text rendering of untrusted tool metadata and schemas. */
export function ToolsModal(): ReactNode {
  const { state, actions } = useStore();
  const catalog = state.toolCatalog;
  const text = catalog.tools
    .map(
      (tool) =>
        `${tool.name} (${tool.active ? 'active' : 'inactive'}, ${tool.origin})\n${tool.description}\n${JSON.stringify(tool.parameters, null, 2)}`,
    )
    .join('\n\n');

  return (
    <Modal
      name="tools"
      title="tools"
      subtitle={`${catalog.tools.length} shown / ${catalog.total} configured; metadata and schemas are untrusted`}
      onClose={() => actions.openModal(null)}
      footer={<CopyButton text={text} label="tool catalog" />}
    >
      {catalog.tools.length === 0 ? (
        <p className="picker-empty">no tools configured</p>
      ) : (
        <ul className="tool-catalog">
          {catalog.tools.map((tool) => (
            <li key={tool.name}>
              <div className="tool-catalog-heading">
                <strong>{tool.name}</strong>
                <span className="picker-badge">{tool.active ? 'active' : 'inactive'}</span>
                <span className="picker-hint">{tool.origin}</span>
              </div>
              <p>{tool.description || 'no description'}</p>
              <pre className="introspection-output">{JSON.stringify(tool.parameters, null, 2)}</pre>
              {tool.schemaTruncated ? (
                <p className="picker-reason">parameter schema truncated at the security limit</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {catalog.truncated ? <p className="picker-reason">tool catalog truncated</p> : null}
      {catalog.diagnostics.length > 0 ? (
        <ul className="diagnostic-list">
          {catalog.diagnostics.map((diagnostic, index) => (
            <li key={`${index}-${diagnostic}`}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
