import { useEffect, useMemo, useState } from 'react';
import { cmp, familyOf, routeLabel, type GraphNode, type Store } from '../data.ts';
import { GraphView, type GEdge, type GNode } from '../graph.tsx';
import { Empty, Ev, Inferred, Method, NodeLink, SectionHead, SnippetView, Sub, href, useStore, type Route } from '../ui.tsx';

function chainOf(s: Store, ep: GraphNode) {
  const handler = s.handler(ep.id);
  const mw = s.outs(ep.id, ['middleware-chain']).sort((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0));
  const deps = [...s.outs(ep.id, ['injects']), ...(handler && handler.id !== ep.id ? s.outs(handler.id, ['injects']) : [])];
  const resp = s.outs(ep.id, ['validates', 'serializes']);
  const req = handler && handler.id !== ep.id ? s.outs(handler.id, ['validates', 'serializes']) : [];
  const callers = s.ins(ep.id, ['http']);
  return { handler, mw, deps, req, resp, callers };
}

export function Api({ route }: { route: Route }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const endpoints = useMemo(() => s.d.graph.nodes.filter((n) => n.kind === 'endpoint').sort((a, b) => cmp(a.meta.http?.fullPath ?? a.meta.http?.pathTemplate ?? '', b.meta.http?.fullPath ?? b.meta.http?.pathTemplate ?? '') || cmp(a.id, b.id)), [s]);
  const pages = useMemo(() => s.d.graph.nodes.filter((n) => n.kind === 'route').sort((a, b) => cmp(a.label, b.label)), [s]);
  const t = q.trim().toLowerCase();
  const shown = endpoints.filter((n) => !t || routeLabel(n).toLowerCase().includes(t) || (s.handler(n.id)?.label ?? '').toLowerCase().includes(t));
  const sel = route.param ? s.node(route.param) : undefined;
  useEffect(() => { if (sel) document.getElementById('api-detail')?.scrollIntoView({ block: 'start' }); }, [sel]);
  return (
    <section aria-labelledby="sec-api">
      <SectionHead num={8} title="API / Routes Reference" slug="api"><span className="pill neutral">{endpoints.length} endpoints · {pages.length} pages</span></SectionHead>
      {sel && (sel.kind === 'endpoint' || sel.kind === 'route') ? <EndpointDetail n={sel} low={low} /> : null}
      <div className="toolbar">
        <input type="search" placeholder="Filter by path or handler" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter endpoints" />
        <label><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> show low-confidence frontend links</label>
      </div>
      {endpoints.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Method</th><th>Path</th><th>Handler</th><th>Middleware / guards / deps</th><th>Schemas</th><th>Called from</th></tr></thead>
          <tbody>{shown.map((n) => {
            const c = chainOf(s, n);
            const h = n.meta.http!;
            const callers = c.callers.filter((e) => low || e.meta?.confidence !== 'low');
            return (
              <tr key={n.id} style={sel?.id === n.id ? { outline: '2px solid var(--accent)' } : undefined}>
                <td>{h.methods.map((m) => <Method key={m} m={m} />)}</td>
                <td><a className="mono" href={href('api', n.id)}>{h.fullPath ?? h.pathTemplate}</a>{h.fullPath ? null : <> <Inferred why="The mount prefix isn't a literal, so the full path is unknown." /></>}<div className="small muted">{n.meta.framework}</div></td>
                <td>{c.handler && c.handler.id !== n.id ? <NodeLink id={c.handler.id} /> : <span className="muted">—</span>}</td>
                <td className="small">{c.mw.map((e) => <div key={e.id}>{e.meta?.order !== undefined ? `${e.meta.order + 1}. ` : ''}<NodeLink id={e.target} />{e.inferred ? <Inferred /> : null}</div>)}{c.deps.map((e) => <div key={e.id}>deps: <NodeLink id={e.target} /></div>)}</td>
                <td className="small">{c.req.map((e) => <div key={e.id}>in: <NodeLink id={e.target} /></div>)}{c.resp.map((e) => <div key={e.id}>out: <NodeLink id={e.target} /></div>)}</td>
                <td className="small">{callers.map((e) => <div key={e.id}><NodeLink id={e.source} /> <span className={`pill ${e.meta?.confidence === 'high' ? 'ok' : 'inferred'}`} title="HTTP links are inferred by matching URL templates; confidence says how exact the match was.">{e.meta?.confidence}</span></div>)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <Empty>No HTTP endpoints were detected (Express, Fastify, Nest, Next route handlers, Django, DRF, FastAPI, Flask).</Empty>}
      {pages.length ? (
        <>
          <Sub id="pages" slug="api">Pages</Sub>
          <table><tbody>{pages.map((p) => { const comp = s.handler(p.id); return <tr key={p.id}><td className="mono"><a href={href('api', p.id)}>{p.label}</a></td><td>{comp && comp.id !== p.id ? <NodeLink id={comp.id} /> : null}</td><td className="small muted">{p.path}</td></tr>; })}</tbody></table>
        </>
      ) : null}
      <p className="note">Request/response schemas come from Pydantic/DRF/validation edges when the code declares them. "in" is a handler parameter; "out" is a response model or serializer.</p>
    </section>
  );
}

function EndpointDetail({ n, low }: { n: GraphNode; low: boolean }) {
  const s = useStore();
  const c = chainOf(s, n);
  const h = c.handler && c.handler.id !== n.id ? c.handler : undefined;
  return (
    <div className="card" id="api-detail" style={{ marginBottom: 18 }}>
      <h2 className="sub" style={{ marginTop: 0 }}>{routeLabel(n)}</h2>
      <p className="small">{n.path ? <Ev path={n.path} line={n.line ?? 1} /> : null} {h ? <>→ handler <NodeLink id={h.id} /></> : null}</p>
      {c.mw.length ? <p className="small">Chain: {c.mw.map((e) => <span key={e.id}><NodeLink id={e.target} /> → </span>)}{h ? <NodeLink id={h.id} /> : 'handler'}</p> : null}
      {c.callers.filter((e) => low || e.meta?.confidence !== 'low').length ? <p className="small">Frontend callers: {c.callers.filter((e) => low || e.meta?.confidence !== 'low').map((e) => <span key={e.id}><NodeLink id={e.source} /> ({e.meta?.confidence}) {e.evidence?.[0] ? <Ev path={e.evidence[0].path} line={e.evidence[0].line} /> : null} </span>)}</p> : null}
      {h?.path ? <SnippetView path={h.path} line={h.line ?? 1} {...(h.endLine ? { endLine: h.endLine } : {})} /> : n.path ? <SnippetView path={n.path} line={n.line ?? 1} /> : null}
    </div>
  );
}

const isModel = (n: GraphNode) => n.kind === 'model' || n.meta.role === 'model' || n.meta.role === 'abstract-model';
const isSchema = (n: GraphNode) => n.meta.role === 'schema' || n.meta.role === 'serializer';

/** Endpoints whose handler (or something it calls, up to 3 hops) has the edge to the model. */
function endpointsTouching(s: Store, modelId: string, kind: 'reads-model' | 'writes-model') {
  const res: { ep: GraphNode; inferred: boolean }[] = [];
  for (const e of s.ins(modelId, [kind])) {
    const seen = new Set([e.source]);
    let frontier = [e.source];
    for (let d = 0; d < 4 && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const ep of s.endpointsOf(f)) res.push({ ep, inferred: !!e.inferred || d > 0 });
        for (const x of s.ins(f, ['calls', 'injects'])) if (!seen.has(x.source)) { seen.add(x.source); next.push(x.source); }
      }
      frontier = next;
    }
  }
  const uniq = new Map<string, { ep: GraphNode; inferred: boolean }>();
  for (const r of res) { const p = uniq.get(r.ep.id); if (!p || (p.inferred && !r.inferred)) uniq.set(r.ep.id, r); }
  return [...uniq.values()].sort((a, b) => cmp(a.ep.id, b.ep.id));
}

export function Models({ route }: { route: Route }) {
  const s = useStore();
  const models = useMemo(() => s.d.graph.nodes.filter(isModel).sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id)), [s]);
  const schemas = useMemo(() => s.d.graph.nodes.filter(isSchema).sort((a, b) => cmp(a.label, b.label)), [s]);
  const er = useMemo(() => {
    const ids = new Set(models.map((m) => m.id));
    const nodes: GNode[] = models.map((m) => ({ id: m.id, label: m.label, sub: (m.meta.fields ?? []).slice(0, 4).map((f) => f.name).join(', ') + ((m.meta.fields?.length ?? 0) > 4 ? ' …' : ''), family: familyOf(m), focus: route.param === m.id }));
    const edges: GEdge[] = s.d.graph.edges.filter((e) => e.kind === 'model-relation' && ids.has(e.source) && ids.has(e.target)).map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind, ...(e.inferred ? { inferred: true } : {}) }));
    return { nodes, edges };
  }, [models, s, route.param]);
  useEffect(() => { if (route.param) document.getElementById(`m-${route.param}`)?.scrollIntoView({ block: 'start' }); }, [route.param]);
  return (
    <section aria-labelledby="sec-models">
      <SectionHead num={9} title="Data Models" slug="models"><span className="pill neutral">{models.length} models · {schemas.length} schemas</span></SectionHead>
      {models.length ? (
        <>
          <p className="note">ER diagram: arrows are relations (foreign key, one-to-one, many-to-many, relationship()). Click a model to jump to it.</p>
          <div className="mini" style={{ height: 380 }}><GraphView nodes={er.nodes} edges={er.edges} direction="DOWN" height={380} onNodeClick={(id) => { location.hash = href('models', id); }} /></div>
          {models.map((m) => {
            const reads = endpointsTouching(s, m.id, 'reads-model');
            const writes = endpointsTouching(s, m.id, 'writes-model');
            const direct = [...s.ins(m.id, ['reads-model']), ...s.ins(m.id, ['writes-model'])];
            return (
              <article key={m.id} id={`m-${m.id}`} className="card" style={{ marginTop: 14, ...(route.param === m.id ? { borderColor: 'var(--accent)' } : {}) }}>
                <h3 style={{ marginTop: 0 }}>{m.label} <span className="pill neutral">{m.meta.framework ?? m.lang}</span> {m.meta.role === 'abstract-model' ? <span className="pill neutral">abstract</span> : null} {m.path ? <Ev path={m.path} line={m.line ?? 1} /> : null}</h3>
                {m.meta.fields?.length ? <table><thead><tr><th>Field</th><th>Type</th><th>Relation</th></tr></thead><tbody>{m.meta.fields.map((f) => <tr key={f.name}><td className="mono">{f.name}</td><td className="mono muted">{f.type}</td><td className="small">{f.relation ?? ''}</td></tr>)}</tbody></table> : <p className="muted small">No fields parsed.</p>}
                <div className="grid g2" style={{ marginTop: 8 }}>
                  <div><strong className="small">Read by endpoints</strong>{reads.length ? <ul className="small">{reads.map((r) => <li key={r.ep.id}><NodeLink id={r.ep.id} label={routeLabel(r.ep)} /> {r.inferred ? <Inferred why="Reached through a call chain or a session-based query whose model binding is heuristic." /> : null}</li>)}</ul> : <p className="muted small">None traced statically.</p>}</div>
                  <div><strong className="small">Written by endpoints</strong>{writes.length ? <ul className="small">{writes.map((r) => <li key={r.ep.id}><NodeLink id={r.ep.id} label={routeLabel(r.ep)} /> {r.inferred ? <Inferred why="Reached through a call chain or a session-based query whose model binding is heuristic." /> : null}</li>)}</ul> : <p className="muted small">None traced statically.</p>}</div>
                </div>
                {direct.length ? <p className="small muted">Direct ORM use in: {direct.map((e) => <span key={e.id}><NodeLink id={e.source} /> {e.kind === 'writes-model' ? '(write)' : '(read)'} </span>)}</p> : null}
              </article>
            );
          })}
        </>
      ) : <Empty>No ORM models were detected (Django, SQLAlchemy, Prisma).</Empty>}
      {schemas.length ? (
        <>
          <Sub id="schemas" slug="models">Schemas and serializers</Sub>
          {schemas.map((m) => (
            <div key={m.id} id={`m-${m.id}`} className="card" style={{ marginTop: 10 }}>
              <h3 style={{ marginTop: 0 }}>{m.label} <span className="pill neutral">{m.meta.framework} {m.meta.role}</span> {m.path ? <Ev path={m.path} line={m.line ?? 1} /> : null}</h3>
              <p className="small mono">{(m.meta.fields ?? []).map((f) => `${f.name}: ${f.type}`).join(' · ') || 'no fields parsed'}</p>
              <p className="small">{s.outs(m.id, ['serializes']).map((e) => <span key={e.id}>serializes <NodeLink id={e.target} /> </span>)}{s.ins(m.id, ['validates', 'serializes']).map((e) => <span key={e.id}>used by <NodeLink id={e.source} /> </span>)}</p>
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}
