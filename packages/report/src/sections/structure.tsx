import { useEffect, useMemo, useState } from 'react';
import { cmp, groupPath, structuralSummary, type GraphNode, type Store } from '../data.ts';
import { Empty, Ev, Inferred, Meter, NodeLink, Refs, SectionHead, Sub, href, plural, useStore, type Route } from '../ui.tsx';

const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();

function TreeNode({ n, depth, openAll }: { n: GraphNode; depth: number; openAll: number }) {
  const s = useStore();
  const kids = useMemo(() => s.kids(n.id).filter((k) => k.kind === 'module-group' || k.kind === 'module')
    .sort((a, b) => (a.kind === b.kind ? cmp(a.id, b.id) : a.kind === 'module-group' ? -1 : 1)), [s, n.id]);
  const [open, setOpen] = useState(depth < 2);
  useEffect(() => { if (openAll) setOpen(openAll > 0); }, [openAll]);
  const isDir = n.kind !== 'module';
  const ex = n.kind === 'module' ? s.explainFile(n.id)?.oneLine : s.explainModule(n.id)?.purpose;
  const name = n.kind === 'project' ? (n.id.replace(/^[a-z]+:project:/, '') === '.' ? '(repo root)' : n.id.replace(/^[a-z]+:project:/, '')) : n.kind === 'module-group' ? `${groupPath(n.id).split('/').pop()}/` : n.path!.split('/').pop()!;
  return (
    <li>
      <div className="row-t">
        {isDir && kids.length ? <button className="tw" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button> : <span />}
        <a className="nm" href={href(n.kind === 'module' ? 'explorer' : n.kind === 'module-group' ? 'modules' : 'architecture', n.kind === 'project' ? undefined : n.id)}>{name}</a>
        <span className="ds">{ex ? firstSentence(ex) : <span className="muted" title="No Claude summary: derived from the graph">{structuralSummary(s, n)}</span>}</span>
      </div>
      {isDir && open && kids.length ? <ul>{kids.map((k) => <TreeNode key={k.id} n={k} depth={depth + 1} openAll={openAll} />)}</ul> : null}
    </li>
  );
}

export function DirectoryMap() {
  const s = useStore();
  const [openAll, setOpenAll] = useState(0);
  const roots = s.d.graph.nodes.filter((n) => n.kind === 'project').sort((a, b) => cmp(a.id, b.id));
  const g = s.d.explanations?.grounding.files;
  return (
    <section aria-labelledby="sec-directory">
      <SectionHead num={4} title="Directory Map" slug="directory">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <div className="toolbar">
        <button className="icon-btn" onClick={() => setOpenAll((x) => Math.abs(x) + 1)}>Expand all</button>
        <button className="icon-btn" onClick={() => setOpenAll((x) => -(Math.abs(x) + 1))}>Collapse all</button>
        <span className="note">Grey text is derived from the graph (no Claude summary for that entry).</span>
      </div>
      <ul className="tree">{roots.map((r) => <TreeNode key={r.id} n={r} depth={0} openAll={openAll} />)}</ul>
    </section>
  );
}

function subtreeModules(s: Store, gid: string): GraphNode[] {
  const out: GraphNode[] = [];
  const stack = [gid];
  while (stack.length) for (const k of s.kids(stack.pop()!)) { if (k.kind === 'module') out.push(k); else if (k.kind === 'module-group') stack.push(k.id); }
  return out;
}

function flowsTouching(s: Store, mods: Set<string>) {
  const ex = s.d.explanations?.flows;
  if (ex?.length) return ex.filter((f) => f.steps.some((st) => mods.has(s.moduleOf(st.nodeId) ?? ''))).map((f) => ({ id: f.id, title: f.title }));
  return s.d.analysis.flowCandidates.filter((f) => f.nodes.some((id) => mods.has(s.moduleOf(id) ?? ''))).map((f) => ({ id: f.id, title: f.title }));
}

export function Modules({ route }: { route: Route }) {
  const s = useStore();
  const groups = useMemo(() => s.d.graph.nodes.filter((n) => n.kind === 'module-group' && (s.explainModule(n.id) || s.kids(n.id).some((k) => k.kind === 'module'))).sort((a, b) => cmp(a.id, b.id)), [s]);
  const sel = route.param && s.node(route.param)?.kind === 'module-group' ? route.param : undefined;
  const g = s.d.explanations?.grounding.modules;
  return (
    <section aria-labelledby="sec-modules">
      <SectionHead num={6} title="Modules / Feature Areas" slug="modules">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <div className="split">
        <nav className="listbox" aria-label="Module groups">
          {groups.map((n) => (
            <button key={n.id} aria-selected={n.id === sel} onClick={() => { location.hash = href('modules', n.id); }}>
              <span className="nm">{groupPath(n.id)}/</span>
              <span className="pp">{s.explainModule(n.id) ? firstSentence(s.explainModule(n.id)!.purpose).slice(0, 90) : structuralSummary(s, n)}</span>
            </button>
          ))}
        </nav>
        <div>{sel ? <ModulePage gid={sel} /> : <Empty>Pick a folder on the left. Each page shows its purpose, key files, public API, what it depends on, what uses it, and the flows that pass through it.</Empty>}</div>
      </div>
    </section>
  );
}

function ModulePage({ gid }: { gid: string }) {
  const s = useStore();
  const ex = s.explainModule(gid);
  const mods = useMemo(() => subtreeModules(s, gid), [s, gid]);
  const modSet = useMemo(() => new Set(mods.map((m) => m.id)), [mods]);
  const deps = useMemo(() => {
    const out = new Map<string, number>(), inn = new Map<string, number>();
    const groupOf = (mid: string) => s.node(mid)?.parent ?? mid;
    for (const e of s.d.graph.edges) {
      if (!['imports', 'calls', 'renders', 'injects', 'http', 'uses-hook'].includes(e.kind)) continue;
      const a = s.moduleOf(e.source), b = s.moduleOf(e.target);
      if (!a || !b) continue;
      if (modSet.has(a) && !modSet.has(b)) out.set(groupOf(b), (out.get(groupOf(b)) ?? 0) + 1);
      if (!modSet.has(a) && modSet.has(b)) inn.set(groupOf(a), (inn.get(groupOf(a)) ?? 0) + 1);
    }
    const sort = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]));
    return { out: sort(out), inn: sort(inn) };
  }, [s, modSet]);
  const important = useMemo(() => Object.entries(s.d.analysis.symbols).filter(([id, m]) => m.fanIn > 0 && modSet.has(s.moduleOf(id) ?? '')).sort((a, b) => b[1].fanIn - a[1].fanIn || cmp(a[0], b[0])).slice(0, 10), [s, modSet]);
  const flows = flowsTouching(s, modSet);
  return (
    <article>
      <h2 className="sub" style={{ marginTop: 0 }}>{groupPath(gid)}/</h2>
      {ex ? <p className={`lede${ex.purposeInferred ? ' inferred-box' : ''}`}>{ex.purpose} {ex.purposeInferred ? <Inferred why="No key files were cited for this purpose." /> : null}</p> : <p className="muted">{structuralSummary(s, s.node(gid)!)}. No Claude summary for this folder.</p>}
      {ex?.responsibilities.length ? <><h3>Responsibilities</h3><ul className="prose">{ex.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul></> : null}
      {ex?.keyFiles.length ? <><h3>Key files</h3><p>{ex.keyFiles.map((k) => <span key={k}><NodeLink id={k} /> {' '}</span>)}</p></> : null}
      {ex?.publicApi.length ? <><h3>Public API</h3><p>{ex.publicApi.map((k) => <span key={k}><NodeLink id={k} /> {' '}</span>)}</p></> : null}
      <div className="grid g2">
        <div><h3>Depends on</h3>{deps.out.length ? <ul className="small">{deps.out.slice(0, 12).map(([id, n]) => <li key={id}><NodeLink id={id} /> <span className="muted">{plural(n, 'edge')}</span></li>)}</ul> : <p className="muted small">Nothing outside this folder.</p>}</div>
        <div><h3>Used by</h3>{deps.inn.length ? <ul className="small">{deps.inn.slice(0, 12).map(([id, n]) => <li key={id}><NodeLink id={id} /> <span className="muted">{plural(n, 'edge')}</span></li>)}</ul> : <p className="muted small">Nothing outside this folder uses it statically.</p>}</div>
      </div>
      <h3>Important functions</h3>
      {important.length ? <ul className="small">{important.map(([id, m]) => <li key={id}><NodeLink id={id} /> <span className="muted">fan-in {m.fanIn}</span> {s.explainSymbol(id) ? `· ${s.explainSymbol(id)}` : ''}</li>)}</ul> : <p className="muted small">No symbol here is referenced elsewhere.</p>}
      {ex?.gotchas.length ? <><h3>Gotchas</h3><ul className="prose">{ex.gotchas.map((g2, i) => <li key={i} className={g2.inferred ? 'inferred-box' : ''}>{g2.text} {g2.inferred ? <Inferred /> : <Refs refs={g2.refs} evidence={g2.evidence} />}</li>)}</ul></> : null}
      <h3>Related flows</h3>
      {flows.length ? <ul>{flows.map((f) => <li key={f.id}><a href={href('flows', f.id)}>{f.title}</a></li>)}</ul> : <p className="muted small">No traced flow passes through here.</p>}
      <h3>Files</h3>
      <ul className="small">{mods.sort((a, b) => cmp(a.id, b.id)).map((m) => <li key={m.id}><NodeLink id={m.id} /> {s.explainFile(m.id)?.oneLine ?? <span className="muted">{structuralSummary(s, m)}</span>}</li>)}</ul>
      {ex?.openQuestions.length ? <><h3>Open questions</h3><ul className="prose">{ex.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></> : null}
    </article>
  );
}

export function Health() {
  const s = useStore();
  const a = s.d.analysis;
  const table = (rows: { id: string; value: number }[], unit: string) => rows.length ? (
    <table><tbody>{rows.map((r) => <tr key={r.id}><td><NodeLink id={r.id} /></td><td className="mono" style={{ textAlign: 'right' }}>{r.value} {unit}</td></tr>)}</tbody></table>
  ) : <p className="muted small">None.</p>;
  const [untestedAll, setUntestedAll] = useState(false);
  return (
    <section aria-labelledby="sec-health">
      <SectionHead num={14} title="Health & Hotspots" slug="health"><span className="pill neutral">deterministic</span></SectionHead>
      <div className="grid g2">
        <div className="card"><h3 style={{ marginTop: 0 }}>Highest fan-in (risky to change)</h3>{table(a.hotspots.fanIn, 'dependents')}</div>
        <div className="card"><h3 style={{ marginTop: 0 }}>Largest files</h3>{table(a.hotspots.largestFiles, 'lines')}</div>
        <div className="card"><h3 style={{ marginTop: 0 }}>Largest functions</h3>{table(a.hotspots.largestFunctions, 'lines')}</div>
        <div className="card"><h3 style={{ marginTop: 0 }}>Highest complexity</h3>{table(a.hotspots.complexity, 'cyclomatic')}</div>
      </div>
      <Sub id="cycles" slug="health">Circular imports</Sub>
      {a.cycles.length ? <ul>{a.cycles.map((c, i) => <li key={i}>{c.map((id) => <span key={id}><NodeLink id={id} /> ↔ </span>)}<span className="muted small">({c.length} files)</span></li>)}</ul> : <p className="muted">No import cycles.</p>}
      <Sub id="unused" slug="health">Unused-export candidates</Sub>
      <p className="muted small prose">Exports with no static reference. They're <strong>candidates</strong>: dynamic imports, reflection, string-based registration or external consumers can still use them. Framework convention files (pages, routes, migrations, settings, <code>__init__</code>) are excluded.</p>
      {a.unusedExports.length ? <ul className="small">{a.unusedExports.map((u) => <li key={u.id}><NodeLink id={u.id} /> <span className="muted">{u.reason}</span></li>)}</ul> : <p className="muted">None found.</p>}
      {a.unreferencedModules.length ? <><h3>Unreferenced modules</h3><ul className="small">{a.unreferencedModules.map((u) => <li key={u.id}><NodeLink id={u.id} /> <span className="muted">{u.reason}</span></li>)}</ul></> : null}
      <Sub id="untested" slug="health">Files with no tests nearby</Sub>
      <p className="muted small">No test file imports these ({a.untested.length}). Sorted by fan-in, so the riskiest come first.</p>
      <ul className="small">{(untestedAll ? a.untested : a.untested.slice(0, 40)).map((id) => <li key={id}><NodeLink id={id} /> <span className="muted">fan-in {a.modules[id]?.fanIn ?? 0}</span></li>)}</ul>
      {a.untested.length > 40 && !untestedAll ? <button className="icon-btn" onClick={() => setUntestedAll(true)}>Show all {a.untested.length}</button> : null}
    </section>
  );
}

export function ConfigEnv({ route }: { route: Route }) {
  const s = useStore();
  const envs = s.d.graph.nodes.filter((n) => n.kind === 'env-var').sort((a, b) => cmp(a.label, b.label));
  const example = new Map(s.d.analysis.facts.envExample.map((e) => [e.name, e]));
  const flags = new Set(s.d.analysis.facts.featureFlags);
  useEffect(() => { if (route.param) document.getElementById(`env-${route.param}`)?.scrollIntoView({ block: 'center' }); }, [route.param]);
  const declaredOnly = [...example.keys()].filter((k) => !envs.some((e) => e.label === k)).sort(cmp);
  return (
    <section aria-labelledby="sec-config">
      <SectionHead num={10} title="Config & Environment" slug="config"><span className="pill neutral">names only, never values</span></SectionHead>
      <Sub id="env" slug="config">Environment variables</Sub>
      {envs.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Read at</th><th>In example file</th></tr></thead>
          <tbody>{envs.map((n) => {
            const reads = s.ins(n.id, ['reads-env']);
            return (
              <tr key={n.id} id={`env-${n.id}`} style={route.param === n.id ? { outline: '2px solid var(--accent)' } : undefined}>
                <td><code>{n.label}</code> {flags.has(n.id) ? <span className="pill neutral" title="Name looks like a feature flag">flag</span> : null} {reads.length && reads.every((e) => e.inferred) ? <Inferred why="Read through a settings class (e.g. Pydantic BaseSettings): the env name is derived from the field name." /> : null}</td>
                <td>{reads.map((e) => <div key={e.id}><NodeLink id={e.source} /> {(e.evidence ?? []).slice(0, 2).map((ev) => <Ev key={`${ev.path}:${ev.line}`} path={ev.path} line={ev.line} />)}</div>)}</td>
                <td>{example.has(n.label) ? <Ev path={example.get(n.label)!.path} line={example.get(n.label)!.line} /> : <span className="muted small">not declared</span>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <Empty>No environment variable reads were found (process.env, import.meta.env, os.environ, os.getenv, environ.Env, BaseSettings).</Empty>}
      {declaredOnly.length ? <p className="small">Declared in example files but not read in analyzed code: {declaredOnly.map((k) => <code key={k} style={{ marginRight: 8 }}>{k}</code>)}</p> : null}
      <Sub id="files" slug="config">Config files</Sub>
      {s.d.analysis.facts.configFiles.length ? (
        <table><tbody>{s.d.analysis.facts.configFiles.map((c) => <tr key={c.path}><td><Ev path={c.path} line={1} label={c.path} /></td><td>{c.controls}</td></tr>)}</tbody></table>
      ) : <p className="muted">None recognized.</p>}
      <Sub id="scripts" slug="config">Scripts</Sub>
      <p className="small muted">See <a href={href('run')}>Run It Locally</a> for every runnable command with its source line.</p>
      <p className="small muted">{plural(s.d.graph.nodes.filter((n) => n.kind === 'script').length, 'script')} declared in package.json / pyproject.</p>
    </section>
  );
}
