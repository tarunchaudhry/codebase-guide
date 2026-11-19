import { useMemo, useState } from 'react';
import { cmp, familyOf, routeLabel, shortId, structuralSummary, type GraphNode, type Store } from '../data.ts';
import { GraphView, type GEdge, type GNode } from '../graph.tsx';
import { Empty, Ev, Inferred, Lang, Meter, NodeLink, SectionHead, SnippetView, href, useStore, type Route } from '../ui.tsx';
import { useFlows } from './flows.tsx';

const CALL_KINDS = ['calls', 'renders', 'uses-hook', 'injects', 'invokes-server-action', 'handles', 'middleware-chain'];
const SYMBOL_KINDS = new Set(['function', 'method', 'component', 'class']);

export function Explorer({ route }: { route: Route }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const all = useMemo(() => s.d.graph.nodes.filter((n) => SYMBOL_KINDS.has(n.kind) && !/^(anonymous|<)/.test(n.label)).sort((a, b) => (s.d.analysis.symbols[b.id]?.fanIn ?? 0) - (s.d.analysis.symbols[a.id]?.fanIn ?? 0) || cmp(a.id, b.id)), [s]);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return all.filter((n) => (kind === 'all' || n.kind === kind) && (!t || n.label.toLowerCase().includes(t) || (n.path ?? '').toLowerCase().includes(t))).slice(0, 400);
  }, [all, q, kind]);
  const sel = route.param ? s.node(route.param) : undefined;
  const g = s.d.explanations?.grounding.symbols;
  return (
    <section aria-labelledby="sec-explorer">
      <SectionHead num={7} title="Function & Call Explorer" slug="explorer">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <div className="split">
        <div>
          <div className="toolbar">
            <input type="search" placeholder="Filter by name or path" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter symbols" style={{ flex: 1 }} />
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="all">all</option><option value="function">functions</option><option value="method">methods</option><option value="component">components</option><option value="class">classes</option>
            </select>
          </div>
          <nav className="listbox" aria-label="Symbols">
            {list.map((n) => (
              <button key={n.id} aria-selected={n.id === sel?.id} onClick={() => { location.hash = href('explorer', n.id); }}>
                <span className="nm">{n.label}</span><span className="pp">{n.kind} · {n.path}{s.d.analysis.symbols[n.id]?.fanIn ? ` · fan-in ${s.d.analysis.symbols[n.id]!.fanIn}` : ''}</span>
              </button>
            ))}
            {list.length === 400 ? <p className="note" style={{ padding: 8 }}>Showing the first 400. Narrow the filter.</p> : null}
          </nav>
        </div>
        <div>{sel ? (sel.kind === 'module' ? <FileDetail n={sel} /> : <SymbolDetail n={sel} />) : <Empty>Pick a function, method, component or class. Use the top search for anything else.</Empty>}</div>
      </div>
    </section>
  );
}

function CallTree({ id, dir, depth, seen }: { id: string; dir: 'in' | 'out'; depth: number; seen: Set<string> }) {
  const s = useStore();
  const edges = (dir === 'in' ? s.ins(id, CALL_KINDS) : s.outs(id, CALL_KINDS)).sort((a, b) => cmp(dir === 'in' ? a.source : a.target, dir === 'in' ? b.source : b.target));
  if (!edges.length) return depth === 1 ? <p className="muted small">None found statically.</p> : null;
  return (
    <ul className="ctree">
      {edges.slice(0, 40).map((e) => {
        const other = dir === 'in' ? e.source : e.target;
        return <CallItem key={e.id} other={other} kind={e.kind} inferred={!!e.inferred} ev={e.evidence?.[0]} dir={dir} depth={depth} seen={seen} />;
      })}
      {edges.length > 40 ? <li className="muted small">+{edges.length - 40} more</li> : null}
    </ul>
  );
}

function CallItem({ other, kind, inferred, ev, dir, depth, seen }: { other: string; kind: string; inferred: boolean; ev?: { path: string; line: number } | undefined; dir: 'in' | 'out'; depth: number; seen: Set<string> }) {
  const [open, setOpen] = useState(false);
  const cyclic = seen.has(other);
  const canOpen = depth < 3 && !cyclic;
  return (
    <li>
      {canOpen ? <button className="tw icon-btn" style={{ padding: '0 5px', marginRight: 4, fontSize: 11 }} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>{open ? '−' : '+'}</button> : <span style={{ display: 'inline-block', width: 24 }} />}
      <NodeLink id={other} /> <span className="muted small">{kind}</span> {inferred ? <Inferred /> : null} {ev ? <Ev path={ev.path} line={ev.line} /> : null} {cyclic ? <span className="muted small">(cycle)</span> : null}
      {open ? <CallTree id={other} dir={dir} depth={depth + 1} seen={new Set([...seen, other])} /> : null}
    </li>
  );
}

function neighborhood(s: Store, id: string): { nodes: GNode[]; edges: GEdge[] } {
  const ids = new Set([id]);
  const edges: GEdge[] = [];
  for (const e of s.ins(id, CALL_KINDS).slice(0, 14)) { ids.add(e.source); edges.push({ id: e.id, source: e.source, target: e.target, kind: e.kind, ...(e.inferred ? { inferred: true } : {}) }); }
  for (const e of s.outs(id, [...CALL_KINDS, 'reads-model', 'writes-model', 'validates', 'http', 'reads-env']).slice(0, 18)) { ids.add(e.target); edges.push({ id: e.id, source: e.source, target: e.target, kind: e.kind, ...(e.inferred ? { inferred: true } : {}) }); }
  const nodes = [...ids].map((x) => { const n = s.node(x); return { id: x, label: n ? (n.kind === 'endpoint' ? routeLabel(n) : n.label) : shortId(x), sub: n?.path ?? '', family: n ? familyOf(n) : 'util' as const, focus: x === id }; });
  return { nodes, edges };
}

function relatedRoutes(s: Store, id: string): GraphNode[] {
  const out = new Set<string>();
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < 4 && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const ep of s.endpointsOf(f)) out.add(ep.id);
      for (const e of s.ins(f, ['calls', 'injects', 'renders', 'uses-hook'])) if (!seen.has(e.source)) { seen.add(e.source); next.push(e.source); }
    }
    frontier = next;
  }
  return [...out].map((x) => s.node(x)!).filter(Boolean).sort((a, b) => cmp(a.id, b.id));
}

function SymbolDetail({ n }: { n: GraphNode }) {
  const s = useStore();
  const flows = useFlows().filter((f) => f.steps.some((st) => st.nodeId === n.id));
  const nb = useMemo(() => neighborhood(s, n.id), [s, n.id]);
  const routes = useMemo(() => relatedRoutes(s, n.id), [s, n.id]);
  const m = s.d.analysis.symbols[n.id];
  const summary = s.explainSymbol(n.id);
  return (
    <article>
      <h2 className="sub" style={{ marginTop: 0 }}>{n.label} <span className="pill neutral">{n.kind}</span> <Lang n={n} />{n.meta.role ? <span className="pill neutral">{n.meta.framework ? `${n.meta.framework} ` : ''}{n.meta.role}</span> : null}</h2>
      <p className="small">{n.path ? <Ev path={n.path} line={n.line ?? 1} /> : null} {s.moduleOf(n.id) ? <>in <NodeLink id={s.moduleOf(n.id)!} /></> : null} {m ? <span className="muted">· fan-in {m.fanIn}, fan-out {m.fanOut}</span> : null}{n.meta.loc ? <span className="muted"> · {n.meta.loc} lines{n.meta.complexity ? `, complexity ${n.meta.complexity}` : ''}</span> : null}</p>
      {n.meta.signature ? <pre className="sig">{n.meta.signature}</pre> : null}
      {n.meta.doc ? <p className="prose" style={{ fontStyle: 'italic' }}>{n.meta.doc}</p> : null}
      <p className="prose">{summary ?? <span className="muted">No Claude summary for this symbol (only the most-used symbols per file get one).</span>}</p>
      {n.meta.decorators?.length ? <p className="small">Decorators: {n.meta.decorators.map((x) => <code key={x} style={{ marginRight: 6 }}>@{x}</code>)}</p> : null}
      {n.meta.fields?.length ? <><h3>Fields</h3><table><tbody>{n.meta.fields.map((f) => <tr key={f.name}><td className="mono">{f.name}</td><td className="mono muted">{f.type}</td><td className="small">{f.relation ?? ''}</td></tr>)}</tbody></table></> : null}
      <div className="grid g2">
        <div><h3>← Callers</h3><CallTree id={n.id} dir="in" depth={1} seen={new Set([n.id])} /></div>
        <div><h3>Callees →</h3><CallTree id={n.id} dir="out" depth={1} seen={new Set([n.id])} /></div>
      </div>
      <div className="toolbar"><h3 style={{ margin: 0 }}>Neighborhood</h3><span style={{ flex: 1 }} /><a className="icon-btn" href={href('canvas', n.id)}>Show in full canvas →</a></div>
      <div className="mini"><GraphView nodes={nb.nodes} edges={nb.edges} height={300} onNodeClick={(id) => { location.hash = href('explorer', id); }} /></div>
      <h3>Related routes</h3>
      {routes.length ? <ul className="small">{routes.map((r) => <li key={r.id}><NodeLink id={r.id} label={routeLabel(r)} /></li>)}</ul> : <p className="muted small">No endpoint reaches this statically.</p>}
      <h3>Related flows</h3>
      {flows.length ? <ul className="small">{flows.map((f) => <li key={f.id}><a href={href('flows', f.id)}>{f.title}</a></li>)}</ul> : <p className="muted small">Not part of a traced flow.</p>}
      {n.path ? <><h3>Code</h3><SnippetView path={n.path} line={n.line ?? 1} {...(n.endLine ? { endLine: n.endLine } : {})} /></> : null}
    </article>
  );
}

function FileDetail({ n }: { n: GraphNode }) {
  const s = useStore();
  const ex = s.explainFile(n.id);
  const syms = s.kids(n.id).filter((k) => SYMBOL_KINDS.has(k.kind) || k.kind === 'route-group').sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const imps = s.outs(n.id, ['imports', 'dynamic-imports']);
  const by = s.ins(n.id, ['imports', 'dynamic-imports']);
  const tests = s.ins(n.id, ['tests']);
  const m = s.d.analysis.modules[n.id];
  return (
    <article>
      <h2 className="sub" style={{ marginTop: 0 }}>{n.path} <Lang n={n} />{n.meta.role ? <span className="pill neutral">{n.meta.framework ? `${n.meta.framework} ` : ''}{n.meta.role}</span> : null}{n.meta.runtime ? <span className="pill neutral">{n.meta.runtime}</span> : null}</h2>
      <p className="prose">{ex?.oneLine ?? <span className="muted">{structuralSummary(s, n)} (no Claude summary).</span>}</p>
      {ex?.responsibilities.length ? <ul className="prose">{ex.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
      {m ? <p className="small muted">{m.loc} lines · fan-in {m.fanIn} · fan-out {m.fanOut} · {tests.length ? `${tests.length} test file(s)` : 'no tests import it'}</p> : null}
      <h3>Defines</h3>
      {syms.length ? <ul className="small">{syms.map((k) => <li key={k.id}><NodeLink id={k.id} /> <span className="muted">{k.kind} · line {k.line}</span> {s.explainSymbol(k.id) ?? ''}</li>)}</ul> : <p className="muted small">No named symbols.</p>}
      <div className="grid g2">
        <div><h3>Imports</h3>{imps.length ? <ul className="small">{imps.map((e) => <li key={e.id}><NodeLink id={e.target} /></li>)}</ul> : <p className="muted small">No local imports.</p>}</div>
        <div><h3>Imported by</h3>{by.length ? <ul className="small">{by.map((e) => <li key={e.id}><NodeLink id={e.source} /></li>)}</ul> : <p className="muted small">Not imported by analyzed code.</p>}</div>
      </div>
      {tests.length ? <><h3>Tests</h3><ul className="small">{tests.map((e) => <li key={e.id}><NodeLink id={e.source} /></li>)}</ul></> : null}
      <h3>Code</h3>
      <SnippetView path={n.path!} line={1} />
    </article>
  );
}
