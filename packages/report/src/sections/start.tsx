import { useMemo, useState } from 'react';
import { cmp, groupPath, shortId, type Store } from '../data.ts';
import { Empty, Ev, Inferred, Meter, NodeLink, Refs, SectionHead, Sub, href, plural, useStore } from '../ui.tsx';

export function StartHere() {
  const s = useStore();
  const { d } = s;
  const a = d.analysis;
  const arch = d.explanations?.architecture;
  const frameworks = [...new Set(d.graph.projects.flatMap((p) => p.frameworks))];
  const c = a.counts;
  const g = d.explanations?.grounding.overview;
  return (
    <section aria-labelledby="sec-start">
      <SectionHead num={1} title="Start Here" slug="start">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      {arch ? (
        <p className={`lede${arch.overview.inferred ? ' inferred-box' : ''}`}>{arch.overview.text} {arch.overview.inferred ? <Inferred /> : <Refs refs={arch.overview.refs} max={4} />}</p>
      ) : (
        <>
          <p className="lede">
            {d.meta.repoName} has {plural(c.projects!, 'project')}{frameworks.length ? ` using ${frameworks.join(', ')}` : ''}: {plural(c.files!, 'file')}, {plural(c.endpoints!, 'endpoint')}, {plural(c.pages!, 'page')} and {plural(c.models!, 'model')}.
          </p>
          <p className="muted small">This is the deterministic report (no LLM). Run <code>/codebase-guide</code> for the written overview, flow stories, conventions and recipes.</p>
        </>
      )}
      <Sub id="glance" slug="start">Repo at a glance</Sub>
      <div className="grid g4">
        {([['projects', 'Projects'], ['files', 'Files'], ['endpoints', 'Endpoints'], ['pages', 'Pages'], ['models', 'Models'], ['schemas', 'Schemas'], ['envVars', 'Env vars'], ['tests', 'Test files']] as const).map(([k, l]) => (
          <div className="card" key={k}><div className="stat">{(c[k] ?? 0).toLocaleString('en-US')}</div><div className="stat-l">{l}</div></div>
        ))}
      </div>
      <Sub id="stack" slug="start">Tech stack</Sub>
      {a.facts.stack.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Declared</th><th>Source</th></tr></thead>
          <tbody>{a.facts.stack.map((x) => (
            <tr key={x.name}><td className="mono">{x.name}</td><td className="muted">{x.kind}</td><td className="mono">{x.version ?? <span className="muted">—</span>}</td><td className="mono muted">{x.declared ?? ''}</td><td><Ev path={x.source.path} line={x.source.line} /></td></tr>
          ))}</tbody>
        </table></div>
      ) : <Empty>No known frameworks or libraries were found in package.json, pyproject.toml or requirements files.</Empty>}
      <p className="small muted">Detected frameworks (with code evidence): {d.graph.projects.map((p) => <span key={p.id}><NodeLink id={p.id} label={p.root === '.' ? `${p.lang} (root)` : p.root} /> {p.frameworks.join(', ') || 'none'}{'  '}</span>)}</p>
      <Sub id="reading" slug="start">Suggested reading order</Sub>
      <p className="muted small prose">Ranked by entry-point-ness × centrality (PageRank and fan-in over imports and calls), with a penalty for very long files. The order is computed, not written by Claude.</p>
      {a.readingOrder.length ? (
        <ol className="ol">
          {a.readingOrder.map((r) => {
            const m = a.modules[r.id];
            const polished = arch?.readingOrderReasons[r.id];
            return (
              <li key={r.id}>
                <div>
                  <NodeLink id={r.id} />
                  <div>{polished ?? r.reason}</div>
                  <div className="small muted">{polished ? `metrics: ${r.reason}` : ''}{m ? `${polished ? ' · ' : ''}fan-in ${m.fanIn}, fan-out ${m.fanOut}, ${m.loc} lines` : ''}</div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : <Empty>No source files to rank.</Empty>}
    </section>
  );
}

const RUN_ORDER = ['install', 'setup', 'service', 'migrate', 'dev', 'start', 'build', 'test', 'lint', 'other'];

export function RunLocally() {
  const s = useStore();
  const { d } = s;
  const facts = d.analysis.facts.run;
  const guided = d.explanations?.guide?.runLocally ?? [];
  const byKind = useMemo(() => RUN_ORDER.map((k) => [k, facts.filter((f) => f.kind === k)] as const).filter(([, xs]) => xs.length), [facts]);
  const g = d.explanations?.grounding.runLocally;
  return (
    <section aria-labelledby="sec-run">
      <SectionHead num={2} title="Run It Locally" slug="run">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <p className="prose muted">Every command below was found in a real file (package.json scripts, Makefile, docker-compose, Procfile, pyproject, manage.py, lockfiles or the README) and links to its line. Nothing is invented.</p>
      {guided.length ? (
        <>
          <Sub id="steps" slug="run">Steps</Sub>
          <ol className="ol">
            {guided.map((r, i) => (
              <li key={i}><div><div>{r.step}</div><CopyCmd cmd={r.command} /><div className="small"><Ev path={r.source.path} line={r.source.line} /></div></div></li>
            ))}
          </ol>
        </>
      ) : null}
      <Sub id="commands" slug="run">{guided.length ? 'All commands found' : 'Commands found'}</Sub>
      {!facts.length ? (
        <Empty>No run commands were found in package.json, Makefile, docker-compose, Procfile, pyproject, manage.py or the README. The report doesn't guess setup steps; ask a teammate and consider adding them to the README.</Empty>
      ) : byKind.map(([kind, xs]) => (
        <div key={kind}>
          <h3 style={{ textTransform: 'capitalize' }}>{kind}</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Command</th><th>Runs</th><th>Where</th><th>Source</th></tr></thead>
            <tbody>{xs.map((f, i) => (
              <tr key={i}>
                <td><CopyCmd cmd={f.command} /></td>
                <td className="mono small muted">{f.script ?? ''}{f.ports?.length ? ` · ports ${f.ports.join(', ')}` : ''}{f.section ? ` · README “${f.section}”` : ''}</td>
                <td className="mono small">{f.cwd === '.' ? 'repo root' : f.cwd}</td>
                <td><Ev path={f.source.path} line={f.source.line} /> <span className="muted small">{f.origin}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      ))}
      <Sub id="env" slug="run">Env vars you'll need</Sub>
      {d.analysis.facts.envExample.length ? (
        <p className="prose">Example files declare: {d.analysis.facts.envExample.map((e) => <span key={`${e.path}:${e.name}`}><code>{e.name}</code> <Ev path={e.path} line={e.line} label={`${e.path}:${e.line}`} />{'  '}</span>)}</p>
      ) : <p className="muted prose">No <code>.env.example</code>/<code>.env.sample</code>/<code>.env.template</code> found.</p>}
      <p className="prose small">{d.analysis.counts.envVars === 1 ? '1 env var is' : `${d.analysis.counts.envVars ?? 0} env vars are`} read in code. See <a href={href('config')}>Config &amp; Environment</a> for where each is read. Values are never shown.</p>
    </section>
  );
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [ok, setOk] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <code className="sig" style={{ padding: '3px 8px', display: 'inline-block' }}>{cmd}</code>
      <button className="icon-btn" style={{ padding: '1px 7px', fontSize: 12 }} title={`Copy: ${cmd}`} onClick={() => navigator.clipboard?.writeText(cmd).then(() => { setOk(true); setTimeout(() => setOk(false), 1000); })}>{ok ? '✓' : 'copy'}</button>
    </span>
  );
}

/** Lanes = layers; each lane lists the folders (module groups) its files live in, plus cross-layer dependency counts. */
function layerView(s: Store) {
  const layers = s.d.explanations?.architecture?.layers.length ? s.d.explanations.architecture.layers : s.d.analysis.layers;
  const layerOf = new Map<string, string>();
  for (const l of layers) for (const id of l.nodeIds) layerOf.set(s.moduleOf(id) ?? id, l.name);
  const lanes = layers.map((l) => {
    const groups = new Map<string, number>();
    for (const id of l.nodeIds) { const n = s.node(id); const gid = n?.parent && s.node(n.parent)?.kind === 'module-group' ? n.parent : id; groups.set(gid, (groups.get(gid) ?? 0) + 1); }
    return { name: l.name, total: l.nodeIds.length, groups: [...groups].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])) };
  });
  const between = new Map<string, number>();
  for (const e of s.d.graph.edges) {
    if (!['imports', 'calls', 'http', 'reads-model', 'writes-model', 'handles', 'injects', 'renders'].includes(e.kind)) continue;
    const a = layerOf.get(s.moduleOf(e.source) ?? e.source), b = layerOf.get(s.moduleOf(e.target) ?? e.target) ?? layerOf.get(e.target);
    if (a && b && a !== b) between.set(`${a} → ${b}`, (between.get(`${a} → ${b}`) ?? 0) + 1);
  }
  return { lanes, between: [...between].sort((x, y) => y[1] - x[1]) };
}
const LANE_FAM: Record<string, string> = { UI: 'ui', 'API / routes': 'endpoint', Services: 'service', Data: 'model', External: 'config' };

export function Architecture() {
  const s = useStore();
  const { d } = s;
  const arch = d.explanations?.architecture;
  const { lanes, between } = useMemo(() => layerView(s), [s]);
  const [showAll, setShowAll] = useState(false);
  const external = d.graph.stats['http.externalUrls'] ?? 0;
  const interactions = arch?.projectInteractions.length ? null : crossProject(s);
  const g = d.explanations?.grounding.architecture;
  return (
    <section aria-labelledby="sec-architecture">
      <SectionHead num={3} title="Architecture Overview" slug="architecture">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <Sub id="layers" slug="architecture">Layers</Sub>
      <p className="muted small prose">Files grouped by role family: UI → API/routes → services → data{external ? ' → external' : ''}. {arch?.layers.length ? 'Layer membership was reviewed by Claude against the graph.' : 'Assigned deterministically from framework roles and folder names.'}</p>
      <div className="lanes">
        {lanes.map((l) => (
          <div className="lane" key={l.name} style={{ ['--fam' as string]: `var(--f-${LANE_FAM[l.name] ?? 'util'})` }}>
            <h4>{l.name} <span className="muted">· {l.total}</span></h4>
            <ul>{(showAll ? l.groups : l.groups.slice(0, 8)).map(([gid, n]) => <li key={gid}><a href={href(s.node(gid)?.kind === 'module-group' ? 'modules' : 'explorer', gid)}>{s.node(gid)?.kind === 'module-group' ? `${groupPath(gid)}/` : shortId(gid)}</a><span className="muted">{n}</span></li>)}</ul>
            {l.groups.length > 8 && !showAll ? <button className="icon-btn" style={{ marginTop: 6, fontSize: 12 }} onClick={() => setShowAll(true)}>+{l.groups.length - 8} more</button> : null}
          </div>
        ))}
        {external ? <div className="lane" style={{ ['--fam' as string]: 'var(--f-config)' }}><h4>External</h4><p className="small muted" style={{ margin: 0 }}>{plural(external, 'outbound HTTP call')} to hosts outside this repo (not linked).</p></div> : null}
      </div>
      {between.length ? <p className="flows-between">Dependencies across layers: {between.slice(0, 8).map(([k, n]) => `${k} (${n})`).join(' · ')}</p> : null}

      <Sub id="narrative" slug="architecture">How it fits together</Sub>
      {arch?.narrative.length ? (
        <div className="prose">{arch.narrative.map((p, i) => <p key={i} className={p.inferred ? 'inferred-box' : ''}>{p.text} {p.inferred ? <Inferred /> : <Refs refs={p.refs} evidence={p.evidence} max={5} />}</p>)}</div>
      ) : <Empty>No narrative in this report. <code>/codebase-guide</code> writes one (300–600 words, every paragraph citing the graph).</Empty>}

      <Sub id="projects" slug="architecture">Projects and how they talk</Sub>
      <div className="table-wrap"><table>
        <thead><tr><th>Project</th><th>Language</th><th>Frameworks</th><th>Root</th></tr></thead>
        <tbody>{d.graph.projects.map((p) => <tr key={p.id}><td><NodeLink id={p.id} label={p.id.replace(/^[a-z]+:project:/, '')} /></td><td>{p.lang}</td><td>{p.frameworks.join(', ') || <span className="muted">none detected</span>}</td><td className="mono">{p.root}</td></tr>)}</tbody>
      </table></div>
      {arch?.projectInteractions.length ? (
        <ul className="prose">{arch.projectInteractions.map((p, i) => <li key={i}><NodeLink id={p.from} /> → <NodeLink id={p.to} />: {p.text} {p.inferred ? <Inferred /> : <Refs refs={p.refs} evidence={p.evidence} />}</li>)}</ul>
      ) : interactions?.length ? (
        <ul className="prose">{interactions.map((x) => <li key={x.key}><NodeLink id={x.from} /> → <NodeLink id={x.to} />: {plural(x.count, `${x.kind} edge`)}{x.kind === 'http' ? <> (linker, <Inferred why="HTTP links match URL templates to endpoint paths; they are always heuristic." />)</> : null} {x.ev ? <Ev path={x.ev.path} line={x.ev.line} /> : null}</li>)}</ul>
      ) : <p className="muted">No cross-project imports or HTTP links were found.</p>}
      {arch?.openQuestions.length ? <><h3>Open questions</h3><ul className="prose">{arch.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></> : null}
    </section>
  );
}

function crossProject(s: Store) {
  const agg = new Map<string, { key: string; from: string; to: string; kind: string; count: number; ev?: { path: string; line: number } }>();
  for (const e of s.d.graph.edges) {
    if (!['imports', 'http', 'calls'].includes(e.kind)) continue;
    const a = s.projectOf(e.source)?.id, b = s.projectOf(e.target)?.id;
    if (!a || !b || a === b) continue;
    const key = `${a}|${b}|${e.kind}`;
    const x = agg.get(key) ?? { key, from: a, to: b, kind: e.kind, count: 0, ...(e.evidence?.[0] ? { ev: e.evidence[0] } : {}) };
    x.count++;
    agg.set(key, x);
  }
  return [...agg.values()];
}

export function About() {
  const s = useStore();
  const { d } = s;
  const ex = d.explanations;
  const summarizable = d.graph.nodes.filter((n) => n.kind === 'module' && (n.meta.loc ?? 0) > 0 && n.meta.role !== 'test').length;
  const summarized = ex ? Object.keys(ex.files).length : 0;
  return (
    <section aria-labelledby="sec-about">
      <SectionHead num={16} title="About This Report" slug="about" />
      {d.meta.stale ? <p className="card" style={{ borderColor: 'var(--bad)' }}><strong className="stale">Stale:</strong> generated from {d.meta.commit?.slice(0, 10) ?? 'an unknown commit'}{d.meta.head && d.meta.head !== d.meta.commit ? `, but HEAD was ${d.meta.head.slice(0, 10)} at render time` : ''}{d.meta.dirty ? ' (uncommitted changes present)' : ''}. Run <code>/codebase-guide --update</code> to refresh.</p> : null}
      <div className="table-wrap"><table><tbody>
        <tr><th scope="row">Repo</th><td className="mono">{d.meta.repoRoot}</td></tr>
        <tr><th scope="row">Commit</th><td className="mono">{d.meta.commit ?? 'not a git repo'}{d.meta.dirty ? ' + uncommitted changes' : ''}</td></tr>
        <tr><th scope="row">Generated</th><td>{new Date(d.meta.generatedAt).toLocaleString()}</td></tr>
        <tr><th scope="row">Plugin</th><td>codebase-guide {d.meta.version}</td></tr>
        <tr><th scope="row">Mode</th><td>{d.meta.mode === 'full' ? `full (Claude explanations, depth ${d.meta.depth})` : 'deterministic (no LLM)'}</td></tr>
      </tbody></table></div>
      <Sub id="coverage" slug="about">Coverage and grounding</Sub>
      {ex ? (
        <>
          <div className="grid g4">
            <div className="card"><div className="stat">{summarizable ? Math.round((100 * summarized) / summarizable) : 0}%</div><div className="stat-l">files summarized ({summarized}/{summarizable})</div></div>
            <div className="card"><div className="stat">{ex.flowSteps.pct}%</div><div className="stat-l">flow steps evidence-backed ({ex.flowSteps.backed}/{ex.flowSteps.total})</div></div>
            <div className="card"><div className="stat">{ex.grounding.total.pct}%</div><div className="stat-l">claims grounded ({ex.grounding.total.grounded}/{ex.grounding.total.claims})</div></div>
            <div className="card"><div className="stat">{ex.inferredClaims}</div><div className="stat-l">inferred claims</div></div>
          </div>
          <div className="table-wrap" style={{ marginTop: 14 }}><table>
            <thead><tr><th>Section</th><th>Claims</th><th>Grounded</th></tr></thead>
            <tbody>{Object.entries(ex.grounding).filter(([k, v]) => k !== 'total' && v.claims).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.claims}</td><td><Meter pct={v.pct} claims={v.claims} /></td></tr>)}</tbody>
          </table></div>
          {ex.tasks.some((t) => t.status !== 'ok') ? (
            <><h3>Explain tasks with issues</h3><ul className="small">{ex.tasks.filter((t) => t.status !== 'ok').map((t) => <li key={t.id}><span className="mono">{t.id}</span> ({t.title}) · {t.status} after {t.attempts} attempt(s): {t.errors.slice(0, 3).join('; ')}</li>)}</ul></>
          ) : null}
          <p className="muted small">{ex.readsUsed ? `${ex.readsUsed} source file reads reported by the agents.` : ''}</p>
        </>
      ) : <p className="muted">Deterministic report: no Claude explanations, so there's no grounding score. Every fact shown comes from static analysis.</p>}
      <Sub id="warnings" slug="about">Extraction warnings</Sub>
      {d.graph.warnings.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Code</th><th>Count</th><th>Meaning</th><th>Example</th></tr></thead>
          <tbody>{[...d.graph.warnings].sort((a, b) => (b.count ?? 1) - (a.count ?? 1)).map((w) => <tr key={w.code}><td className="mono">{w.code}</td><td>{w.count ?? 1}</td><td>{w.message}</td><td className="mono small">{w.path ?? ''}</td></tr>)}</tbody>
        </table></div>
      ) : <p className="muted">None.</p>}
      <Sub id="limits" slug="about">What this report can't see</Sub>
      <ul className="prose">{d.meta.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </section>
  );
}
