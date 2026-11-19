import { useEffect, useMemo, useState } from 'react';
import { FAMILY_LABEL, cmp, familyOf, groupPath, routeLabel, type Family, type GraphNode, type Store } from '../data.ts';
import { GraphView, type GEdge, type GNode } from '../graph.tsx';
import { NodeLink, SectionHead, href, nodeHref, useStore, type Route } from '../ui.tsx';

const BUDGET = 800;
const CLUSTER_KINDS = new Set(['workspace', 'project', 'module-group', 'module', 'route-group']);
const ALL_EDGE_KINDS = ['imports', 'dynamic-imports', 'calls', 'renders', 'uses-hook', 'invokes-server-action', 'route-child', 'mounts', 'handles', 'middleware-chain', 'injects', 'model-relation', 'serializes', 'validates', 'reads-model', 'writes-model', 'reads-env', 'fetches', 'http', 'tests'];
const DEFAULT_KINDS = new Set(['imports', 'calls', 'renders', 'handles', 'injects', 'http', 'reads-model', 'writes-model', 'middleware-chain', 'mounts']);
const LEVEL_LABEL = ['L0 · projects', 'L1 · areas', 'L2 · files', 'L3 · symbols'];

function label(s: Store, n: GraphNode) {
  if (n.kind === 'project') return n.id.replace(/^[a-z]+:project:/, '') === '.' ? `${n.lang} project (root)` : n.id.replace(/^[a-z]+:project:/, '');
  if (n.kind === 'module-group') return `${groupPath(n.id)}/`;
  if (n.kind === 'module') return n.path?.split('/').pop() ?? n.label;
  if (n.kind === 'endpoint' || n.kind === 'route') return routeLabel(n);
  void s;
  return n.label;
}

/** Expand clusters breadth-first up to `level`, stopping before the visible count would pass the budget. */
function expandToLevel(s: Store, level: number): { expanded: Set<string>; collapsed: number } {
  const expanded = new Set<string>();
  const roots = s.d.graph.nodes.filter((n) => !n.parent);
  let visible = roots.length;
  let collapsed = 0;
  let frontier = roots.filter((n) => CLUSTER_KINDS.has(n.kind));
  // A project's root folder group is the project itself, so it sits at L0 too.
  const levelOf = (n: GraphNode) => (n.kind === 'project' || n.kind === 'workspace' || (n.kind === 'module-group' && s.node(n.parent ?? '')?.kind === 'project') ? 0 : n.kind === 'module-group' || n.kind === 'route-group' ? 1 : n.kind === 'module' ? 2 : 3);
  while (frontier.length) {
    const next: GraphNode[] = [];
    for (const c of frontier.sort((a, b) => cmp(a.id, b.id))) {
      // A lone child (repo/ → src/ → app/) carries no information, so it opens regardless of the level.
      const onlyChild = !!c.parent && s.kids(c.parent).filter((k) => CLUSTER_KINDS.has(k.kind)).length === 1;
      if (levelOf(c) >= level && !(c.kind === 'module-group' && level >= 2) && !onlyChild) continue;
      const kids = s.kids(c.id);
      if (!kids.length) continue;
      if (visible - 1 + kids.length > BUDGET) { collapsed++; continue; }
      expanded.add(c.id);
      visible += kids.length - 1;
      next.push(...kids.filter((k) => CLUSTER_KINDS.has(k.kind)));
    }
    frontier = next;
  }
  return { expanded, collapsed };
}

export function Canvas({ route }: { route: Route }) {
  const s = useStore();
  const [level, setLevel] = useState(1);
  const [{ expanded, collapsed }, setExp] = useState(() => expandToLevel(s, 1));
  const [kinds, setKinds] = useState<Set<string>>(DEFAULT_KINDS);
  const [langs, setLangs] = useState<Set<string>>(new Set(['ts', 'js', 'py']));
  const [fams, setFams] = useState<Set<Family>>(new Set(Object.keys(FAMILY_LABEL) as Family[]));
  const [conf, setConf] = useState<Set<string>>(new Set(['high', 'medium']));
  const [fw, setFw] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const frameworks = useMemo(() => [...new Set(s.d.graph.nodes.map((n) => n.meta.framework).filter((x): x is string => !!x))].sort(cmp), [s]);

  // Deep link: expand ancestors so the node is visible, then highlight it.
  useEffect(() => {
    if (!route.param || !s.node(route.param)) return;
    const chain: string[] = [];
    let n = s.node(route.param);
    while (n?.parent) { chain.push(n.parent); n = s.node(n.parent); }
    setExp((prev) => ({ expanded: new Set([...prev.expanded, ...chain]), collapsed: prev.collapsed }));
    setSelected(route.param);
  }, [route.param, s]);

  const view = useMemo(() => {
    const visible = new Map<string, GraphNode>();
    const walk = (n: GraphNode) => {
      if (expanded.has(n.id) && s.kids(n.id).length) { for (const k of s.kids(n.id)) walk(k); return; }
      if (!CLUSTER_KINDS.has(n.kind) || n.kind === 'route-group') {
        if (!langs.has(n.lang) || !fams.has(familyOf(n)) || (fw !== 'all' && n.meta.framework !== fw)) return;
      }
      visible.set(n.id, n);
    };
    for (const r of s.d.graph.nodes.filter((n) => !n.parent).sort((a, b) => cmp(a.id, b.id))) walk(r);
    const repOf = (id: string): string | null => {
      let n = s.node(id);
      while (n) { if (visible.has(n.id)) return n.id; n = n.parent ? s.node(n.parent) : undefined; }
      return null;
    };
    const agg = new Map<string, GEdge>();
    for (const e of s.d.graph.edges) {
      if (!kinds.has(e.kind)) continue;
      if (e.kind === 'http' && !conf.has(e.meta?.confidence ?? 'low')) continue;
      const a = repOf(e.source), b = repOf(e.target);
      if (!a || !b || a === b) continue;
      const k = `${a}|${b}|${e.kind}`;
      const prev = agg.get(k);
      if (prev) { prev.weight = (prev.weight ?? 1) + e.weight; if (!e.inferred) delete prev.inferred; }
      else agg.set(k, { id: k, source: a, target: b, kind: e.kind, weight: e.weight, ...(e.inferred ? { inferred: true } : {}), ...(e.meta?.confidence ? { confidence: e.meta.confidence } : {}) });
    }
    const nodes: GNode[] = [...visible.values()].map((n) => {
      const kids = s.kids(n.id).length;
      const isCluster = CLUSTER_KINDS.has(n.kind) && kids > 0;
      return {
        id: n.id, label: label(s, n), sub: isCluster ? `${kids} inside · click to expand` : n.kind === 'module' ? n.path ?? '' : `${n.kind}${n.path ? ` · ${n.path.split('/').pop()}` : ''}`,
        family: n.kind === 'project' || n.kind === 'module-group' ? 'util' : familyOf(n), cluster: isCluster,
        ...(n.meta.runtime === 'client' || n.meta.runtime === 'edge' ? { runtime: n.meta.runtime } : {}),
        ...(n.id === selected || n.id === route.param ? { focus: true } : {}),
      };
    });
    return { nodes, edges: [...agg.values()].sort((x, y) => cmp(x.id, y.id)) };
  }, [s, expanded, kinds, langs, fams, conf, fw, selected, route.param]);

  const toggle = (id: string) => {
    const n = s.node(id);
    if (!n) return;
    setSelected(id);
    if (!CLUSTER_KINDS.has(n.kind) || !s.kids(id).length) return;
    const kids = s.kids(id);
    if (view.nodes.length - 1 + kids.length > BUDGET) { alertBudget(); return; }
    const next = new Set(expanded);
    next.add(id);
    // Skip boring single-child chains (src/ → app/ → …).
    let only = kids.length === 1 && CLUSTER_KINDS.has(kids[0]!.kind) ? kids[0] : undefined;
    while (only && s.kids(only.id).length) { next.add(only.id); const k = s.kids(only.id); only = k.length === 1 && CLUSTER_KINDS.has(k[0]!.kind) ? k[0] : undefined; }
    setExp({ expanded: next, collapsed });
  };
  const [budgetMsg, setBudgetMsg] = useState(false);
  const alertBudget = () => { setBudgetMsg(true); setTimeout(() => setBudgetMsg(false), 3500); };
  const collapse = (id: string) => {
    const n = s.node(id);
    const parent = n?.parent;
    if (!parent) return;
    const next = new Set(expanded);
    const drop = (x: string) => { next.delete(x); for (const k of s.kids(x)) drop(k.id); };
    drop(parent);
    setExp({ expanded: next, collapsed });
    setSelected(parent);
  };
  const toggleIn = <T,>(set: Set<T>, v: T, f: (s: Set<T>) => void) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); f(n); };
  const sel = selected ? s.node(selected) : undefined;
  return (
    <section aria-labelledby="sec-canvas">
      <SectionHead num={15} title="Interactive Canvas" slug="canvas"><span className="pill neutral">{view.nodes.length} nodes · {view.edges.length} edges</span></SectionHead>
      <div className="toolbar">
        <label>Zoom level <select value={level} onChange={(e) => { const l = Number(e.target.value); setLevel(l); setExp(expandToLevel(s, l)); }}>{LEVEL_LABEL.map((l, i) => <option key={i} value={i}>{l}</option>)}</select></label>
        <button className="icon-btn" onClick={() => { setLevel(0); setExp(expandToLevel(s, 0)); }}>Collapse all</button>
        <label>Framework <select value={fw} onChange={(e) => setFw(e.target.value)}><option value="all">all</option>{frameworks.map((f) => <option key={f}>{f}</option>)}</select></label>
        <details className="filters"><summary>Edge kinds ({kinds.size})</summary><div className="opts">{ALL_EDGE_KINDS.map((k) => <label key={k}><input type="checkbox" checked={kinds.has(k)} onChange={() => toggleIn(kinds, k, setKinds)} />{k}</label>)}</div></details>
        <details className="filters"><summary>Language / role</summary><div className="opts">
          {['ts', 'js', 'py', 'config'].map((l) => <label key={l}><input type="checkbox" checked={langs.has(l)} onChange={() => toggleIn(langs, l, setLangs)} />{l}</label>)}
          {(Object.keys(FAMILY_LABEL) as Family[]).map((f) => <label key={f}><input type="checkbox" checked={fams.has(f)} onChange={() => toggleIn(fams, f, setFams)} />{FAMILY_LABEL[f]}</label>)}
        </div></details>
        <details className="filters"><summary>HTTP confidence</summary><div className="opts">{['high', 'medium', 'low'].map((c) => <label key={c}><input type="checkbox" checked={conf.has(c)} onChange={() => toggleIn(conf, c, setConf)} />{c}</label>)}</div></details>
      </div>
      <div className="legend" aria-label="Legend">
        {(Object.keys(FAMILY_LABEL) as Family[]).map((f) => <span key={f}><i style={{ borderColor: `var(--f-${f})` }} />{FAMILY_LABEL[f]}</span>)}
        <span>— dashed = inferred</span><span>ring = client/edge runtime</span>
      </div>
      {collapsed || budgetMsg ? <p className="note" role="status">Render budget is {BUDGET} nodes: {budgetMsg ? 'expanding that cluster would exceed it. Collapse something first or narrow the filters.' : `${collapsed} cluster(s) were left collapsed.`}</p> : null}
      <div className="canvas-wrap">
        <GraphView nodes={view.nodes} edges={view.edges} height="100%" onNodeClick={toggle} minimap />
        {sel ? (
          <div className="card" style={{ position: 'absolute', top: 10, right: 10, width: 300, zIndex: 5 }}>
            <div className="small muted">{sel.kind}{sel.path ? ` · ${sel.path}` : ''}</div>
            <div style={{ margin: '4px 0 8px' }}><NodeLink id={sel.id} label={label(s, sel)} /></div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <a className="icon-btn" href={nodeHref(sel)}>Open details</a>
              {sel.parent && s.node(sel.parent) ? <button className="icon-btn" onClick={() => collapse(sel.id)}>Collapse parent</button> : null}
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close">×</button>
            </div>
          </div>
        ) : null}
      </div>
      <p className="note">Click a cluster to expand it; click a leaf to select it. Edges are rolled up to the visible level and weighted by count. <a href={href('explorer')}>Explorer</a> shows callers/callees for one function.</p>
    </section>
  );
}
