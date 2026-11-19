import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { editorUrl, familyOf, shortId, type GraphNode, type Snippet, type Store } from './data.ts';

export const StoreCtx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(StoreCtx);

// ---- hash router ------------------------------------------------------------------------
export interface Route { section: string; param?: string; anchor?: string }
export function parseHash(h: string): Route {
  const [path = '', anchor] = h.replace(/^#\/?/, '').split('~');
  const [section = 'start', ...rest] = path.split('/');
  const param = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  return { section: section || 'start', ...(param ? { param } : {}), ...(anchor ? { anchor: decodeURIComponent(anchor) } : {}) };
}
export const href = (section: string, param?: string, anchor?: string) => `#/${section}${param ? `/${encodeURIComponent(param)}` : ''}${anchor ? `~${encodeURIComponent(anchor)}` : ''}`;
export function useRoute(): Route {
  const [r, setR] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setR(parseHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}
export const go = (h: string) => { if (location.hash !== h) location.hash = h; };

/** Where an entity lives in the report. */
export function nodeHref(n: GraphNode | undefined, id?: string): string {
  if (!n) return href('explorer', id);
  if (n.kind === 'endpoint' || n.kind === 'route') return href('api', n.id);
  if (n.kind === 'model' || ['model', 'abstract-model', 'schema', 'serializer'].includes(n.meta.role ?? '')) return href('models', n.id);
  if (n.kind === 'env-var') return href('config', n.id);
  if (n.kind === 'module-group') return href('modules', n.id);
  if (n.kind === 'project' || n.kind === 'workspace') return href('architecture');
  return href('explorer', n.id);
}

// ---- small components -------------------------------------------------------------------
export function NodeLink({ id, label, title }: { id: string; label?: string; title?: string }) {
  const s = useStore();
  const n = s.node(id);
  const fam = n ? familyOf(n) : 'util';
  return (
    <a className="chip" href={nodeHref(n, id)} title={title ?? id}>
      <span className="sw" style={{ background: `var(--f-${fam})` }} aria-hidden />
      {label ?? (n ? (n.kind === 'module' || n.kind === 'module-group' ? shortId(n.id) : n.label) : shortId(id))}
    </a>
  );
}

export function Ev({ path, line, label }: { path: string; line: number; label?: string }) {
  const { d } = useStore();
  return <a className="ev" href={editorUrl(d.meta, path, line)} title={`Open ${path}:${line} in your editor`}>{label ?? `${path}:${line}`}</a>;
}

export function Inferred({ why }: { why?: string }) {
  const tip = why ?? 'Not proven by the static analysis or a code citation. Treat as a lead, not a fact.';
  return <span className="pill inferred" title={tip} aria-label={`inferred: ${tip}`} tabIndex={0}>inferred</span>;
}

export function Refs({ refs, evidence, max = 6 }: { refs?: string[]; evidence?: { path: string; line: number }[]; max?: number }) {
  const items = [...(refs ?? []).map((r) => <NodeLink key={r} id={r} />), ...(evidence ?? []).map((e) => <Ev key={`${e.path}:${e.line}`} path={e.path} line={e.line} />)];
  if (!items.length) return null;
  return <span className="refs" style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 6, verticalAlign: 'baseline' }}>{items.slice(0, max)}{items.length > max ? <span className="muted small">+{items.length - max}</span> : null}</span>;
}

export function Meter({ pct, claims, label = 'grounded' }: { pct: number; claims: number; label?: string }) {
  if (!claims) return null;
  return (
    <span className={`meter${pct < 85 ? ' low' : ''}`} title={`${pct}% of ${claims} claims cite a node id or file:line`}>
      <span className="bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} ${pct}%`}><i style={{ width: `${pct}%` }} /></span>
      {pct}% {label}
    </span>
  );
}

export function CopyLink({ hash }: { hash: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy-link" aria-label="Copy link to this heading" title="Copy link" onClick={() => {
      const url = `${location.href.split('#')[0]}${hash}`;
      navigator.clipboard?.writeText(url).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }, () => { location.hash = hash; });
    }}>{done ? '✓' : '#'}</button>
  );
}

export function SectionHead({ num, title, slug, children }: { num: number; title: string; slug: string; children?: ReactNode }) {
  return (
    <header className="sec-head">
      <span className="num">{String(num).padStart(2, '0')}</span>
      <h1 id={`sec-${slug}`}>{title} <CopyLink hash={href(slug)} /></h1>
      <span className="spacer" />
      {children}
    </header>
  );
}

export function Sub({ id, slug, children }: { id: string; slug: string; children: ReactNode }) {
  return <h2 className="sub" id={`h-${id}`}>{children} <CopyLink hash={href(slug, undefined, id)} /></h2>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

export function Method({ m }: { m: string }) { return <span className="method">{m}</span>; }

export function SnippetView({ path, line, endLine, title }: { path: string; line: number; endLine?: number; title?: string }) {
  const { d } = useStore();
  const sn: Snippet | undefined = d.snippets[`${path}:${line}`];
  if (!d.meta.snippets) return <p className="muted small">Snippets are off for this report. <Ev path={path} line={line} /></p>;
  if (!sn) return <p className="muted small">No snippet embedded for <Ev path={path} line={line} />.</p>;
  const hiEnd = endLine && endLine - line < 15 ? endLine : line;
  return (
    <figure className="snippet" style={{ margin: 0 }}>
      <header>
        <span>{title ?? path}</span>
        <span>{sn.redacted ? <span className="redacted" title="Secret-looking values were replaced before embedding">{sn.redacted} redacted · </span> : null}<a href={editorUrl(d.meta, path, line)}>Open in editor ↗</a></span>
      </header>
      <pre aria-label={`${path} lines ${sn.start} to ${sn.start + sn.lines.length - 1}`}><code>
        {sn.lines.map((l, i) => {
          const no = sn.start + i;
          return <span key={no} className={`row${no >= line && no <= hiEnd ? ' hl' : ''}`}><span className="ln">{no}</span>{l}{'\n'}</span>;
        })}
      </code></pre>
    </figure>
  );
}

export function Lang({ n }: { n: GraphNode }) { return <span className="lang">{n.lang}</span>; }

export const plural = (n: number, w: string, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
