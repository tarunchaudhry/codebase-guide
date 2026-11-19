import { useEffect, useMemo, useRef, useState } from 'react';
import MiniSearch from 'minisearch';
import { routeLabel, shortId, type Store } from './data.ts';
import { go, href, nodeHref, useStore } from './ui.tsx';

interface Doc { id: string; kind: string; name: string; path: string; text: string; target: string }

const KIND_LABEL: Record<string, string> = {
  function: 'function', method: 'method', class: 'class', component: 'component', module: 'file', endpoint: 'route', route: 'page', model: 'model',
  'env-var': 'env var', 'module-group': 'folder', glossary: 'glossary', schema: 'schema', script: 'script', flow: 'flow',
};

function buildDocs(s: Store): Doc[] {
  const docs: Doc[] = [];
  for (const n of s.d.graph.nodes) {
    if (!KIND_LABEL[n.kind]) continue;
    const role = n.meta.role ?? '';
    const kind = ['model', 'abstract-model'].includes(role) ? 'model' : ['schema', 'serializer'].includes(role) ? 'schema' : n.kind;
    const name = n.kind === 'endpoint' || n.kind === 'route' ? routeLabel(n) : n.kind === 'module' || n.kind === 'module-group' ? shortId(n.id) : n.label;
    const summary = s.explainSymbol(n.id) ?? s.explainFile(n.id)?.oneLine ?? s.explainModule(n.id)?.purpose ?? '';
    docs.push({ id: n.id, kind, name, path: n.path ?? '', text: [n.meta.doc ?? '', summary, n.meta.signature ?? ''].join(' '), target: nodeHref(n) });
  }
  for (const g of s.d.explanations?.guide?.glossary ?? []) docs.push({ id: `glossary:${g.term}`, kind: 'glossary', name: g.term, path: '', text: g.definition, target: href('glossary', undefined, g.term) });
  for (const f of s.d.explanations?.flows ?? []) docs.push({ id: `flow:${f.id}`, kind: 'flow', name: f.title, path: '', text: f.story, target: href('flows', f.id) });
  return docs;
}

export function Search() {
  const s = useStore();
  const index = useMemo(() => {
    const ms = new MiniSearch<Doc>({
      fields: ['name', 'path', 'text'], storeFields: ['kind', 'name', 'path', 'target'],
      searchOptions: { boost: { name: 4, path: 1.5 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
      tokenize: (t) => t.split(/[\s/._\-:#()[\]{}|,<>]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean),
    });
    ms.addAll(buildDocs(s));
    return ms;
  }, [s]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (q.trim().length < 2 ? [] : index.search(q).slice(0, 30)), [q, index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); ref.current?.focus(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const pick = (i: number) => { const r = results[i]; if (!r) return; go(r.target as string); setOpen(false); setQ(''); ref.current?.blur(); };
  return (
    <div className="search" role="combobox" aria-expanded={open && results.length > 0} aria-haspopup="listbox">
      <input ref={ref} type="search" value={q} placeholder="Search files, functions, routes, models, env vars, terms…  ( / )" aria-label="Search the report"
        {...(open && results.length ? { 'aria-controls': 'search-results', ...(results[sel] ? { 'aria-activedescendant': `sr-${sel}` } : {}) } : {})}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(x + 1, results.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
          else if (e.key === 'Enter') pick(sel);
          else if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); }
        }} />
      {open && results.length > 0 ? (
        <ul className="results" id="search-results" role="listbox" aria-label="Search results">
          {results.map((r, i) => (
            <li key={r.id} id={`sr-${i}`} role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setSel(i)}>
              <span className="k">{KIND_LABEL[r.kind as string] ?? r.kind}</span>
              <span><span className="mono">{r.name as string}</span>{r.path ? <span className="p">{r.path as string}</span> : null}</span>
            </li>
          ))}
        </ul>
      ) : open && q.trim().length >= 2 ? <ul className="results" id="search-results" role="listbox"><li className="muted" role="option" aria-selected={false}>No matches</li></ul> : null}
    </div>
  );
}
