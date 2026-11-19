import { useEffect, useMemo, useState } from 'react';
import { familyOf, routeLabel, shortId, type Store } from '../data.ts';
import { GraphView, type GEdge, type GNode } from '../graph.tsx';
import { Empty, Ev, Inferred, Meter, NodeLink, Refs, SectionHead, SnippetView, href, useStore, type Route } from '../ui.tsx';

const FLOW_KINDS = ['middleware-chain', 'handles', 'injects', 'calls', 'validates', 'serializes', 'reads-model', 'writes-model', 'fetches', 'http', 'renders', 'uses-hook', 'invokes-server-action'];

export interface ViewStep { order: number; nodeId: string; via?: string; parent?: string; summary: string; dataIn?: string; dataOut?: string; evidence: { path: string; line: number }[]; inferred?: boolean; inferredWhy?: string }
export interface ViewFlow {
  id: string; title: string; category?: string; story: string; entry: string; steps: ViewStep[]; graphOnly: boolean;
  externalBoundaries: { kind: string; name: string; refs: string[]; evidence: { path: string; line: number }[]; inferred?: boolean }[]; openQuestions: string[];
}

/** Deterministic trace for a candidate: DFS from the entry in the spec's edge priority (no LLM). */
function graphSteps(s: Store, entry: string, allowed: Set<string>): ViewStep[] {
  const steps: ViewStep[] = [];
  const seen = new Set<string>();
  const visit = (id: string, via?: string, parent?: string, ev?: { path: string; line: number }, inferred?: boolean) => {
    if (seen.has(id) || steps.length >= 15) return;
    seen.add(id);
    const n = s.node(id);
    const where = n?.path ? ` in ${n.path}` : '';
    steps.push({
      order: steps.length + 1, nodeId: id, ...(via ? { via } : {}), ...(parent ? { parent } : {}),
      summary: !via ? `Starts at ${n ? (n.kind === 'endpoint' || n.kind === 'route' ? routeLabel(n) : n.label) : shortId(id)}${where}.` : `${via.replace(/-/g, ' ')} → ${n?.label ?? shortId(id)} (${n?.kind ?? 'node'})${where}.`,
      evidence: ev ? [ev] : n?.path ? [{ path: n.path, line: n.line ?? 1 }] : [],
      ...(inferred ? { inferred: true, inferredWhy: 'The graph edge itself is heuristic (e.g. an HTTP link or a session-based ORM call).' } : {}),
    });
    for (const k of FLOW_KINDS) {
      const es = s.outs(id, [k]).filter((e) => allowed.has(e.target)).sort((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0) || (a.target < b.target ? -1 : 1));
      for (const e of es) visit(e.target, k, id, e.evidence?.[0], e.inferred);
    }
  };
  visit(entry);
  return steps;
}

export function useFlows(): ViewFlow[] {
  const s = useStore();
  return useMemo(() => {
    const ex = s.d.explanations?.flows ?? [];
    const byId = new Map(ex.map((f) => [f.id, f]));
    const flows: ViewFlow[] = [];
    for (const c of s.d.analysis.flowCandidates) {
      const f = byId.get(c.id);
      if (f) { byId.delete(c.id); flows.push(fromExplained(s, f, c.category)); continue; }
      flows.push({
        id: c.id, title: c.title, category: c.category, entry: c.entry, graphOnly: true,
        story: `Graph-only trace (no Claude story for this flow): ${c.reason}.`,
        steps: graphSteps(s, c.entry, new Set(c.nodes)), externalBoundaries: [], openQuestions: [],
      });
    }
    for (const f of byId.values()) flows.push(fromExplained(s, f, f.category ?? 'requested'));
    return flows;
  }, [s]);
}

function fromExplained(s: Store, f: NonNullable<Store['d']['explanations']>['flows'][number], category?: string): ViewFlow {
  const steps: ViewStep[] = f.steps.map((st, i) => {
    // Parent = the latest earlier step with a graph edge into this one (else the previous step).
    let parent = i ? f.steps[i - 1]!.nodeId : undefined;
    for (let j = i - 1; j >= 0; j--) if (s.outs(f.steps[j]!.nodeId).some((e) => e.target === st.nodeId)) { parent = f.steps[j]!.nodeId; break; }
    return { ...st, ...(parent ? { parent } : {}) };
  });
  return { id: f.id, title: f.title, ...(category ? { category } : {}), story: f.story, entry: f.entry, steps, graphOnly: false, externalBoundaries: f.externalBoundaries, openQuestions: f.openQuestions };
}

export function Flows({ route }: { route: Route }) {
  const s = useStore();
  const flows = useFlows();
  const current = flows.find((f) => f.id === route.param) ?? flows[0];
  const g = s.d.explanations?.grounding.flows;
  return (
    <section aria-labelledby="sec-flows">
      <SectionHead num={5} title="Key Flows" slug="flows">
        {g ? <Meter pct={g.pct} claims={g.claims} /> : null}
        {s.d.explanations ? <Meter pct={s.d.explanations.flowSteps.pct} claims={s.d.explanations.flowSteps.total} label="steps backed" /> : null}
      </SectionHead>
      {!flows.length ? <Empty>No flows: the analyzer found no endpoint, page, server action or job with downstream code to trace.</Empty> : (
        <>
          <div className="flow-list" role="toolbar" aria-label="Flows">
            {flows.map((f) => (
              <button key={f.id} className="flow-tab" aria-pressed={f.id === current?.id} onClick={() => { location.hash = href('flows', f.id); }}>
                <span className="cat">{f.category ?? 'flow'}{f.graphOnly ? ' · graph only' : ''}</span>{f.title}
              </button>
            ))}
          </div>
          {current ? <FlowView key={current.id} f={current} /> : null}
        </>
      )}
    </section>
  );
}

function FlowView({ f }: { f: ViewFlow }) {
  const s = useStore();
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<'diagram' | 'sequence'>('diagram');
  const n = f.steps.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') { setI((x) => Math.min(x + 1, n - 1)); setPlaying(false); }
      if (e.key === 'ArrowLeft') { setI((x) => Math.max(x - 1, 0)); setPlaying(false); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [n]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setI((x) => { if (x >= n - 1) { setPlaying(false); return x; } return x + 1; }), 1800);
    return () => clearInterval(t);
  }, [playing, n]);
  const step = f.steps[i];
  const { gnodes, gedges } = useMemo(() => {
    const ids = [...new Set(f.steps.map((x) => x.nodeId))];
    const activeId = f.steps[i]?.nodeId;
    const gnodes: GNode[] = ids.map((id) => {
      const nd = s.node(id);
      const st = f.steps.find((x) => x.nodeId === id)!;
      return { id, label: `${st.order}. ${nd ? (nd.kind === 'endpoint' || nd.kind === 'route' ? routeLabel(nd) : nd.label) : shortId(id)}`, sub: nd?.path ?? '', family: nd ? familyOf(nd) : 'util', ...(st.inferred ? { inferred: true } : {}), ...(nd?.meta.runtime && nd.meta.runtime !== 'server' ? { runtime: nd.meta.runtime } : {}), active: id === activeId, dim: false };
    });
    const gedges: GEdge[] = f.steps.filter((x) => x.parent).map((x) => ({ id: `${x.parent}>${x.nodeId}`, source: x.parent!, target: x.nodeId, kind: x.via ?? 'calls', label: x.via ?? '', ...(x.inferred ? { inferred: true } : {}), active: x.nodeId === activeId }));
    return { gnodes, gedges };
  }, [f, i, s]);
  const ev = step?.evidence[0];
  const nd = step ? s.node(step.nodeId) : undefined;
  return (
    <div>
      <p className="prose">{f.story}</p>
      <p className="small">Entry: <NodeLink id={f.entry} /></p>
      <div className="player" role="group" aria-label="Step-through controls">
        <button className="icon-btn" onClick={() => { setI(Math.max(0, i - 1)); setPlaying(false); }} disabled={i === 0}><span aria-hidden>← </span>Prev</button>
        <button className="icon-btn" onClick={() => { if (i >= n - 1) setI(0); setPlaying(!playing); }} aria-pressed={playing}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <button className="icon-btn" onClick={() => { setI(Math.min(n - 1, i + 1)); setPlaying(false); }} disabled={i >= n - 1}>Next<span aria-hidden> →</span></button>
        <span className="pos" aria-live="polite">Step {i + 1} of {n}</span>
        <span className="note">Keys: <kbd>←</kbd> <kbd>→</kbd></span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" aria-pressed={view === 'diagram'} onClick={() => setView('diagram')}>Diagram</button>
        <button className="icon-btn" aria-pressed={view === 'sequence'} onClick={() => setView('sequence')}>Sequence</button>
      </div>
      {view === 'diagram'
        ? <div className="diagram"><GraphView nodes={gnodes} edges={gedges} direction="RIGHT" height={380} onNodeClick={(id) => { const k = f.steps.findIndex((x) => x.nodeId === id); if (k >= 0) { setI(k); setPlaying(false); } }} /></div>
        : <Sequence f={f} active={i} onPick={(k) => { setI(k); setPlaying(false); }} />}
      <div className="flow-layout" style={{ marginTop: 14 }}>
        <div>
          <ol className="steps" aria-label="Steps">
            {f.steps.map((x, k) => (
              <li key={k} aria-current={k === i ? 'step' : undefined} onClick={() => { setI(k); setPlaying(false); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setI(k); } }} tabIndex={0} className={x.inferred ? 'inferred-box' : ''}>
                <span className="via">{x.order}. {x.via ?? 'entry'}</span> {x.summary} {x.inferred ? <Inferred {...(x.inferredWhy ? { why: x.inferredWhy } : {})} /> : null}
              </li>
            ))}
          </ol>
        </div>
        <aside aria-live="polite">
          {step ? (
            <div className="card">
              <div className="eyebrow" style={{ marginTop: 0 }}>Step {step.order}{step.via ? ` · via ${step.via}` : ''}</div>
              <p style={{ marginTop: 0 }}><NodeLink id={step.nodeId} /> {step.inferred ? <Inferred {...(step.inferredWhy ? { why: step.inferredWhy } : {})} /> : null}</p>
              <p>{step.summary}</p>
              {step.dataIn ? <p className="small"><strong>Data in:</strong> <code>{step.dataIn}</code></p> : null}
              {step.dataOut ? <p className="small"><strong>Data out:</strong> <code>{step.dataOut}</code></p> : null}
              {!step.dataIn && !step.dataOut && nd?.meta.signature ? <p className="small"><strong>Signature:</strong> <code>{nd.meta.signature}</code></p> : null}
              {step.evidence.length ? <p className="small">Evidence: {step.evidence.map((e, k) => <span key={`${e.path}:${e.line}`}>{k ? ' · ' : ''}<Ev path={e.path} line={e.line} /></span>)}</p> : <p className="small muted">No file:line evidence.</p>}
              {ev ? <SnippetView path={ev.path} line={ev.line} /> : nd?.path ? <SnippetView path={nd.path} line={nd.line ?? 1} {...(nd.endLine ? { endLine: nd.endLine } : {})} /> : null}
            </div>
          ) : null}
          {f.externalBoundaries.length ? (
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 0 }}>External boundaries</h3>
              <ul className="small">{f.externalBoundaries.map((b, k) => <li key={k}><span className="pill neutral">{b.kind}</span> {b.name} {b.inferred ? <Inferred /> : <Refs refs={b.refs} evidence={b.evidence} />}</li>)}</ul>
            </div>
          ) : null}
          {f.openQuestions.length ? <div className="card" style={{ marginTop: 12 }}><h3 style={{ marginTop: 0 }}>Open questions</h3><ul className="small">{f.openQuestions.map((q, k) => <li key={k}>{q}</li>)}</ul></div> : null}
        </aside>
      </div>
    </div>
  );
}

/** Sequence view: participants are modules; each step is a message from its parent's module. */
function Sequence({ f, active, onPick }: { f: ViewFlow; active: number; onPick: (i: number) => void }) {
  const s = useStore();
  const partOf = (id: string) => s.moduleOf(id) ?? s.projectOf(id)?.id ?? id;
  const parts: string[] = [];
  for (const st of f.steps) { const p = partOf(st.nodeId); if (!parts.includes(p)) parts.push(p); }
  const colW = 190, top = 56, rowH = 44;
  const W = Math.max(parts.length * colW, 400), H = top + f.steps.length * rowH + 30;
  const x = (p: string) => parts.indexOf(p) * colW + colW / 2;
  const name = (p: string) => { const n = s.node(p); const t = n?.path?.split('/').pop() ?? n?.label ?? shortId(p); return t.length > 24 ? `${t.slice(0, 22)}…` : t; };
  return (
    <div className="seq">
      <svg width={W} height={H} role="img" aria-label={`Sequence diagram for ${f.title}`}>
        <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="currentColor" /></marker></defs>
        {parts.map((p) => (
          <g key={p}>
            <rect x={x(p) - colW / 2 + 8} y={8} width={colW - 16} height={30} rx={6} fill="var(--paper-2)" stroke="var(--rule-2)" />
            <text x={x(p)} y={28} textAnchor="middle" fontSize={13}>{name(p)}</text>
            <line className="life" x1={x(p)} x2={x(p)} y1={38} y2={H - 10} />
          </g>
        ))}
        {f.steps.map((st, i) => {
          const to = partOf(st.nodeId), from = st.parent ? partOf(st.parent) : to;
          const y = top + i * rowH + 10;
          const cls = `msg${i === active ? ' active' : ''}${st.inferred ? ' inferred' : ''}`;
          const label = `${st.order}. ${s.node(st.nodeId)?.label ?? ''}`.slice(0, 34);
          return (
            <g key={i} style={{ cursor: 'pointer', color: i === active ? 'var(--accent)' : 'var(--ink-2)' }} onClick={() => onPick(i)}>
              {from === to
                ? <path className={cls} d={`M${x(from)},${y} h28 v16 h-24`} fill="none" markerEnd="url(#arr)" />
                : <line className={cls} x1={x(from)} y1={y + 8} x2={x(to) + (x(to) > x(from) ? -4 : 4)} y2={y + 8} markerEnd="url(#arr)" />}
              <text className={`lbl${i === active ? ' active' : ''}`} x={(from === to ? x(from) + 34 : Math.min(x(from), x(to)) + 8)} y={y + 2}>{label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
