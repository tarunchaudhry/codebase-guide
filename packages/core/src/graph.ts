import type { EdgeKind, Evidence, GraphEdge, GraphNode, PartialGraph, RepoGraph, Warning } from './schema.ts';

/** Max evidence locations kept per edge (sorted, so the kept set is deterministic). */
export const MAX_EVIDENCE = 5;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpEvidence = (a: Evidence, b: Evidence) => cmp(a.path, b.path) || a.line - b.line;

export const edgeId = (kind: EdgeKind, source: string, target: string) => `${kind}:${source}->${target}`;

function mergeEvidence(a: Evidence[] = [], b: Evidence[] = []): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const e of [...a, ...b]) seen.set(`${e.path}:${e.line}`, e);
  return [...seen.values()].sort(cmpEvidence).slice(0, MAX_EVIDENCE);
}

/** Accumulates edges, merging duplicates (weight summed, evidence unioned). */
export class EdgeSet {
  private map = new Map<string, GraphEdge>();
  add(kind: EdgeKind, source: string, target: string, ev?: Evidence, extra?: Partial<GraphEdge>): void {
    const id = edgeId(kind, source, target);
    const prev = this.map.get(id);
    if (prev) {
      prev.weight += 1;
      if (ev) prev.evidence = mergeEvidence(prev.evidence, [ev]);
      return;
    }
    this.map.set(id, { id, source, target, kind, weight: 1, ...(ev ? { evidence: [ev] } : {}), ...extra });
  }
  values(): GraphEdge[] { return [...this.map.values()]; }
}

/** Aggregates warnings by code: one entry per code with a count and the first (sorted) path. */
export class Warnings {
  private map = new Map<string, { message: string; count: number; paths: Set<string> }>();
  add(code: string, message: string, path?: string, n = 1): void {
    const w = this.map.get(code) ?? { message, count: 0, paths: new Set<string>() };
    w.count += n;
    if (path) w.paths.add(path);
    this.map.set(code, w);
  }
  addAll(ws: Warning[]): void { for (const w of ws) this.add(w.code, w.message, w.path, w.count ?? 1); }
  values(): Warning[] {
    return [...this.map.entries()].map(([code, w]) => {
      const first = [...w.paths].sort(cmp)[0];
      return { code, message: w.message, count: w.count, ...(first ? { path: first } : {}) };
    });
  }
}

/**
 * Merge partial graphs into one. Nodes dedupe by id (first wins), edges dedupe by id
 * (weights summed, evidence unioned). Output is fully sorted so it is byte-stable.
 */
export function mergeGraphs(
  parts: PartialGraph[],
  base: { repoRoot: string; commit?: string },
): RepoGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const projects = new Map<string, RepoGraph['projects'][number]>();
  const warnings = new Warnings();
  const extraStats: Record<string, number> = {};
  for (const p of parts) {
    for (const pr of p.projects ?? []) {
      const prev = projects.get(pr.id);
      projects.set(pr.id, prev ? { ...prev, frameworks: [...new Set([...prev.frameworks, ...pr.frameworks])] } : pr);
    }
    for (const n of p.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of p.edges) {
      const prev = edges.get(e.id);
      if (!prev) { edges.set(e.id, { ...e, ...(e.evidence ? { evidence: [...e.evidence] } : {}) }); continue; }
      prev.weight += e.weight;
      if (e.evidence) prev.evidence = mergeEvidence(prev.evidence, e.evidence);
      if (prev.inferred && !e.inferred) delete prev.inferred;
    }
    warnings.addAll(p.warnings);
    for (const [k, v] of Object.entries(p.stats ?? {})) extraStats[k] = (extraStats[k] ?? 0) + v;
  }
  // Drop edges whose endpoints don't exist: the graph must only reference real nodes.
  let dangling = 0;
  for (const [id, e] of edges) if (!nodes.has(e.source) || !nodes.has(e.target)) { edges.delete(id); dangling++; }
  if (dangling) warnings.add('graph-dangling-edge', 'Edges dropped because an endpoint node is missing', undefined, dangling);

  const stats: Record<string, number> = { ...extraStats };
  for (const n of nodes.values()) stats[`nodes.${n.kind}`] = (stats[`nodes.${n.kind}`] ?? 0) + 1;
  for (const e of edges.values()) stats[`edges.${e.kind}`] = (stats[`edges.${e.kind}`] ?? 0) + 1;

  for (const pr of projects.values()) pr.frameworks.sort(cmp);
  return {
    version: 1,
    repoRoot: base.repoRoot,
    ...(base.commit ? { commit: base.commit } : {}),
    projects: [...projects.values()].sort((a, b) => cmp(a.id, b.id)),
    nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => cmp(a.id, b.id)),
    stats,
    warnings: warnings.values().sort((a, b) => cmp(a.code, b.code)),
  };
}

/** JSON with recursively sorted object keys: identical input → identical bytes. */
export function canonicalJson(value: unknown, indent?: number): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort(cmp)) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = sortKeys(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, indent) + '\n';
}

export interface RollupEdge { source: string; target: string; kind: EdgeKind; weight: number }

/**
 * Lift edges to the ancestors at `level` (0 project … 3 symbol), summing weights.
 * Edges inside one ancestor are dropped. Used for module-group views and semantic zoom.
 */
export function rollupEdges(graph: Pick<RepoGraph, 'nodes' | 'edges'>, level: 0 | 1 | 2, kinds?: EdgeKind[]): RollupEdge[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ancestorCache = new Map<string, string | null>();
  const ancestor = (id: string): string | null => {
    if (ancestorCache.has(id)) return ancestorCache.get(id)!;
    let n = byId.get(id);
    while (n && n.level > level && n.parent) n = byId.get(n.parent);
    const r = n && n.level <= level ? n.id : null;
    ancestorCache.set(id, r);
    return r;
  };
  const out = new Map<string, RollupEdge>();
  for (const e of graph.edges) {
    if (kinds && !kinds.includes(e.kind)) continue;
    const s = ancestor(e.source), t = ancestor(e.target);
    if (!s || !t || s === t) continue;
    const key = edgeId(e.kind, s, t);
    const prev = out.get(key);
    if (prev) prev.weight += e.weight; else out.set(key, { source: s, target: t, kind: e.kind, weight: e.weight });
  }
  return [...out.entries()].sort(([a], [b]) => cmp(a, b)).map(([, v]) => v);
}
