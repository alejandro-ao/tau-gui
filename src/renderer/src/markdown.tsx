import hljs from 'highlight.js/lib/common';
import { marked, type Token, type Tokens } from 'marked';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { invoke } from './bridge.js';

/**
 * Safe incremental Markdown rendering.
 *
 * Model output is untrusted: raw HTML is never inserted into the DOM as markup,
 * links are opened through the main-process allowlist, and the only HTML we
 * inject is highlight.js output, which escapes all source text itself.
 */
export function Markdown({ text }: { text: string }): ReactNode {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true, breaks: false }), [text]);
  return <div className="markdown">{renderTokens(tokens)}</div>;
}

function renderTokens(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}

function renderToken(token: Token): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const Tag = `h${Math.min(heading.depth, 6)}` as 'h1';
      return <Tag>{renderInline(heading.tokens)}</Tag>;
    }
    case 'paragraph':
      return <p>{renderInline((token as Tokens.Paragraph).tokens ?? [])}</p>;
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : text.text;
    }
    case 'blockquote':
      return <blockquote>{renderTokens((token as Tokens.Blockquote).tokens ?? [])}</blockquote>;
    case 'code':
      return <CodeBlock token={token as Tokens.Code} />;
    case 'hr':
      return <hr />;
    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={index} className={item.task ? 'task' : undefined}>
          {item.task ? <input type="checkbox" checked={item.checked} readOnly /> : null}
          {renderTokens(item.tokens ?? [])}
        </li>
      ));
      return list.ordered ? (
        <ol start={typeof list.start === 'number' ? list.start : 1}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case 'table': {
      const table = token as Tokens.Table;
      return (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index} style={alignStyle(table.align[index])}>
                    {renderInline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={alignStyle(table.align[cellIndex])}>
                      {renderInline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      // Raw HTML from the model is displayed as text and never executed.
      return <pre className="raw-html">{(token as Tokens.HTML).raw}</pre>;
    default:
      return 'raw' in token ? <p>{String(token.raw)}</p> : null;
  }
}

function renderInline(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'text':
        return <Fragment key={index}>{(token as Tokens.Text).text}</Fragment>;
      case 'escape':
        return <Fragment key={index}>{(token as Tokens.Escape).text}</Fragment>;
      case 'strong':
        return <strong key={index}>{renderInline((token as Tokens.Strong).tokens)}</strong>;
      case 'em':
        return <em key={index}>{renderInline((token as Tokens.Em).tokens)}</em>;
      case 'del':
        return <del key={index}>{renderInline((token as Tokens.Del).tokens)}</del>;
      case 'codespan':
        return <code key={index}>{(token as Tokens.Codespan).text}</code>;
      case 'br':
        return <br key={index} />;
      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        // Unsupported schemes (`file:`, `javascript:`, relative paths) never
        // reach the DOM as a navigable href: middle-click and drag cannot
        // bypass the click handler if there is nothing to navigate to.
        if (!href) {
          return (
            <span key={index} className="inert-link" title={link.title ?? undefined}>
              {renderInline(link.tokens)}
            </span>
          );
        }
        return (
          <a
            key={index}
            href={href}
            title={link.title ?? undefined}
            onClick={(event) => {
              event.preventDefault();
              void invoke('ui.openExternal', { url: href }).catch(() => undefined);
            }}
          >
            {renderInline(link.tokens)}
          </a>
        );
      }
      case 'image': {
        const image = token as Tokens.Image;
        // Remote images are not loaded; the alt text is shown instead.
        return (
          <span key={index} className="image-placeholder">
            [image: {image.text || image.href}]
          </span>
        );
      }
      case 'html':
        return <Fragment key={index}>{(token as Tokens.HTML).raw}</Fragment>;
      default:
        return <Fragment key={index}>{'raw' in token ? String(token.raw) : null}</Fragment>;
    }
  });
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Model-supplied hrefs are only kept when their scheme is web-safe. */
export function safeHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return ALLOWED_SCHEMES.has(url.protocol) ? url.href : null;
}

function alignStyle(align: 'center' | 'left' | 'right' | null | undefined): {
  textAlign?: 'center' | 'left' | 'right';
} {
  return align ? { textAlign: align } : {};
}

function CodeBlock({ token }: { token: Tokens.Code }): ReactNode {
  const [copied, setCopied] = useState(false);
  const language = (token.lang ?? '').split(/\s+/)[0] ?? '';
  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(token.text, { language, ignoreIllegals: true }).value;
      } catch {
        return null;
      }
    }
    return null;
  }, [language, token.text]);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(token.text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-lang">{language || 'text'}</span>
        <button type="button" onClick={copy} className="ghost-button">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre>
        {highlighted ? (
          <code
            className={`hljs language-${language}`}
            // highlight.js escapes the source text; no model HTML reaches the DOM.
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className="hljs">{token.text}</code>
        )}
      </pre>
    </div>
  );
}
