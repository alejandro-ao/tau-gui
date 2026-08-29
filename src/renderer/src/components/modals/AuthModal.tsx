import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '../../bridge.js';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';

/** Provider auth UI. Secret input stays component-local and is never dispatched. */
export function AuthModal(): ReactNode {
  const { state, actions } = useStore();
  const [value, setValue] = useState('');
  const flow = state.authFlow;
  const challengeKey = flow?.type === 'prompt' ? flow.challengeId : null;

  useEffect(() => {
    void actions.loadProviderAuth();
  }, [actions]);

  useEffect(() => {
    setValue('');
  }, [flow?.flowId, flow?.type, challengeKey]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!flow || flow.type !== 'prompt') return;
    const response = value;
    setValue('');
    void actions.respondProviderAuth(flow.flowId, flow.challengeId, response);
  };

  return (
    <Modal
      name="auth"
      title="provider authentication"
      subtitle="credentials are stored and resolved only by embedded Pi in Electron main"
      onClose={() => {
        if (flow && flow.type !== 'complete') void actions.cancelProviderAuth(flow.flowId);
        actions.openModal(null);
      }}
    >
      <div className="settings-grid" data-testid="provider-auth">
        {state.providerAuth.map((provider) => (
          <div className="settings-auth-row" key={provider.id}>
            <div>
              <strong>{provider.name}</strong>
              <div className="dim">
                {provider.configured
                  ? `configured · ${provider.credentialType ?? 'ambient'}${provider.source ? ` · ${provider.source}` : ''}`
                  : 'not configured'}
              </div>
            </div>
            <div className="settings-inline">
              {provider.methods.includes('api_key') ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={Boolean(flow && flow.type !== 'complete')}
                  onClick={() => void actions.loginProvider(provider.id, 'api_key')}
                >
                  API key
                </button>
              ) : null}
              {provider.methods.includes('oauth') ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={Boolean(flow && flow.type !== 'complete')}
                  onClick={() => void actions.loginProvider(provider.id, 'oauth')}
                >
                  OAuth
                </button>
              ) : null}
              {provider.configured ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void actions.logoutProvider(provider.id)}
                >
                  logout
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {flow?.type === 'prompt' ? (
        <form className="auth-challenge" onSubmit={submit}>
          <label htmlFor="auth-response">{flow.message}</label>
          {flow.input === 'select' ? (
            <select
              id="auth-response"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">choose…</option>
              {flow.options.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.label}
                  {option.description ? ` — ${option.description}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="auth-response"
              autoFocus
              type={flow.input === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              placeholder={flow.placeholder ?? undefined}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <button type="submit" disabled={!value}>
            continue
          </button>
        </form>
      ) : null}

      {flow?.type === 'auth_url' ? (
        <div className="auth-challenge">
          <p>{flow.instructions ?? 'Continue authentication in your browser.'}</p>
          <button type="button" onClick={() => void invoke('ui.openExternal', { url: flow.url })}>
            open sign-in page
          </button>
        </div>
      ) : null}

      {flow?.type === 'device_code' ? (
        <div className="auth-challenge">
          <p>
            Enter code <strong>{flow.userCode}</strong> at the provider verification page.
          </p>
          <button
            type="button"
            onClick={() => void invoke('ui.openExternal', { url: flow.verificationUri })}
          >
            open verification page
          </button>
        </div>
      ) : null}

      {flow?.type === 'info' || flow?.type === 'progress' || flow?.type === 'complete' ? (
        <div className="auth-challenge" role="status">
          <p>{flow.message}</p>
          {flow.type === 'info'
            ? flow.links.map((link) => (
                <button
                  type="button"
                  className="ghost-button"
                  key={link.url}
                  onClick={() => void invoke('ui.openExternal', { url: link.url })}
                >
                  {link.label ?? 'open link'}
                </button>
              ))
            : null}
        </div>
      ) : null}
    </Modal>
  );
}
