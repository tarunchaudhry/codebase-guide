import { useEffect } from 'react';
import { cmp } from '../data.ts';
import { Empty, Ev, Inferred, Meter, NodeLink, Refs, SectionHead, SnippetView, useStore, type Route } from '../ui.tsx';

export function Conventions() {
  const s = useStore();
  const conv = s.d.explanations?.guide?.conventions;
  const g = s.d.explanations?.grounding.conventions;
  return (
    <section aria-labelledby="sec-conventions">
      <SectionHead num={11} title="Conventions & Patterns" slug="conventions">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <p className="prose muted small">A pattern seen in 3 or more places is a <strong>convention</strong>. Fewer than 3 is labeled <strong>observed rarely</strong>: copy it with care.</p>
      {conv?.length ? conv.map((c, i) => (
        <article key={i} className={`card${c.inferred ? ' inferred-box' : ''}`} style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>{c.name} <span className={`pill ${c.confidence === 'convention' ? 'ok' : 'neutral'}`}>{c.confidence === 'convention' ? 'convention' : 'observed rarely'}</span> {c.source === 'config' ? <Inferred why="From your config's customConventions, not verified in code." /> : c.inferred ? <Inferred /> : null}</h3>
          <p className="prose">{c.description}</p>
          {c.examples.length ? <p className="small">Examples: {c.examples.map((e) => <Ev key={`${e.path}:${e.line}`} path={e.path} line={e.line} />).reduce<React.ReactNode[]>((a, x) => [...a, a.length ? ' · ' : '', x], [])}</p> : null}
          {c.examples[0] ? <details><summary className="small">Show first example</summary><SnippetView path={c.examples[0].path} line={c.examples[0].line} /></details> : null}
        </article>
      )) : (
        <>
          {!s.d.explanations ? <p className="muted small">Deterministic report: these are raw observations from the graph. <code>/codebase-guide</code> turns them into named conventions with explanations.</p> : <Empty>The guide writer found no conventions with enough examples.</Empty>}
          {s.d.hints.patterns.length ? (
            <table><thead><tr><th>Observed pattern</th><th>Places</th><th>Examples</th></tr></thead>
              <tbody>{s.d.hints.patterns.map((p, i) => <tr key={i}><td>{p.pattern} <span className={`pill ${p.count >= 3 ? 'ok' : 'neutral'}`}>{p.count >= 3 ? 'convention' : 'observed rarely'}</span></td><td>{p.count}</td><td className="small">{p.examples.map((e) => <div key={`${e.path}:${e.line}`}><Ev path={e.path} line={e.line} /></div>)}</td></tr>)}</tbody>
            </table>
          ) : null}
        </>
      )}
    </section>
  );
}

export function Recipes() {
  const s = useStore();
  const recipes = s.d.explanations?.guide?.recipes;
  const g = s.d.explanations?.grounding.recipes;
  const ref = (r: string) => (s.node(r) ? <NodeLink id={r} /> : /^(.+):(\d+)$/.test(r) ? <Ev path={r.replace(/:\d+$/, '')} line={Number(r.split(':').pop())} /> : <code>{r}</code>);
  return (
    <section aria-labelledby="sec-recipes">
      <SectionHead num={12} title="How Do I…?" slug="recipes">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      <p className="prose muted small">Recipes appear only for tasks this repo already has at least 2 examples of. Each step links a real file to copy from.</p>
      {recipes?.length ? recipes.map((r, i) => (
        <article key={i} className="card" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>{r.task.charAt(0).toUpperCase() + r.task.slice(1)}</h3>
          <ol className="prose">{r.steps.map((st, j) => (
            <li key={j} style={{ marginBottom: 8 }}>{st.text} <span className="small">— copy from {ref(st.exampleRef)}</span>
              {st.evidence ? <details><summary className="small">Show example</summary><SnippetView path={st.evidence.path} line={st.evidence.line} /></details> : null}
            </li>
          ))}</ol>
        </article>
      )) : s.d.hints.recipes.length ? (
        <>
          {!s.d.explanations ? <p className="muted small">Deterministic report: no step-by-step text. These tasks have ≥ 2 examples to copy from:</p> : <Empty>The guide writer produced no recipes.</Empty>}
          {s.d.hints.recipes.map((r) => <div key={r.task} className="card" style={{ marginTop: 10 }}><h3 style={{ marginTop: 0 }}>{r.task.charAt(0).toUpperCase() + r.task.slice(1)}</h3><p className="small">Examples: {r.examples.map((e) => <span key={e.nodeId}><NodeLink id={e.nodeId} /> </span>)}</p></div>)}
        </>
      ) : <Empty>No task has 2 or more examples in this repo, so there are no recipes (they'd be guesses).</Empty>}
    </section>
  );
}

export function Glossary({ route }: { route: Route }) {
  const s = useStore();
  const terms = [...(s.d.explanations?.guide?.glossary ?? [])].sort((a, b) => cmp(a.term.toLowerCase(), b.term.toLowerCase()));
  const g = s.d.explanations?.grounding.glossary;
  useEffect(() => { if (route.anchor) document.getElementById(`term-${route.anchor}`)?.scrollIntoView({ block: 'center' }); }, [route.anchor]);
  const models = s.d.graph.nodes.filter((n) => n.kind === 'model' || n.meta.role === 'model').sort((a, b) => cmp(a.label, b.label));
  return (
    <section aria-labelledby="sec-glossary">
      <SectionHead num={13} title="Glossary" slug="glossary">{g ? <Meter pct={g.pct} claims={g.claims} /> : null}</SectionHead>
      {terms.length ? (
        <dl className="prose">{terms.map((t) => (
          <div key={t.term} id={`term-${t.term}`} className={t.inferred ? 'inferred-box' : ''} style={{ padding: '6px 0', borderBottom: '1px solid var(--rule)', ...(route.anchor === t.term ? { background: 'var(--accent-soft)' } : {}) }}>
            <dt><strong>{t.term}</strong> {t.inferred ? <Inferred why="Definition inferred from naming, not shown by code." /> : null}</dt>
            <dd style={{ margin: '2px 0 0' }}>{t.definition} <Refs refs={t.refs} evidence={t.evidence} max={4} /></dd>
          </div>
        ))}</dl>
      ) : (
        <>
          <Empty>No glossary in this report. <code>/codebase-guide</code> writes one from model names, route segments and docs.</Empty>
          {models.length ? <p className="small" style={{ marginTop: 12 }}>Domain models in the code: {models.map((m) => <span key={m.id}><NodeLink id={m.id} /> </span>)}</p> : null}
        </>
      )}
    </section>
  );
}
