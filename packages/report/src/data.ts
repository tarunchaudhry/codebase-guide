import type { Analysis, Explanations, GraphEdge, GraphNode, RepoGraph, Warning } from '../../core/src/index.ts';

export type { Analysis, Explanations, GraphEdge, GraphNode, RepoGraph, Warning };
export type { FlowOut, FlowStep, Claim } from '../../core/src/index.ts';

export interface Snippet { path: string; start: number; lines: string[]; redacted: number }
export interface PatternHint { pattern: string; count: number; examples: { path: string; line: number }[] }
export interface RecipeCandidate { task: string; examples: { nodeId: string; path: string; line: number }[] }

export interface ReportMeta {
  repoName: string; repoRoot: string; commit?: string; head?: string; dirty?: boolean; stale: boolean;
  generatedAt: string; version: string; depth: string; mode: 'full' | 'deterministic';
  editorScheme: 'vscode' | 'cursor' | 'idea'; snippets: boolean; limitations: string[];
}
export interface ReportData {
  meta: ReportMeta; graph: RepoGraph; analysis: Analysis; explanations: Explanations | null;
  hints: { patterns: PatternHint[]; recipes: RecipeCandidate[] };
  snippets: Record<string, Snippet>;
}

declare global { interface Window { __CG_DATA__?: ReportData } }

type PackedRow = [number, number, number, number, 0 | 1, GraphEdge['meta'] | 0, [number, number][] | 0];
interface Packed { kinds: string[]; paths: string[]; rows: PackedRow[] }

export function loadData(): ReportData {
  let d = window.__CG_DATA__;
  if (!d) {
    const el = document.getElementById('cg-data');
    if (!el?.textContent) throw new Error('No report data embedded. Generate the report with /codebase-guide or /repo-map.');
    d = JSON.parse(el.textContent) as ReportData;
  }
  // render.mjs packs edges as integer rows; rebuild the GraphEdge objects once.
  const g = d.graph as RepoGraph & { packedEdges?: Packed };
  if (g.packedEdges) {
    const { kinds, paths, rows } = g.packedEdges;
    const nodes = g.nodes;
    g.edges = rows.map(([k, s, t, w, inf, meta, ev]) => {
      const kind = kinds[k] as GraphEdge['kind'], source = nodes[s]!.id, target = nodes[t]!.id;
      return { id: `${kind}:${source}->${target}`, kind, source, target, weight: w, ...(inf ? { inferred: true } : {}), ...(meta ? { meta } : {}), ...(ev ? { evidence: ev.map(([p, line]) => ({ path: paths[p]!, line })) } : {}) };
    });
    delete g.packedEdges;
  }
  return d;
}

/** Indexes over the graph, built once. */
export class Store {
  readonly byId = new Map<string, GraphNode>();
  readonly out = new Map<string, GraphEdge[]>();
  readonly inc = new Map<string, GraphEdge[]>();
  readonly children = new Map<string, GraphNode[]>();
  readonly moduleByPath = new Map<string, string>();
  private moduleCache = new Map<string, string | null>();
  readonly d: ReportData;
  constructor(d: ReportData) {
    this.d = d;
    for (const n of d.graph.nodes) {
      this.byId.set(n.id, n);
      if (n.kind === 'module' && n.path) this.moduleByPath.set(n.path, n.id);
      if (n.parent) (this.children.get(n.parent) ?? this.children.set(n.parent, []).get(n.parent)!).push(n);
    }
    for (const e of d.graph.edges) {
      (this.out.get(e.source) ?? this.out.set(e.source, []).get(e.source)!).push(e);
      (this.inc.get(e.target) ?? this.inc.set(e.target, []).get(e.target)!).push(e);
    }
  }
  node(id: string) { return this.byId.get(id); }
  outs(id: string, kinds?: string[]) { return (this.out.get(id) ?? []).filter((e) => !kinds || kinds.includes(e.kind)); }
  ins(id: string, kinds?: string[]) { return (this.inc.get(id) ?? []).filter((e) => !kinds || kinds.includes(e.kind)); }
  kids(id: string) { return this.children.get(id) ?? []; }
  moduleOf(id: string): string | null {
    if (this.moduleCache.has(id)) return this.moduleCache.get(id)!;
    let n = this.byId.get(id);
    let r: string | null = null;
    while (n) {
      if (n.kind === 'module') { r = n.id; break; }
      if (n.path && n.kind !== 'project' && this.moduleByPath.has(n.path)) { r = this.moduleByPath.get(n.path)!; break; }
      n = n.parent ? this.byId.get(n.parent) : undefined;
    }
    this.moduleCache.set(id, r);
    return r;
  }
  ancestorAt(id: string, level: number): string | null {
    let n = this.byId.get(id);
    while (n && n.level > level && n.parent) n = this.byId.get(n.parent);
    return n && n.level <= level ? n.id : null;
  }
  projectOf(id: string): GraphNode | undefined {
    let n = this.byId.get(id);
    while (n && n.kind !== 'project') n = n.parent ? this.byId.get(n.parent) : undefined;
    return n;
  }
  /** The handler symbol behind an endpoint (or the node itself). */
  handler(id: string): GraphNode | undefined {
    const h = this.outs(id, ['handles'])[0];
    return h ? this.byId.get(h.target) : this.byId.get(id);
  }
  endpointsOf(handlerId: string): GraphNode[] {
    return this.ins(handlerId, ['handles']).map((e) => this.byId.get(e.source)!).filter((n) => n && (n.kind === 'endpoint' || n.kind === 'route'));
  }
  explainFile(id: string) { return this.d.explanations?.files[id]; }
  explainSymbol(id: string) { return this.d.explanations?.symbols[id]; }
  explainModule(id: string) { return this.d.explanations?.modules[id]; }
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const shortId = (id: string) => id.replace(/^[a-z]+:[a-z-]+:/, '');
export const groupPath = (id: string) => id.replace(/^[a-z]+:module-group:/, '');

export function routeLabel(n: GraphNode): string {
  const h = n.meta.http;
  if (!h) return n.label;
  return n.kind === 'route' ? `PAGE ${n.label}` : `${h.methods.join('|')} ${h.fullPath ?? `${h.pathTemplate} (prefix unknown)`}`;
}

/** Role families drive node colors (spec: UI, endpoint/controller/view, service/dependency, model/schema, middleware, util, test). */
export type Family = 'ui' | 'endpoint' | 'service' | 'model' | 'middleware' | 'util' | 'test' | 'config';
export function familyOf(n: GraphNode): Family {
  const r = n.meta.role ?? '';
  if (n.kind === 'env-var' || n.kind === 'script' || r === 'settings') return 'config';
  if (r === 'test' || /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.|(^|\/)test_[^/]*\.py$/.test(n.path ?? '')) return 'test';
  if (n.kind === 'model' || ['model', 'abstract-model', 'schema', 'serializer'].includes(r)) return 'model';
  if (r === 'middleware' || r === 'signal-handler') return 'middleware';
  if (n.kind === 'endpoint' || n.kind === 'route-group' || ['route', 'controller', 'view', 'viewset', 'router', 'urlconf', 'app', 'blueprint', 'route-handler', 'app-router', 'pages-router'].includes(r)) return 'endpoint';
  if (n.kind === 'component' || n.kind === 'route' || ['page', 'layout', 'template', 'loading', 'error', 'not-found', 'default', 'document', 'global-error'].includes(r) || n.meta.runtime === 'client') return 'ui';
  if (['provider', 'service', 'dependency', 'nest-module', 'server-action', 'plugin', 'management-command'].includes(r)) return 'service';
  return 'util';
}
export const FAMILY_LABEL: Record<Family, string> = {
  ui: 'UI', endpoint: 'Endpoint / controller / view', service: 'Service / dependency', model: 'Model / schema', middleware: 'Middleware', util: 'Module / util', test: 'Test', config: 'Config',
};

/** One-line deterministic description, used when there's no Claude summary (or in /repo-map). */
export function structuralSummary(s: Store, n: GraphNode): string {
  if (n.kind === 'module') {
    const kids = s.kids(n.id);
    const role = n.meta.role ? `${n.meta.framework ? `${n.meta.framework} ` : ''}${n.meta.role}` : '';
    const fns = kids.filter((k) => ['function', 'class', 'component'].includes(k.kind)).map((k) => k.label);
    const eps = s.d.graph.nodes.filter((e) => e.kind === 'endpoint' && s.handler(e.id) && s.moduleOf(s.handler(e.id)!.id) === n.id).length;
    const parts = [role && `${role} file`, eps && `${eps} endpoint${eps > 1 ? 's' : ''}`, fns.length && `defines ${fns.slice(0, 3).join(', ')}${fns.length > 3 ? ` +${fns.length - 3}` : ''}`].filter(Boolean);
    return parts.length ? capitalize(parts.join('; ')) : `${n.meta.loc ?? 0} lines`;
  }
  if (n.kind === 'module-group') {
    const files = s.kids(n.id).filter((k) => k.kind === 'module').length;
    const sub = s.kids(n.id).filter((k) => k.kind === 'module-group').length;
    return `${files} file${files === 1 ? '' : 's'}${sub ? `, ${sub} subfolder${sub === 1 ? '' : 's'}` : ''}`;
  }
  return n.meta.doc?.split('\n')[0] ?? n.meta.signature ?? n.label;
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function editorUrl(meta: ReportMeta, path: string, line: number): string {
  const abs = `${meta.repoRoot.replace(/\/$/, '')}/${path}`;
  if (meta.editorScheme === 'idea') return `idea://open?file=${encodeURIComponent(abs)}&line=${line}`;
  return `${meta.editorScheme}://file/${encodeURI(abs)}:${line}`;
}
