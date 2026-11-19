import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { OUTPUT_DIR, analyze, canonicalJson, listFiles, loadConfig, readJsonFile, writeFileEnsured, type Analysis, type RepoGraph } from '@codebase-guide/core';
import { runExtract } from './extract.ts';

export interface AnalyzeRun { graph: RepoGraph; analysis: Analysis; analysisPath: string; extractMs: number; analyzeMs: number }

/** Extract (cached) + link + analyze. Writes graph.json and analysis.json. */
export async function runAnalyze(target: string, opts: { depth?: 'quick' | 'standard' | 'deep'; useCache?: boolean; reuseGraph?: boolean } = {}): Promise<AnalyzeRun> {
  const root = realpathSync(resolve(target));
  const graphPath = join(root, OUTPUT_DIR, 'graph.json');
  let graph: RepoGraph, extractMs = 0;
  if (opts.reuseGraph && existsSync(graphPath)) graph = readJsonFile<RepoGraph>(graphPath)!;
  else { const r = await runExtract(root, { useCache: opts.useCache !== false }); graph = r.graph; extractMs = r.ms; }
  const t0 = performance.now();
  const { config } = loadConfig(root);
  const files = listFiles(root, { include: config.include, exclude: config.exclude });
  const analysis = analyze(graph, root, files, { depth: opts.depth ?? config.depth ?? 'standard', ...(config.maxFlows ? { maxFlows: config.maxFlows } : {}), ...(config.flows ? { flows: config.flows } : {}) });
  const analysisPath = join(root, OUTPUT_DIR, 'analysis.json');
  writeFileEnsured(analysisPath, canonicalJson(analysis));
  return { graph, analysis, analysisPath, extractMs, analyzeMs: Math.round(performance.now() - t0) };
}
