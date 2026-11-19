import type { RepoGraph } from './schema.ts';

/**
 * Human-readable route table: `METHOD fullPath → handler [middleware, …]`, sorted.
 * Endpoints whose prefix is unknown show the local path with "(prefix unknown)".
 */
export function routeTable(g: Pick<RepoGraph, 'nodes' | 'edges'>, opts: { pages?: boolean } = {}): string[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const n of g.nodes) {
    if (!(n.kind === 'endpoint' || (opts.pages && n.kind === 'route'))) continue;
    const http = n.meta.http;
    if (!http) continue;
    const handler = g.edges.find((e) => e.source === n.id && e.kind === 'handles');
    const chain = g.edges
      .filter((e) => e.source === n.id && e.kind === 'middleware-chain')
      .sort((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0))
      .map((e) => (byId.get(e.target)?.label ?? e.target) + (e.inferred ? '?' : ''));
    const path = n.kind === 'route' ? n.label : http.fullPath ?? `${http.pathTemplate} (prefix unknown)`;
    const kind = n.kind === 'route' ? 'PAGE' : http.methods.join('|');
    const h = handler ? byId.get(handler.target)?.label ?? handler.target : '∅';
    out.push(`${kind} ${path} → ${h}${chain.length ? ` [${chain.join(', ')}]` : ''}`);
  }
  return out.sort();
}
