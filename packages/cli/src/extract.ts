import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OUTPUT_DIR, canonicalJson, gitHead, linkHttp, listFiles, loadConfig, mergeGraphs, writeFileEnsured, type RepoGraph } from '@codebase-guide/core';
import { extractTs } from '@codebase-guide/adapter-ts';
import { extractPy } from '@codebase-guide/adapter-py';

export interface ExtractRun { graph: RepoGraph; graphPath: string; ms: number; parsed: string[]; cached: number }

export interface ExtractOptions { useCache?: boolean; python?: string }

export async function runExtract(target: string, opts: ExtractOptions = {}): Promise<ExtractRun> {
  const t0 = performance.now();
  const root = realpathSync(resolve(target));
  const { config, warnings: cfgWarnings } = loadConfig(root);
  const files = listFiles(root, { include: config.include, exclude: config.exclude });
  const useCache = opts.useCache !== false;
  const [ts, py] = await Promise.all([
    extractTs(root, files, { useCache, apiClients: config.apiClients }),
    extractPy(root, files, { python: opts.python ?? config.python, pythonPath: config.pythonPath, djangoSettings: config.djangoSettings, apiClients: config.apiClients, useCache }),
  ]);
  const commit = gitHead(root);
  const base = { repoRoot: root, ...(commit ? { commit } : {}) };
  const structural = mergeGraphs([ts.graph, py.graph, { nodes: [], edges: [], warnings: cfgWarnings.map((m) => ({ code: 'config', message: m })) }], base);
  // Link stage: cross-language HTTP edges (always inferred, with confidence).
  const links = linkHttp(structural, [...(ts.graph.outbound ?? []), ...(py.graph.outbound ?? [])], { baseUrls: config.baseUrls });
  const carried = Object.fromEntries(Object.entries(structural.stats).filter(([k]) => !k.startsWith('nodes.') && !k.startsWith('edges.')));
  const graph = mergeGraphs([{ ...structural, stats: carried }, links], base);
  graph.stats.files = files.length;
  const graphPath = join(root, OUTPUT_DIR, 'graph.json');
  writeFileEnsured(graphPath, canonicalJson(graph));
  return { graph, graphPath, ms: Math.round(performance.now() - t0), parsed: [...ts.run.parsed, ...py.run.parsed].sort(), cached: ts.run.cached + py.run.cached };
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'no-cache': { type: 'boolean' } } });
  const r = await runExtract(positionals[0] ?? '.', { useCache: !values['no-cache'] });
  const s = r.graph.stats;
  const count = (p: string) => Object.entries(s).filter(([k]) => k.startsWith(p)).map(([k, v]) => `${k.slice(p.length)}=${v}`).join(' ');
  console.log(`graph: ${r.graphPath}`);
  console.log(`time: ${r.ms} ms (parsed ${r.parsed.length}, cached ${r.cached})`);
  console.log(`nodes: ${count('nodes.')}`);
  console.log(`edges: ${count('edges.')}`);
  console.log(`warnings: ${r.graph.warnings.map((w) => `${w.code}×${w.count ?? 1}`).join(', ') || 'none'}`);
}
