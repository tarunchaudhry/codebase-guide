import { EdgeSet, Warnings } from './graph.ts';
import type { GraphNode, OutboundCall, PartialGraph, RepoGraph } from './schema.ts';

export type Confidence = 'high' | 'medium' | 'low';
type Seg = { lit: string } | { param: true } | { rest: true };

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i;

/** Endpoint path → segments. Handles `{id}`, `:id`, `[id]`, `[...slug]`, `[[...slug]]`, `<int:id>`, `(?P<pk>…)`, `*`. */
export function endpointSegments(path: string): Seg[] {
  return splitPath(path).map((s): Seg => {
    if (/^\[\[?\.\.\./.test(s) || s === '*' || /^:\w+[*+]$/.test(s) || /^\{\w+:path\}$/.test(s) || /^<path:\w+>$/.test(s)) return { rest: true };
    if (/^\{[^}]*\}$/.test(s) || /^:\w+\??$/.test(s) || /^\[[^\]]+\]$/.test(s) || /^<[^>]+>$/.test(s) || /[()?*+\\^$|]/.test(s)) return { param: true };
    return { lit: s };
  });
}

function splitPath(p: string): string[] {
  return p.split('?')[0]!.split('#')[0]!.split('/').filter((s) => s !== '');
}

/** Outbound URL template → path segments, or 'external' for absolute URLs to hosts we don't serve. */
export function outboundSegments(url: string, baseUrls: string[]): Seg[] | 'external' {
  let u = url.trim();
  for (const b of [...baseUrls].sort((a, b) => b.length - a.length)) {
    if (b && u.startsWith(b)) { u = u.slice(b.length); break; }
  }
  if (LOCAL_HOST.test(u)) u = u.replace(LOCAL_HOST, '');
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('//')) return 'external';
  return splitPath(u).map((s): Seg => (/\{[^}]*\}/.test(s) ? { param: true } : { lit: s }));
}

/** Compare outbound segments to an endpoint's. Returns the best confidence or undefined. */
export function matchSegments(out: Seg[], ep: Seg[]): Confidence | undefined {
  let exact = true;
  let paramMismatch = false;
  for (let i = 0; i < Math.max(out.length, ep.length); i++) {
    const o = out[i], e = ep[i];
    if (e && 'rest' in e) { exact = false; return out.length > i ? (paramMismatch ? 'low' : 'medium') : undefined; }
    if (!o || !e) return prefix(out, ep);
    if ('lit' in o && 'lit' in e) { if (o.lit !== e.lit) return undefined; continue; }
    exact = false;
    if ('param' in e) continue;           // endpoint param, any outbound segment → normalized match
    paramMismatch = true;                 // outbound param vs endpoint literal: possible but unproven
  }
  return exact ? 'high' : paramMismatch ? 'low' : 'medium';
}

function prefix(out: Seg[], ep: Seg[]): Confidence | undefined {
  const n = Math.min(out.length, ep.length);
  if (n === 0) return undefined;
  for (let i = 0; i < n; i++) {
    const o = out[i]!, e = ep[i]!;
    if ('lit' in o && 'lit' in e && o.lit !== e.lit) return undefined;
    if ('rest' in e) return undefined;
  }
  return out.slice(0, n).some((s) => 'lit' in s) ? 'low' : undefined;
}

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const MAX_LOW_LINKS = 3;

/**
 * Link outbound HTTP calls to endpoints by method + path. Every edge is `inferred: true` with a confidence:
 * high = exact literal path, medium = param-normalized (or behind a dynamic base / unknown method), low = prefix-only.
 * Fully dynamic URLs are never linked; they are counted.
 */
export function linkHttp(graph: Pick<RepoGraph, 'nodes'>, calls: OutboundCall[], opts: { baseUrls?: string[] | undefined } = {}): PartialGraph {
  const edges = new EdgeSet();
  const warnings = new Warnings();
  const stats: Record<string, number> = {};
  const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const endpoints = graph.nodes
    .filter((n): n is GraphNode & { meta: { http: NonNullable<GraphNode['meta']['http']> } } => n.kind === 'endpoint' && !!n.meta.http?.fullPath)
    .map((n) => ({ id: n.id, methods: n.meta.http.methods, segs: endpointSegments(n.meta.http.fullPath!) }));
  const sorted = [...calls].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.src < b.src ? -1 : 1)));
  for (const c of sorted) {
    bump('http.outbound');
    if (c.url === null) { bump('http.dynamicUrls'); warnings.add('http-dynamic-url', 'Outbound HTTP calls with a fully dynamic URL (not linked)', c.file); continue; }
    const segs = outboundSegments(c.url, opts.baseUrls ?? []);
    if (segs === 'external') { bump('http.externalUrls'); continue; }
    let best: Confidence | undefined;
    let hits: string[] = [];
    for (const ep of endpoints) {
      const methodOk = c.method === null || ep.methods.some((m) => m === c.method || m === '*' || m === 'ALL');
      if (!methodOk) continue;
      const conf = matchSegments(segs, ep.segs); // rank by raw specificity first …
      if (!conf) continue;
      if (!best || RANK[conf] > RANK[best]) { best = conf; hits = [ep.id]; }
      else if (conf === best) hits.push(ep.id);
    }
    if (!best) { bump('http.unmatched'); continue; }
    if ((c.dynamicBase || c.method === null) && best === 'high') best = 'medium'; // … then cap what we can't prove
    if (best === 'low' && hits.length > MAX_LOW_LINKS) { bump('http.ambiguousLow'); continue; }
    for (const id of hits.sort()) edges.add('http', c.src, id, { path: c.file, line: c.line }, { inferred: true, meta: { confidence: best } });
    bump(`http.linked.${best}`);
  }
  return { nodes: [], edges: edges.values(), warnings: warnings.values(), stats };
}
