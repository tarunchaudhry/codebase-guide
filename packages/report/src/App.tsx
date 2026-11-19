import { useEffect, useMemo, useState } from 'react';
import { Store, type ReportData } from './data.ts';
import { Search } from './search.tsx';
import { StoreCtx, href, useRoute, type Route } from './ui.tsx';
import { About, Architecture, RunLocally, StartHere } from './sections/start.tsx';
import { ConfigEnv, DirectoryMap, Health, Modules } from './sections/structure.tsx';
import { Flows } from './sections/flows.tsx';
import { Explorer } from './sections/explorer.tsx';
import { Api, Models } from './sections/api.tsx';
import { Conventions, Glossary, Recipes } from './sections/guide.tsx';
import { Canvas } from './sections/canvas.tsx';

type Grounded = 'overview' | 'runLocally' | 'architecture' | 'files' | 'flows' | 'modules' | 'symbols' | 'conventions' | 'recipes' | 'glossary';
const SECTIONS: { slug: string; title: string; g?: Grounded; C: (p: { route: Route }) => React.ReactNode }[] = [
  { slug: 'start', title: 'Start Here', g: 'overview', C: StartHere },
  { slug: 'run', title: 'Run It Locally', g: 'runLocally', C: RunLocally },
  { slug: 'architecture', title: 'Architecture', g: 'architecture', C: Architecture },
  { slug: 'directory', title: 'Directory Map', g: 'files', C: DirectoryMap },
  { slug: 'flows', title: 'Key Flows', g: 'flows', C: Flows },
  { slug: 'modules', title: 'Modules', g: 'modules', C: Modules },
  { slug: 'explorer', title: 'Function Explorer', g: 'symbols', C: Explorer },
  { slug: 'api', title: 'API / Routes', C: Api },
  { slug: 'models', title: 'Data Models', C: Models },
  { slug: 'config', title: 'Config & Env', C: ConfigEnv },
  { slug: 'conventions', title: 'Conventions', g: 'conventions', C: Conventions },
  { slug: 'recipes', title: 'How Do I…?', g: 'recipes', C: Recipes },
  { slug: 'glossary', title: 'Glossary', g: 'glossary', C: Glossary },
  { slug: 'health', title: 'Health & Hotspots', C: Health },
  { slug: 'canvas', title: 'Canvas', C: Canvas },
  { slug: 'about', title: 'About This Report', C: About },
];

export function App({ data }: { data: ReportData }) {
  const store = useMemo(() => new Store(data), [data]);
  const route = useRoute();
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem('cg-theme'); } catch { return null; } });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem('cg-theme', theme); else localStorage.removeItem('cg-theme'); } catch { /* storage blocked */ }
  }, [theme]);
  const sec = SECTIONS.find((x) => x.slug === route.section) ?? SECTIONS[0]!;
  useEffect(() => {
    document.title = `${sec.title} · ${data.meta.repoName} · codebase guide`;
    setMenu(false);
    if (route.anchor) setTimeout(() => document.getElementById(`h-${route.anchor}`)?.scrollIntoView({ block: 'start' }), 50);
    else window.scrollTo(0, 0);
    // Focus the main region for screen readers on section change (not on first load).
  }, [sec, route.anchor, route.param, data.meta.repoName]);
  const ex = data.explanations;
  const m = data.meta;
  return (
    <StoreCtx.Provider value={store}>
      <a className="skip" href="#main">Skip to content</a>
      <div className="shell">
        <aside className={`side${menu ? ' open' : ''}`} aria-label="Report sections">
          <div className="brand"><b>◆</b> codebase guide</div>
          <div className="repo">{m.repoName}</div>
          <div className="repo-sub">{m.commit ? m.commit.slice(0, 10) : 'no git'} · {m.mode === 'full' ? `${m.depth}` : 'deterministic'}</div>
          <nav><ul className="nav">
            {SECTIONS.map((x) => {
              const g = x.g && ex?.grounding[x.g];
              return (
                <li key={x.slug}><a href={href(x.slug)} aria-current={x.slug === sec.slug ? 'page' : undefined}>
                  <span>{x.title}</span>
                  {g && g.claims ? <span className="meter-dot" title={`${g.pct}% grounded`} style={{ background: g.pct >= 85 ? 'var(--ok)' : 'var(--warn)' }} /> : <span />}
                </a></li>
              );
            })}
          </ul></nav>
        </aside>
        <div className="main">
          <div className="banner" role="note">
            <span><strong>Internal</strong> — contains source paths and snippets.</span>
            {m.stale ? <span className="stale"><strong className="stale">Stale:</strong> HEAD moved since this report was generated. Run /codebase-guide --update.</span> : null}
            <span>Generated {new Date(m.generatedAt).toLocaleDateString()} · {m.mode === 'full' ? 'Claude explanations are checked against the graph; anything unproven is marked inferred.' : 'Deterministic: static analysis only, no LLM.'}</span>
          </div>
          <header className="top">
            <button className="icon-btn menu-btn" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu(!menu)}><span aria-hidden>☰</span> Menu</button>
            <Search />
             <button className="icon-btn" title="Color theme: follows the OS until you pick one" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? null : 'dark')}><span aria-hidden>{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</span> theme: {theme ?? 'auto'}</button>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            <sec.C route={route} />
          </main>
        </div>
      </div>
    </StoreCtx.Provider>
  );
}
