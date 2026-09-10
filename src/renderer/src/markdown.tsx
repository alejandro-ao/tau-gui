import hljs from 'highlight.js/lib/common';
import { marked, type Token, type Tokens } from 'marked';
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from './bridge.js';

/**
 * Safe incremental Markdown rendering.
 *
 * Model output is untrusted: raw HTML is never inserted into the DOM as markup,
 * links are opened through the main-process allowlist, and the only HTML we
 * inject is highlight.js output, which escapes all source text itself.
 */
interface Reveal {
  remaining: number;
  revision: number;
}

const MAX_REVEAL_CHARACTERS = 12;
const STREAM_REVEAL_SETTLE_MS = 180;

/**
 * Renders every stream update immediately and keeps a short trailing reveal
 * visible. Stream chunks often arrive faster than one CSS animation, so a
 * bounded cumulative tail prevents the animated node disappearing after only
 * a few milliseconds while avoiding persistent per-token DOM elements.
 */
export function StreamingMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): ReactNode {
  const [settling, setSettling] = useState(false);
  const wasStreaming = useRef(streaming);
  const justSettled = wasStreaming.current && !streaming;

  useEffect(() => {
    const stopped = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (streaming) {
      setSettling(false);
      return;
    }
    if (!stopped) return;

    setSettling(true);
    const timeout = window.setTimeout(() => setSettling(false), STREAM_REVEAL_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [streaming]);

  const reveal = streaming || settling || justSettled;
  return (
    <Markdown
      text={text}
      revealCharacters={reveal ? Math.min(text.length, MAX_REVEAL_CHARACTERS) : 0}
      revealRevision={text.length}
    />
  );
}

export const Markdown = memo(function Markdown({
  text,
  revealCharacters = 0,
  revealRevision = 0,
}: {
  text: string;
  revealCharacters?: number;
  revealRevision?: number;
}): ReactNode {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true, breaks: false }), [text]);
  const reveal: Reveal | undefined =
    revealCharacters > 0 ? { remaining: revealCharacters, revision: revealRevision } : undefined;
  return <div className="markdown">{renderTokens(tokens, reveal)}</div>;
});

function renderTokens(tokens: Token[], reveal?: Reveal): ReactNode[] {
  const rendered = new Array<ReactNode>(tokens.length);
  // Rendering from the tail lets one small reveal budget cross inline Markdown
  // boundaries while creating spans only for the newest visible characters.
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    rendered[index] = <Fragment key={index}>{renderToken(tokens[index]!, reveal)}</Fragment>;
  }
  return rendered;
}

function renderToken(token: Token, reveal?: Reveal): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const Tag = `h${Math.min(heading.depth, 6)}` as 'h1';
      return <Tag>{renderInline(heading.tokens, reveal)}</Tag>;
    }
    case 'paragraph':
      return <p>{renderInline((token as Tokens.Paragraph).tokens ?? [], reveal)}</p>;
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens, reveal) : revealText(text.text, reveal);
    }
    case 'blockquote':
      return (
        <blockquote>{renderTokens((token as Tokens.Blockquote).tokens ?? [], reveal)}</blockquote>
      );
    case 'code':
      // Highlighted code is a single escaped HTML subtree; do not split it into
      // per-delta DOM nodes just to animate it.
      discardReveal(reveal);
      return <CodeBlock token={token as Tokens.Code} />;
    case 'hr':
      return <hr />;
    case 'list': {
      const list = token as Tokens.List;
      const items = new Array<ReactNode>(list.items.length);
      for (let index = list.items.length - 1; index >= 0; index -= 1) {
        const item = list.items[index]!;
        items[index] = (
          <li key={index} className={item.task ? 'task' : undefined}>
            {item.task ? <input type="checkbox" checked={item.checked} readOnly /> : null}
            {renderTokens(item.tokens ?? [], reveal)}
          </li>
        );
      }
      return list.ordered ? (
        <ol start={typeof list.start === 'number' ? list.start : 1}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case 'table': {
      const table = token as Tokens.Table;
      const rows = new Array<ReactNode>(table.rows.length);
      for (let rowIndex = table.rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const row = table.rows[rowIndex]!;
        const cells = new Array<ReactNode>(row.length);
        for (let cellIndex = row.length - 1; cellIndex >= 0; cellIndex -= 1) {
          const cell = row[cellIndex]!;
          cells[cellIndex] = (
            <td key={cellIndex} style={alignStyle(table.align[cellIndex])}>
              {renderInline(cell.tokens, reveal)}
            </td>
          );
        }
        rows[rowIndex] = <tr key={rowIndex}>{cells}</tr>;
      }
      const headers = new Array<ReactNode>(table.header.length);
      for (let index = table.header.length - 1; index >= 0; index -= 1) {
        const cell = table.header[index]!;
        headers[index] = (
          <th key={index} style={alignStyle(table.align[index])}>
            {renderInline(cell.tokens, reveal)}
          </th>
        );
      }
      return (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>{headers}</tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      );
    }
    case 'html':
      // Raw HTML from the model is displayed as text and never executed.
      return <pre className="raw-html">{revealText((token as Tokens.HTML).raw, reveal)}</pre>;
    default:
      return 'raw' in token ? <p>{revealText(String(token.raw), reveal)}</p> : null;
  }
}

function renderInline(tokens: Token[], reveal?: Reveal): ReactNode[] {
  const rendered = new Array<ReactNode>(tokens.length);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    switch (token.type) {
      case 'text':
        rendered[index] = (
          <Fragment key={index}>{revealText((token as Tokens.Text).text, reveal)}</Fragment>
        );
        break;
      case 'escape':
        rendered[index] = (
          <Fragment key={index}>{revealText((token as Tokens.Escape).text, reveal)}</Fragment>
        );
        break;
      case 'strong':
        rendered[index] = (
          <strong key={index}>{renderInline((token as Tokens.Strong).tokens, reveal)}</strong>
        );
        break;
      case 'em':
        rendered[index] = <em key={index}>{renderInline((token as Tokens.Em).tokens, reveal)}</em>;
        break;
      case 'del':
        rendered[index] = (
          <del key={index}>{renderInline((token as Tokens.Del).tokens, reveal)}</del>
        );
        break;
      case 'codespan':
        rendered[index] = (
          <code key={index}>{revealText((token as Tokens.Codespan).text, reveal)}</code>
        );
        break;
      case 'br':
        rendered[index] = <br key={index} />;
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        // Unsupported schemes (`file:`, `javascript:`, relative paths) never
        // reach the DOM as a navigable href: middle-click and drag cannot
        // bypass the click handler if there is nothing to navigate to.
        rendered[index] = href ? (
          <a
            key={index}
            href={href}
            title={link.title ?? undefined}
            onClick={(event) => {
              event.preventDefault();
              void invoke('ui.openExternal', { url: href }).catch(() => undefined);
            }}
          >
            {renderInline(link.tokens, reveal)}
          </a>
        ) : (
          <span key={index} className="inert-link" title={link.title ?? undefined}>
            {renderInline(link.tokens, reveal)}
          </span>
        );
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        discardReveal(reveal);
        // Remote images are not loaded; the alt text is shown instead.
        rendered[index] = (
          <span key={index} className="image-placeholder">
            [image: {image.text || image.href}]
          </span>
        );
        break;
      }
      case 'html':
        rendered[index] = (
          <Fragment key={index}>{revealText((token as Tokens.HTML).raw, reveal)}</Fragment>
        );
        break;
      default:
        rendered[index] = (
          <Fragment key={index}>
            {'raw' in token ? revealText(String(token.raw), reveal) : null}
          </Fragment>
        );
    }
  }
  return rendered;
}

function revealText(text: string, reveal?: Reveal): ReactNode {
  if (!reveal || reveal.remaining <= 0 || text.length === 0) return text;
  const count = Math.min(text.length, reveal.remaining);
  reveal.remaining -= count;
  const split = text.length - count;
  return (
    <>
      {text.slice(0, split)}
      <span key={reveal.revision} className="stream-token">
        {text.slice(split)}
      </span>
    </>
  );
}

function discardReveal(reveal?: Reveal): void {
  if (reveal) reveal.remaining = 0;
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
