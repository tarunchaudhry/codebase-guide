import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { EdgeKind, GraphEdge, GraphNode, RepoGraph } from './schema.ts';
import { repoFacts, type RepoFacts } from './facts.ts';
import { isSecretPath } from './files.ts';

/** Deterministic analyzer output (`.codebase-guide/analysis.json`). */
export interface Analysis {
  version: 1;
  counts: Record<string, number>;
  modules: Record<string, { fanIn: number; fanOut: number; pagerank: number; loc: number }>;
  symbols: Record<string, { fanIn: number; fanOut: number }>;
  entryPoints: EntryPoint[];
  readingOrder: { id: string; score: number; reason: string }[];
  hotspots: {
    fanIn: Metric[]; largestFiles: Metric[]; largestFunctions: Metric[]; complexity: Metric[];
  };
  cycles: string[][];
  /** Deterministic layer assignment of modules (and Prisma models) by role family. */
  layers: { name: LayerName; nodeIds: string[] }[];
  unusedExports: { id: string; reason: string }[];
  unreferencedModules: { id: string; reason: string }[];
  untested: string[];
  flowCandidates: FlowCandidate[];
  requestedFlows: string[];
  facts: RepoFacts;
}

export type LayerName = 'UI' | 'API / routes' | 'Services' | 'Data';
export const LAYERS: LayerName[] = ['UI', 'API / routes', 'Services', 'Data'];
const UI_ROLES = new Set(['page', 'layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'default', 'document']);
const API_ROLES = new Set(['route', 'middleware', 'urlconf', 'router', 'app', 'controller', 'view', 'viewset', 'blueprint', 'route-handler', 'plugin', 'nest-module', 'app-router', 'pages-router']);
const DATA_ROLES = new Set(['model', 'abstract-model', 'schema', 'serializer']);

export interface Metric { id: string; value: number }
export interface EntryPoint { id: string; kind: EntryKind; ref: string; reason: string }
export type EntryKind = 'page' | 'endpoint' | 'script' | 'management-command' | 'main' | 'worker' | 'middleware' | 'server-action';
export interface FlowCandidate {
  id: string; entry: string; title: string; category: 'auth' | 'write' | 'job' | 'top';
  tags: string[]; score: number; reach: number; depth: number; nodes: string[]; reason: string;
}

export interface AnalyzeOptions { depth?: 'quick' | 'standard' | 'deep'; maxFlows?: number; flows?: string[] }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round = (x: number) => Number(x.toFixed(6));

/** Module-to-module dependency kinds (rolled up from symbol edges). Tests edges are excluded on purpose. */
const DEP_KINDS: EdgeKind[] = ['imports', 'dynamic-imports', 'calls', 'renders', 'uses-hook', 'injects', 'invokes-server-action'];
const RANK_KINDS: EdgeKind[] = ['imports', 'calls'];
/** Symbol references that count as "used". */
const REF_KINDS = new Set<EdgeKind>(['calls', 'renders', 'uses-hook', 'injects', 'invokes-server-action', 'handles', 'middleware-chain', 'validates', 'serializes', 'model-relation', 'reads-model', 'writes-model', 'mounts', 'http']);
/** Flow walk order (spec priority), then the UI/data edges. */
export const FLOW_KINDS: EdgeKind[] = ['middleware-chain', 'handles', 'injects', 'calls', 'validates', 'serializes', 'reads-model', 'writes-model', 'fetches', 'http', 'renders', 'uses-hook', 'invokes-server-action'];

export const TEST_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;
/** Files whose exports are consumed by a framework, not by imports. */
const CONVENTION_PATH = /(^|\/)(migrations|alembic)\/|(^|\/)(settings[^/]*|__init__|manage|wsgi|asgi|conftest|apps|admin)\.py$|(^|\/)[^/]*\.config\.[cm]?[jt]s$|\.d\.ts$|(^|\/)(next-env\.d|instrumentation|middleware|proxy)\.[jt]s$/;
const CONVENTION_ROLES = new Set(['page', 'layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'default', 'route', 'middleware', 'document', 'app', 'test', 'settings', 'urlconf']);
const FRAMEWORK_SYMBOL_ROLES = new Set(['model', 'abstract-model', 'serializer', 'viewset', 'view', 'app-config', 'management-command', 'signal-handler', 'schema', 'controller', 'provider', 'nest-module', 'server-action', 'route-handler', 'plugin', 'middleware']);
const DEFINES_ROLES: Record<string, string> = {
  model: 'model', schema: 'schema', serializer: 'serializer', middleware: 'middleware', app: 'app object', router: 'router',
  blueprint: 'blueprint', 'nest-module': 'Nest module', controller: 'controller', provider: 'provider', settings: 'settings',
  urlconf: 'URLconf', viewset: 'viewset', view: 'view', 'app-router': 'app router',
};
const WORKER_PATH = /(^|\/)(workers?|jobs?|tasks|queues?|cron|celery|consumers?)(\/|\.|_)/;
const WORKER_DECORATOR = /(^|\.)(task|shared_task|periodic_task|job|cron|Cron|Processor|Process|consumer)$/;
const AUTH = /auth|login|logout|sign-?in|sign-?up|session|token|jwt|current_?user|password|\/me$/i;

export function analyze(graph: RepoGraph, root: string, files: string[], opts: AnalyzeOptions = {}): Analysis {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const modules = graph.nodes.filter((n) => n.kind === 'module');
  const moduleByPath = new Map(modules.map((m) => [m.path!, m.id]));
  const isTestModule = (m: GraphNode) => m.meta.role === 'test' || TEST_PATH.test(m.path ?? '');

  const moduleCache = new Map<string, string | null>();
  const moduleOf = (id: string): string | null => {
    if (moduleCache.has(id)) return moduleCache.get(id)!;
    let n = byId.get(id);
    let r: string | null = null;
    while (n) {
      if (n.kind === 'module') { r = n.id; break; }
      if (n.path && moduleByPath.has(n.path) && n.kind !== 'project') { r = moduleByPath.get(n.path)!; break; }
      n = n.parent ? byId.get(n.parent) : undefined;
    }
    moduleCache.set(id, r);
    return r;
  };

  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
    (inc.get(e.target) ?? inc.set(e.target, []).get(e.target)!).push(e);
  }

  // ---- module dependency graph -------------------------------------------------------------
  const testMods = new Set(modules.filter(isTestModule).map((m) => m.id));
  const deps = new Map<string, Set<string>>(); // module → modules it depends on
  const rdeps = new Map<string, Set<string>>();
  const rankAdj = new Map<string, Set<string>>();
  for (const m of modules) { deps.set(m.id, new Set()); rdeps.set(m.id, new Set()); rankAdj.set(m.id, new Set()); }
  for (const e of graph.edges) {
    if (!DEP_KINDS.includes(e.kind)) continue;
    const s = moduleOf(e.source), t = moduleOf(e.target);
    if (!s || !t || s === t || testMods.has(s)) continue;
    deps.get(s)!.add(t);
    rdeps.get(t)!.add(s);
    if (RANK_KINDS.includes(e.kind)) rankAdj.get(s)!.add(t);
  }
  const pr = pagerank(modules.filter((m) => !testMods.has(m.id)).map((m) => m.id), rankAdj);
  const modMetrics: Analysis['modules'] = {};
  for (const m of modules) {
    modMetrics[m.id] = { fanIn: rdeps.get(m.id)!.size, fanOut: deps.get(m.id)!.size, pagerank: round(pr.get(m.id) ?? 0), loc: m.meta.loc ?? 0 };
  }

  // ---- symbol metrics -----------------------------------------------------------------------
  const SYMBOL_KINDS = new Set(['function', 'class', 'method', 'component', 'endpoint', 'model']);
  const symMetrics: Analysis['symbols'] = {};
  for (const n of graph.nodes) {
    if (!SYMBOL_KINDS.has(n.kind)) continue;
    const ins = new Set((inc.get(n.id) ?? []).filter((e) => REF_KINDS.has(e.kind)).map((e) => e.source));
    const outs = new Set((out.get(n.id) ?? []).filter((e) => REF_KINDS.has(e.kind)).map((e) => e.target));
    if (ins.size || outs.size) symMetrics[n.id] = { fanIn: ins.size, fanOut: outs.size };
  }

  const facts = repoFacts(root, files, graph);

  // ---- entry points -------------------------------------------------------------------------
  const entries: EntryPoint[] = [];
  const addEntry = (mod: string | null, kind: EntryKind, ref: string, reason: string) => { if (mod) entries.push({ id: mod, kind, ref, reason }); };
  for (const n of graph.nodes) {
    if (n.kind === 'route' && n.meta.http) addEntry(moduleOf(n.id), 'page', n.id, `page ${n.label}`);
    if (n.kind === 'endpoint' && n.meta.http) {
      const h = (out.get(n.id) ?? []).find((e) => e.kind === 'handles');
      addEntry(moduleOf(h?.target ?? n.id), 'endpoint', n.id, `handles ${n.meta.http.methods.join('|')} ${n.meta.http.fullPath ?? n.meta.http.pathTemplate}`);
    }
    if (n.meta.role === 'management-command') addEntry(moduleOf(n.id), 'management-command', n.id, `management command ${n.path ? posix.basename(n.path, '.py') : n.label}`);
    if (n.meta.role === 'server-action') addEntry(moduleOf(n.id), 'server-action', n.id, `server action ${n.label}`);
    if (n.kind === 'module' && n.meta.role === 'middleware') addEntry(n.id, 'middleware', n.id, 'request middleware');
    if ((n.kind === 'function' || n.kind === 'method') && n.meta.decorators?.some((d) => WORKER_DECORATOR.test(d))) addEntry(moduleOf(n.id), 'worker', n.id, `background task ${n.label}`);
    if (n.kind === 'script') {
      for (const t of scriptTargets(n, moduleByPath)) addEntry(t, 'script', n.id, `run by ${n.meta.role === 'npm-script' ? 'npm script' : 'script'} \`${n.label}\``);
    }
  }
  const projectRoots = graph.projects.map((p) => p.root);
  const entryIds = new Set(entries.map((e) => e.id));
  for (const m of modules) {
    const p = m.path ?? '';
    if (testMods.has(m.id)) continue;
    const dir = posix.dirname(p), base = posix.basename(p);
    const atRoot = projectRoots.some((r) => dir === r || dir === (r === '.' ? 'src' : `${r}/src`) || (r === '.' && dir === '.'));
    if (/^(__main__|manage|wsgi|asgi)\.py$/.test(base) || (atRoot && /^(main|app|server|index|cli)\.([cm]?[jt]s|py)$/.test(base))) addEntry(m.id, 'main', m.id, base === '__main__.py' ? 'package __main__' : `main module ${base}`);
    else if (WORKER_PATH.test(p) && !entryIds.has(m.id)) addEntry(m.id, 'worker', m.id, 'worker/job module (by path)');
  }
  for (const f of facts.packageEntries) { const id = moduleByPath.get(f.file); if (id) addEntry(id, 'main', id, `package.json ${f.field}`); }
  const entryList = dedupeEntries(entries);
  const entryByMod = new Map<string, EntryPoint[]>();
  for (const e of entryList) (entryByMod.get(e.id) ?? entryByMod.set(e.id, []).get(e.id)!).push(e);

  // ---- reading order ------------------------------------------------------------------------
  const maxPr = Math.max(0, ...[...pr.values()]);
  const maxFanIn = Math.max(0, ...modules.map((m) => modMetrics[m.id]!.fanIn));
  // Roles defined in each module, built in one pass (was a per-module rescan of every node).
  const definesByMod = new Map<string, Map<string, string[]>>();
  for (const n of graph.nodes) {
    if (n.kind === 'module' || n.kind === 'module-group' || n.kind === 'project') continue;
    const role = n.kind === 'model' ? 'model' : n.meta.role;
    const label = role && DEFINES_ROLES[role];
    const mod = label ? moduleOf(n.id) : null;
    if (!label || !mod) continue;
    const roles = definesByMod.get(mod) ?? definesByMod.set(mod, new Map()).get(mod)!;
    (roles.get(label) ?? roles.set(label, []).get(label)!).push(n.label);
  }
  const definesOf = (modId: string) => {
    const roles = new Map(definesByMod.get(modId) ?? []);
    const self = byId.get(modId)!.meta.role;
    if (self && DEFINES_ROLES[self] && !roles.has(DEFINES_ROLES[self]!)) roles.set(DEFINES_ROLES[self]!, []);
    return roles;
  };
  const scored = modules
    .filter((m) => !testMods.has(m.id) && (m.meta.loc ?? 0) > 0 && !/\.d\.ts$|\.config\.[cm]?[jt]s$/.test(m.path ?? ''))
    .map((m) => {
      const mm = modMetrics[m.id]!;
      const centrality = 0.6 * (maxPr ? (pr.get(m.id) ?? 0) / maxPr : 0) + 0.4 * (maxFanIn ? mm.fanIn / maxFanIn : 0);
      const defines = definesOf(m.id);
      const entryness = (entryByMod.has(m.id) ? 2 : 1) * (defines.size ? 1.3 : 1);
      const locPenalty = 1 / (1 + Math.max(0, mm.loc - 200) / 400);
      return { m, score: round(entryness * (0.15 + centrality) * locPenalty), defines };
    })
    .sort((a, b) => b.score - a.score || cmp(a.m.id, b.m.id));
  const perDir = new Map<string, number>();
  let pages = 0;
  const readingOrder: Analysis['readingOrder'] = [];
  for (const s of scored) {
    if (readingOrder.length >= 10) break;
    const dir = posix.dirname(s.m.path ?? '');
    const isPage = (entryByMod.get(s.m.id) ?? []).every((e) => e.kind === 'page') && entryByMod.has(s.m.id);
    // ponytail: crude diversity caps (3 per folder, 3 pages) so one folder or a page tree can't fill the list
    if ((perDir.get(dir) ?? 0) >= 3 || (isPage && pages >= 3)) continue;
    perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
    if (isPage) pages++;
    readingOrder.push({ id: s.m.id, score: s.score, reason: readingReason(modMetrics[s.m.id]!, entryByMod.get(s.m.id) ?? [], s.defines) });
  }

  // ---- hotspots -----------------------------------------------------------------------------
  const top = (xs: Metric[], n = 10) => xs.filter((x) => x.value > 0).sort((a, b) => b.value - a.value || cmp(a.id, b.id)).slice(0, n);
  const fns = graph.nodes.filter((n) => n.kind === 'function' || n.kind === 'method' || n.kind === 'component');
  const prodModules = modules.filter((m) => !testMods.has(m.id));
  const hotspots: Analysis['hotspots'] = {
    fanIn: top(prodModules.map((m) => ({ id: m.id, value: modMetrics[m.id]!.fanIn }))),
    largestFiles: top(prodModules.map((m) => ({ id: m.id, value: m.meta.loc ?? 0 }))),
    largestFunctions: top(fns.filter((n) => !testMods.has(moduleOf(n.id) ?? '')).map((n) => ({ id: n.id, value: n.meta.loc ?? 0 }))),
    complexity: top(fns.filter((n) => !testMods.has(moduleOf(n.id) ?? '')).map((n) => ({ id: n.id, value: n.meta.complexity ?? 0 })).filter((x) => x.value > 1)),
  };

  // ---- cycles (Tarjan over module imports) -------------------------------------------------
  const importAdj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'imports' || byId.get(e.source)?.kind !== 'module' || byId.get(e.target)?.kind !== 'module' || e.source === e.target) continue;
    (importAdj.get(e.source) ?? importAdj.set(e.source, []).get(e.source)!).push(e.target);
  }
  const cycles = tarjan(modules.map((m) => m.id), importAdj).filter((c) => c.length > 1);

  // ---- unused exports / unreferenced modules ----------------------------------------------
  const conventionModule = (m: GraphNode) => testMods.has(m.id) || CONVENTION_ROLES.has(m.meta.role ?? '') || CONVENTION_PATH.test(m.path ?? '') || entryByMod.has(m.id);
  const importers = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind !== 'imports' && e.kind !== 'dynamic-imports') continue;
    const s = moduleOf(e.source), t = moduleOf(e.target);
    if (s && t && s !== t) (importers.get(t) ?? importers.set(t, new Set()).get(t)!).add(s);
  }
  const textCache = new Map<string, string>();
  const textOf = (modId: string) => {
    if (!textCache.has(modId)) {
      const p = byId.get(modId)?.path;
      const abs = p ? join(root, p) : '';
      textCache.set(modId, p && !isSecretPath(p) && existsSync(abs) ? readFileSync(abs, 'utf8') : '');
    }
    return textCache.get(modId)!;
  };
  const unusedExports: Analysis['unusedExports'] = [];
  for (const n of graph.nodes) {
    if (!(n.kind === 'function' || n.kind === 'class' || n.kind === 'component') || !n.meta.exported || n.meta.decorators?.length) continue;
    if (FRAMEWORK_SYMBOL_ROLES.has(n.meta.role ?? '') || n.label.startsWith('_') || /^(default|anonymous)/.test(n.label) || n.label.includes('<')) continue;
    const mod = moduleOf(n.id);
    const m = mod ? byId.get(mod) : undefined;
    if (!m || conventionModule(m)) continue;
    if ((inc.get(n.id) ?? []).some((e) => REF_KINDS.has(e.kind))) continue;
    const imps = [...(importers.get(m.id) ?? [])];
    const name = n.label.split('.')[0]!;
    const word = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
    if (imps.some((i) => word.test(textOf(i)))) continue;
    if ((textOf(m.id).match(new RegExp(word.source, 'g'))?.length ?? 0) > 1) continue; // used inside its own module (e.g. a base class)
    // ponytail: name-in-importer text check, not a symbol table; aliased or re-exported-then-unused names slip through as "used"
    unusedExports.push({ id: n.id, reason: imps.length ? `exported, but none of the ${imps.length} importing module(s) mention \`${name}\`` : 'exported, but its module is never imported' });
  }
  const unreferencedModules = prodModules
    .filter((m) => !conventionModule(m) && (m.meta.loc ?? 0) > 0 && rdeps.get(m.id)!.size === 0 && !(importers.get(m.id)?.size))
    .map((m) => ({ id: m.id, reason: 'no static imports or calls reach this module' }));

  // ---- test proximity ----------------------------------------------------------------------
  const tested = new Set(graph.edges.filter((e) => e.kind === 'tests').map((e) => moduleOf(e.target)).filter((x): x is string => !!x));
  const untested = prodModules
    .filter((m) => !tested.has(m.id) && (m.meta.loc ?? 0) > 0 && !CONVENTION_PATH.test(m.path ?? ''))
    .sort((a, b) => modMetrics[b.id]!.fanIn - modMetrics[a.id]!.fanIn || cmp(a.id, b.id))
    .map((m) => m.id);

  // ---- layers -------------------------------------------------------------------------------
  const layerOf = new Map<string, LayerName>();
  const roleSet = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    const mod = n.kind === 'module' ? n.id : moduleOf(n.id);
    if (!mod) continue;
    const rs = roleSet.get(mod) ?? roleSet.set(mod, new Set()).get(mod)!;
    if (n.meta.role) rs.add(n.meta.role);
    if (n.kind === 'component') rs.add('#component');
    if (n.kind === 'endpoint') rs.add('#endpoint');
  }
  for (const e of entryList) if (e.kind === 'endpoint') roleSet.get(e.id)?.add('#endpoint');
  for (const m of prodModules) {
    const rs = roleSet.get(m.id) ?? new Set<string>();
    const p = m.path ?? '';
    const has = (set: Set<string>) => [...rs].some((r) => set.has(r));
    const layer: LayerName =
      has(DATA_ROLES) || /(^|\/)(models?|db|database|schema|repositor(y|ies)|dao|entities|prisma)(\/|\.)/.test(p) ? 'Data'
      : rs.has('#endpoint') || has(API_ROLES) || /(^|\/)(api|routes?|routers?|controllers?|views?|handlers?|endpoints?)(\/|\.)/.test(p) ? 'API / routes'
      : has(UI_ROLES) || rs.has('#component') || m.meta.runtime === 'client' || /\.(tsx|jsx)$/.test(p) ? 'UI'
      : 'Services';
    if ((m.meta.loc ?? 0) > 0) layerOf.set(m.id, layer);
  }
  for (const n of graph.nodes) if (n.kind === 'model') layerOf.set(n.id, 'Data');
  const layers = LAYERS.map((name) => ({ name, nodeIds: [...layerOf].filter(([, l]) => l === name).map(([id]) => id).sort(cmp) })).filter((l) => l.nodeIds.length);

  // ---- flow candidates ---------------------------------------------------------------------
  const flowCandidates = pickFlows(graph, out, byId, entryList, opts);

  const counts: Record<string, number> = {
    projects: graph.projects.length,
    files: graph.stats.files ?? modules.length,
    modules: modules.length,
    endpoints: graph.nodes.filter((n) => n.kind === 'endpoint').length,
    pages: graph.nodes.filter((n) => n.kind === 'route').length,
    models: graph.nodes.filter((n) => n.kind === 'model' || n.meta.role === 'model').length,
    schemas: graph.nodes.filter((n) => n.meta.role === 'schema' || n.meta.role === 'serializer').length,
    functions: fns.length,
    envVars: graph.nodes.filter((n) => n.kind === 'env-var').length,
    tests: testMods.size,
  };

  return {
    version: 1, counts, modules: modMetrics, symbols: symMetrics,
    entryPoints: entryList, readingOrder, hotspots, cycles, layers, unusedExports: unusedExports.sort((a, b) => cmp(a.id, b.id)),
    unreferencedModules, untested, flowCandidates, requestedFlows: [...(opts.flows ?? [])], facts,
  };
}

function readingReason(mm: { fanIn: number; fanOut: number; loc: number }, entries: EntryPoint[], defines: Map<string, string[]>): string {
  const parts: string[] = [];
  if (entries.length) {
    const first = entries.map((e) => e.reason).sort(cmp);
    parts.push(`entry point (${first.slice(0, 2).join('; ')}${first.length > 2 ? `; +${first.length - 2} more` : ''})`);
  }
  if (mm.fanIn) parts.push(`used by ${mm.fanIn} module${mm.fanIn === 1 ? '' : 's'}`);
  const defs = [...defines.entries()].sort(([a], [b]) => cmp(a, b)).map(([label, names]) =>
    names.length > 1 ? `${names.length} ${label}s (${names.slice(0, 3).sort(cmp).join(', ')}${names.length > 3 ? ', …' : ''})` : names.length ? `the ${label} ${names[0]}` : `the ${label}`);
  if (defs.length) parts.push(`defines ${defs.slice(0, 2).join(' and ')}`);
  if (mm.fanOut >= 3) parts.push(`depends on ${mm.fanOut} modules`);
  if (!parts.length) parts.push(`${mm.loc} lines`);
  return parts.join('; ');
}

function dedupeEntries(xs: EntryPoint[]): EntryPoint[] {
  const seen = new Map<string, EntryPoint>();
  for (const e of xs) seen.set(`${e.id}|${e.kind}|${e.ref}`, e);
  return [...seen.values()].sort((a, b) => cmp(a.id, b.id) || cmp(a.kind, b.kind) || cmp(a.ref, b.ref));
}

/** Modules a script command runs: file paths, `python -m pkg.mod`, `pkg.mod:obj` (uvicorn, pyproject scripts). */
export function scriptTargets(n: GraphNode, moduleByPath: Map<string, string>): string[] {
  const cmd = n.meta.signature ?? '';
  const base = posix.dirname(n.path ?? '.');
  const out = new Set<string>();
  const tryPath = (p: string) => {
    const norm = posix.normalize(base === '.' ? p : `${base}/${p}`).replace(/^\.\//, '');
    for (const c of [norm, `${norm}.ts`, `${norm}.js`, `${norm}.py`, `${norm}/index.ts`, `${norm}/index.js`, `${norm}/__main__.py`, `${norm}/__init__.py`]) {
      const id = moduleByPath.get(c);
      if (id) { out.add(id); return; }
    }
  };
  for (const tok of cmd.split(/[\s;&|]+/)) {
    if (/\.([cm]?[jt]sx?|py)$/.test(tok)) tryPath(tok);
    const dotted = /^([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)(?::[\w.]+)?$/.exec(tok);
    if (dotted && (tok.includes(':') || tok.includes('.')) && !/\.([cm]?[jt]sx?|py|json)$/.test(tok)) {
      const p = dotted[1]!.replace(/\./g, '/');
      for (const pre of ['', 'src/']) tryPath(`${pre}${p}`);
    }
  }
  return [...out].sort(cmp);
}

function pagerank(ids: string[], adj: Map<string, Set<string>>, d = 0.85, iters = 40): Map<string, number> {
  const n = ids.length;
  const rank = new Map(ids.map((id) => [id, 1 / Math.max(1, n)]));
  const set = new Set(ids);
  for (let it = 0; it < iters; it++) {
    const next = new Map(ids.map((id) => [id, (1 - d) / n]));
    let dangling = 0;
    for (const id of ids) {
      const outs = [...(adj.get(id) ?? [])].filter((t) => set.has(t));
      if (!outs.length) { dangling += rank.get(id)!; continue; }
      const share = (d * rank.get(id)!) / outs.length;
      for (const t of outs) next.set(t, next.get(t)! + share);
    }
    for (const id of ids) next.set(id, next.get(id)! + (d * dangling) / n);
    for (const [k, v] of next) rank.set(k, v);
  }
  return rank;
}

/** Iterative Tarjan SCC; each component and the list are sorted for determinism. */
export function tarjan(ids: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of [...ids].sort(cmp)) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index); low.set(start, index); index++; stack.push(start); onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const succ = [...(adj.get(top.v) ?? [])].sort(cmp);
      if (top.i < succ.length) {
        const w = succ[top.i++]!;
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1]!.v; low.set(p, Math.min(low.get(p)!, low.get(top.v)!)); }
      if (low.get(top.v) === idx.get(top.v)) {
        const comp: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== top.v);
        out.push(comp.sort(cmp));
      }
    }
  }
  return out.sort((a, b) => b.length - a.length || cmp(a[0]!, b[0]!));
}

function pickFlows(graph: RepoGraph, out: Map<string, GraphEdge[]>, byId: Map<string, GraphNode>, entries: EntryPoint[], opts: AnalyzeOptions): FlowCandidate[] {
  const starts = new Map<string, { kind: EntryKind }>();
  for (const e of entries) if (['page', 'endpoint', 'server-action', 'worker', 'management-command'].includes(e.kind) && byId.get(e.ref)?.kind !== 'module') starts.set(e.ref, { kind: e.kind });
  const all: FlowCandidate[] = [];
  for (const [entry, { kind }] of [...starts].sort(([a], [b]) => cmp(a, b))) {
    const seen = new Map<string, number>([[entry, 0]]);
    const queue = [entry];
    let writes = false, http = false, maxDepth = 0;
    while (queue.length && seen.size < 60) {
      const v = queue.shift()!;
      const d = seen.get(v)!;
      if (d >= 6) continue;
      for (const kindName of FLOW_KINDS) {
        for (const e of (out.get(v) ?? []).filter((x) => x.kind === kindName).sort((a, b) => cmp(a.target, b.target))) {
          if (e.kind === 'writes-model') writes = true;
          if (e.kind === 'http' || e.kind === 'fetches') http = true;
          if (seen.has(e.target) || seen.size >= 60) continue;
          seen.set(e.target, d + 1); maxDepth = Math.max(maxDepth, d + 1); queue.push(e.target);
        }
      }
    }
    const n = byId.get(entry)!;
    const h = n.meta.http;
    const title = h ? (n.kind === 'route' ? `Page ${n.label}` : `${h.methods.join('|')} ${h.fullPath ?? h.pathTemplate}`) : `${kind === 'server-action' ? 'Server action' : kind === 'management-command' ? 'Command' : 'Job'} ${n.label}`;
    const nodes = [...seen.keys()].sort(cmp);
    const authy = AUTH.test(title) || nodes.some((id) => AUTH.test(byId.get(id)?.label ?? ''));
    const mutating = writes || kind === 'server-action' || nodes.some((id) => byId.get(id)?.meta.role === 'server-action') || (!!h && n.kind === 'endpoint' && h.methods.some((m) => /POST|PUT|PATCH/.test(m)));
    const reach = seen.size - 1;
    const score = round(reach + 1.5 * maxDepth + (writes ? 3 : 0) + (authy ? 2 : 0) + (http ? 2 : 0) + (kind === 'endpoint' || kind === 'page' ? 1 : 0));
    if (reach === 0) continue;
    const why = [`reaches ${reach} node${reach === 1 ? '' : 's'} (depth ${maxDepth})`, writes && 'writes a model', http && 'crosses an HTTP boundary', authy && 'touches auth'].filter(Boolean).join('; ');
    const tags = [authy && 'auth', mutating && 'write', (kind === 'worker' || kind === 'management-command') && 'job'].filter((x): x is string => !!x);
    all.push({ id: `flow:${entry}`, entry, title, category: 'top', tags, score, reach, depth: maxDepth, nodes, reason: why, ...(AUTH.test(title) ? { authTitle: true } : {}) } as FlowCandidate);
  }
  const limit = opts.maxFlows ?? { quick: 5, standard: 8, deep: 12 }[opts.depth ?? 'standard'];
  const ranked = all.sort((a, b) => b.score - a.score || cmp(a.id, b.id));
  const picked: FlowCandidate[] = [];
  const similar = (a: FlowCandidate, b: FlowCandidate) => {
    const sa = new Set(a.nodes.filter((x) => x !== a.entry)), sb = b.nodes.filter((x) => x !== b.entry);
    const inter = sb.filter((x) => sa.has(x)).length;
    return inter / Math.max(1, sa.size + sb.length - inter) >= 0.85;
  };
  const take = (f: FlowCandidate | undefined, category: FlowCandidate['category']) => {
    if (!f || picked.length >= limit || picked.includes(f) || picked.some((p) => similar(p, f))) return;
    f.category = category;
    picked.push(f);
  };
  // Spec: auth/login, the main create/update path and background jobs get a slot first; an auth-named entry beats one that only passes auth middleware.
  const isAuthTitle = (f: FlowCandidate) => !!(f as FlowCandidate & { authTitle?: boolean }).authTitle;
  take(ranked.find((f) => f.tags.includes('auth') && isAuthTitle(f)) ?? ranked.find((f) => f.tags.includes('auth')), 'auth');
  take(ranked.find((f) => f.tags.includes('write') && !picked.includes(f)), 'write');
  take(ranked.find((f) => f.tags.includes('job')), 'job');
  for (const f of ranked) take(f, 'top');
  for (const f of all) delete (f as FlowCandidate & { authTitle?: boolean }).authTitle;
  return picked.sort((a, b) => b.score - a.score || cmp(a.id, b.id));
}

