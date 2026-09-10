import { useRef, type FormEvent, type ReactNode } from 'react';
import type { AuthFlow, AuthProvider, AuthType } from '../../../../shared/auth.js';
import { invoke } from '../../bridge.js';
import { useStore } from '../../state/store.js';
import { Modal } from './Modal.js';
import { Picker, type PickerItem } from './Picker.js';

export function AuthModal({ mode }: { mode: 'login' | 'logout' }): ReactNode {
  const { state, actions } = useStore();
  const flow = state.authFlow;
  const close = (): void => {
    if (flow && (flow.status === 'running' || flow.status === 'prompt')) {
      void actions.cancelLogin(flow.id);
    }
    actions.openModal(null);
  };

  if (mode === 'login' && flow) {
    return <LoginFlow flow={flow} onClose={close} />;
  }

  const entries = providerEntries(state.authProviders, mode);
  return (
    <Picker
      name={mode}
      title={mode === 'login' ? 'provider login' : 'provider logout'}
      subtitle={
        mode === 'login'
          ? 'Credentials are handled by Pi and saved in its standard credential store.'
          : 'Only credentials saved by Pi are removed. Environment and model configuration stay unchanged.'
      }
      items={entries}
      placeholder="filter providers…"
      emptyLabel={
        mode === 'login' ? 'no interactive providers available' : 'no stored credentials to remove'
      }
      onClose={close}
      onAccept={(item) => {
        if (item.reason) return;
        const parsed = parseEntryId(item.id);
        if (!parsed) return;
        if (mode === 'login') void actions.startLogin(parsed.providerId, parsed.authType);
        else void actions.logoutProvider(parsed.providerId);
      }}
    />
  );
}

function LoginFlow({ flow, onClose }: { flow: AuthFlow; onClose: () => void }): ReactNode {
  const { actions } = useStore();
  const input = useRef<HTMLInputElement | null>(null);
  const prompt = flow.prompt;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const element = input.current;
    if (!element || !prompt) return;
    const value = element.value;
    element.value = '';
    if (value) void actions.respondLogin(flow.id, prompt.id, value);
  };

  return (
    <Modal
      name="login"
      title={`login · ${flow.providerName}`}
      subtitle={flow.authType === 'oauth' ? 'account sign-in' : 'API key setup'}
      onClose={onClose}
      footer={
        flow.status === 'succeeded' || flow.status === 'failed' || flow.status === 'cancelled' ? (
          <button type="button" className="ghost-button" onClick={onClose}>
            done
          </button>
        ) : null
      }
    >
      <div className="auth-flow" aria-live="polite">
        {flow.notices.map((notice, index) => (
          <AuthNotice key={`${notice.type}-${index}`} notice={notice} />
        ))}
        {flow.message ? <p className={`auth-message ${flow.status}`}>{flow.message}</p> : null}
        {prompt?.type === 'select' ? (
          <div className="auth-options">
            <p>{prompt.message}</p>
            {(prompt.options ?? []).map((option) => (
              <button
                type="button"
                className="auth-option"
                key={option.id}
                onClick={() => void actions.respondLogin(flow.id, prompt.id, option.id)}
              >
                <strong>{option.label}</strong>
                {option.description ? <span>{option.description}</span> : null}
              </button>
            ))}
          </div>
        ) : prompt ? (
          <form className="auth-prompt" onSubmit={submit}>
            <label htmlFor={`auth-prompt-${prompt.id}`}>{prompt.message}</label>
            <input
              id={`auth-prompt-${prompt.id}`}
              ref={input}
              data-autofocus="true"
              type={prompt.type === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={prompt.placeholder}
              maxLength={16_384}
            />
            <button type="submit">submit</button>
          </form>
        ) : null}
      </div>
    </Modal>
  );
}

function AuthNotice({ notice }: { notice: AuthFlow['notices'][number] }): ReactNode {
  if (notice.type === 'auth_url') {
    return (
      <div className="auth-notice">
        {notice.instructions ? <p>{notice.instructions}</p> : null}
        <button
          type="button"
          className="status-link"
          onClick={() => void invoke('ui.openExternal', { url: notice.url })}
        >
          open authentication page
        </button>
      </div>
    );
  }
  if (notice.type === 'device_code') {
    return (
      <div className="auth-notice">
        <p>
          Enter code: <strong className="auth-device-code">{notice.userCode}</strong>
        </p>
        <button
          type="button"
          className="status-link"
          onClick={() => void invoke('ui.openExternal', { url: notice.verificationUri })}
        >
          open verification page
        </button>
      </div>
    );
  }
  if (notice.type === 'info') {
    return (
      <div className="auth-notice">
        <p>{notice.message}</p>
        {(notice.links ?? []).map((link) => (
          <button
            key={link.url}
            type="button"
            className="status-link"
            onClick={() => void invoke('ui.openExternal', { url: link.url })}
          >
            {link.label ?? link.url}
          </button>
        ))}
      </div>
    );
  }
  return <p className="auth-notice">{notice.message}</p>;
}

function providerEntries(providers: AuthProvider[], mode: 'login' | 'logout'): PickerItem[] {
  if (mode === 'logout') {
    return providers.flatMap((provider) =>
      provider.storedCredential
        ? [
            {
              id: entryId(provider.id, provider.storedCredential),
              label: provider.name,
              detail: provider.id,
              badge: provider.storedCredential === 'oauth' ? 'subscription' : 'API key',
              hint: 'stored',
            },
          ]
        : [],
    );
  }
  return providers.flatMap((provider) =>
    provider.methods.map((method) => ({
      id: entryId(provider.id, method.type),
      label: provider.name,
      detail: method.label,
      badge: method.type === 'oauth' ? 'subscription' : 'API key',
      hint: provider.configured ? 'configured' : null,
      reason: method.interactive ? null : 'configured outside Pi; no interactive login',
      keywords: `${provider.id} ${method.type} ${method.label}`,
    })),
  );
}

function entryId(providerId: string, authType: AuthType): string {
  return `${authType}:${providerId}`;
}

function parseEntryId(value: string): { providerId: string; authType: AuthType } | null {
  const separator = value.indexOf(':');
  const authType = value.slice(0, separator);
  const providerId = value.slice(separator + 1);
  return providerId && (authType === 'api_key' || authType === 'oauth')
    ? { providerId, authType }
    : null;
}
