import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Analysis } from './analyze.ts';
import { FLOW_KINDS, TEST_PATH } from './analyze.ts';
import type { GuideConfig } from './config.ts';
import { OUTPUT_DIR, isSecretPath, sha1, writeFileEnsured } from './files.ts';
import { canonicalJson } from './graph.ts';
import type { GraphEdge, GraphNode, RepoGraph } from './schema.ts';

/** Bump an agent's version whenever its prompt or output schema changes: it invalidates that agent's cache. */
export const PROMPT_VERSIONS = { 'module-summarizer': 1, 'architecture-writer': 1, 'flow-tracer': 1, 'guide-writer': 1 } as const;
export type AgentName = keyof typeof PROMPT_VERSIONS;
export type Depth = 'quick' | 'standard' | 'deep';

export interface ExplainTask {
  id: string; agent: AgentName; stage: 1 | 2; title: string; key: string;
  /** Paths relative to the repo root. */
  input: string; output: string;
  cached: boolean; estTokens: number; estReads: number;
}
export interface ExplainPlan {
  version: 1; depth: Depth; commit?: string;
  tasks: ExplainTask[];
  /** estTokens = input + output (incl. cache writes); estTokensWithCacheReads adds the much larger, much cheaper cache re-reads. */
  budget: { tasks: number; toRun: number; cached: number; estTokens: number; estTokensWithCacheReads: number; estFileReads: number; confirmAboveTokens: number; needsConfirm: boolean };
}

export const EXPLAIN_DIR = `${OUTPUT_DIR}/explain`;
export const EXPLAIN_CACHE = `${OUTPUT_DIR}/cache/explain`;

const DEPTH = {
  quick: { unitFiles: 40, symbolsPerFile: 2, reads: 8 },
  standard: { unitFiles: 20, symbolsPerFile: 4, reads: 20 },
  deep: { unitFiles: 10, symbolsPerFile: 8, reads: 40 },
} as const;
const DEFAULT_CONFIRM_TOKENS = 300_000;
/** Rough per-agent overhead (system prompt + tool schemas + instructions), used only for the estimate. */
const AGENT_OVERHEAD = 6_000;
/**
 * Calibration against measured `claude -p /codebase-guide` runs (fixtures 06 and 09, standard depth, 2026-10):
 * raw estimate 141k / 136k → measured input+output (incl. cache writes) 272k / 204k, and 1.75M / 1.11M including cache reads.
 * ponytail: two fixture runs is a thin sample; re-fit when more real runs are measured.
 */
export const EST_CALIBRATION = { inOut: 1.7, withCacheReads: 10 };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const shortId = (s: string) => sha1(s).slice(0, 10);

export interface PrepareOptions { depth: Depth; config: GuideConfig; useCache: boolean; requestedFlow?: { description: string; entry?: string } }

export function prepareExplain(root: string, graph: RepoGraph, analysis: Analysis, opts: PrepareOptions): ExplainPlan {
  const d = DEPTH[opts.depth];
  const maxReads = opts.config.budget?.maxFileReads ?? d.reads;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) if (n.parent) (children.get(n.parent) ?? children.set(n.parent, []).get(n.parent)!).push(n);
  const hashCache = new Map<string, string>();
  const fileHash = (p: string) => {
    if (!hashCache.has(p)) {
      const abs = join(root, p);
      hashCache.set(p, !isSecretPath(p) && existsSync(abs) ? sha1(readFileSync(abs)) : 'missing');
    }
    return hashCache.get(p)!;
  };
  const fileSize = (p: string) => { try { return isSecretPath(p) ? 0 : statSync(join(root, p)).size; } catch { return 0; } };
  const common = {
    repoRoot: root, graphPath: join(root, OUTPUT_DIR, 'graph.json'), depth: opts.depth, maxFileReads: maxReads,
    ...(opts.config.audience ? { audience: opts.config.audience } : {}),
    ...(opts.config.customConventions ? { customConventions: opts.config.customConventions } : {}),
  };
  const tasks: ExplainTask[] = [];
  mkdirSync(join(root, EXPLAIN_DIR, 'out'), { recursive: true });
  const write = (id: string, agent: AgentName, stage: 1 | 2, title: string, input: object, keyParts: unknown, est: { reads: number; bytes: number; out: number }) => {
    const key = sha1(canonicalJson({ v: PROMPT_VERSIONS[agent], agent, keyParts }));
    const inputRel = `${EXPLAIN_DIR}/inputs/${id}.json`;
    const outputRel = `${EXPLAIN_DIR}/out/${id}.json`;
    const cachePath = join(root, EXPLAIN_CACHE, `${key}.json`);
    const cached = opts.useCache && existsSync(cachePath);
    const body = { task: { id, agent, title, promptVersion: PROMPT_VERSIONS[agent], outputPath: join(root, outputRel) }, ...common, ...input };
    const json = canonicalJson(body, 1);
    writeFileEnsured(join(root, inputRel), json);
    // Restore a cache hit into out/ (downstream agents read summaries from there); clear stale output for tasks that will run.
    if (cached) writeFileEnsured(join(root, outputRel), readFileSync(cachePath, 'utf8'));
    else rmSync(join(root, outputRel), { force: true });
    const reads = Math.min(maxReads, est.reads);
    const estTokens = Math.round((AGENT_OVERHEAD + json.length / 3.5 + Math.min(est.bytes, reads * 12_000) / 3.5 + est.out) * EST_CALIBRATION.inOut);
    tasks.push({ id, agent, stage, title, key, input: inputRel, output: outputRel, cached, estTokens, estReads: reads });
    return key;
  };

  // ---- stage 1: module-summarizer per unit ------------------------------------------------
  const units = moduleUnits(graph, children, d.unitFiles);
  const moduleKeys: Record<string, string> = {};
  const moduleOutputs: { unit: string; title: string; output: string }[] = [];
  const unitOfModule = new Map<string, string>();
  for (const u of units) for (const m of u.modules) unitOfModule.set(m.id, u.groupId);
  const unusedSet = new Set(analysis.unusedExports.map((u) => u.id));
  const untestedSet = new Set(analysis.untested);
  // Indexes (prepare used to rescan every edge per file: minutes on a 1k-file repo).
  const importsOut = new Map<string, string[]>(), importsIn = new Map<string, string[]>(), envBySource = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind === 'imports') {
      const sp = byId.get(e.source)?.path, tp = byId.get(e.target)?.path;
      if (tp) (importsOut.get(e.source) ?? importsOut.set(e.source, []).get(e.source)!).push(tp);
      if (sp) (importsIn.get(e.target) ?? importsIn.set(e.target, []).get(e.target)!).push(sp);
    } else if (e.kind === 'reads-env') (envBySource.get(e.source) ?? envBySource.set(e.source, new Set()).get(e.source)!).add(byId.get(e.target)?.label ?? '');
  }
  const handlerOf = handlerIndex(graph);
  const endpointsByModule = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.kind !== 'endpoint' || !n.meta.http) continue;
    let m: GraphNode | undefined = byId.get(handlerOf.get(n.id) ?? n.id);
    while (m && m.kind !== 'module') m = m.parent ? byId.get(m.parent) : undefined;
    if (m) (endpointsByModule.get(m.id) ?? endpointsByModule.set(m.id, []).get(m.id)!).push(`${n.meta.http.methods.join('|')} ${n.meta.http.fullPath ?? n.meta.http.pathTemplate}`);
  }
  for (const u of units) {
    const files = u.modules.map((m) => {
      const mm = analysis.modules[m.id];
      const inFile = descendants(m.id, children);
      const syms = inFile
        .filter((n) => ['function', 'class', 'component', 'method', 'model'].includes(n.kind) && (n.meta.exported || (analysis.symbols[n.id]?.fanIn ?? 0) > 0))
        .sort((a, b) => (analysis.symbols[b.id]?.fanIn ?? 0) - (analysis.symbols[a.id]?.fanIn ?? 0) || (b.meta.loc ?? 0) - (a.meta.loc ?? 0) || cmp(a.id, b.id))
        .slice(0, d.symbolsPerFile);
      const env = new Set<string>();
      for (const id of [m.id, ...inFile.map((x) => x.id)]) for (const v of envBySource.get(id) ?? []) env.add(v);
      return {
        nodeId: m.id, path: m.path!, loc: m.meta.loc ?? 0,
        ...(m.meta.role ? { role: m.meta.role } : {}), ...(m.meta.framework ? { framework: m.meta.framework } : {}), ...(m.meta.runtime ? { runtime: m.meta.runtime } : {}),
        fanIn: mm?.fanIn ?? 0, fanOut: mm?.fanOut ?? 0,
        importedBy: cap([...(importsIn.get(m.id) ?? [])].sort(cmp), 6), importsFrom: cap([...(importsOut.get(m.id) ?? [])].sort(cmp), 6),
        symbols: syms.map((s) => ({
          nodeId: s.id, kind: s.kind, label: s.label, line: s.line ?? 1, fanIn: analysis.symbols[s.id]?.fanIn ?? 0,
          ...(s.meta.signature ? { signature: s.meta.signature } : {}), ...(s.meta.doc ? { doc: s.meta.doc } : {}), ...(s.meta.role ? { role: s.meta.role } : {}),
        })),
        endpoints: [...(endpointsByModule.get(m.id) ?? [])].sort(cmp),
        envVars: [...env].sort(cmp),
        flags: [unusedSet.size && inFile.some((s) => unusedSet.has(s.id)) ? 'has-unused-export-candidates' : '', untestedSet.has(m.id) ? 'no-tests' : ''].filter(Boolean),
      };
    });
    const id = `mod-${shortId(u.groupId + (u.part ? `#${u.part}` : ''))}`;
    const title = `${u.path}${u.part ? ` (part ${u.part})` : ''}`;
    const input = {
      unit: { nodeId: u.groupId, path: u.path, ...(u.part ? { part: u.part } : {}) },
      files,
      cycles: analysis.cycles.filter((c) => c.some((x) => unitOfModule.get(x) === u.groupId)),
    };
    const keyParts = { unit: u.groupId, part: u.part ?? 0, depth: opts.depth, audience: opts.config.audience ?? '', files: files.map((f) => [f.path, fileHash(f.path), f.symbols.map((s) => s.nodeId)]) };
    moduleKeys[id] = write(id, 'module-summarizer', 1, title, input, keyParts, { reads: files.length, bytes: files.reduce((s, f) => s + fileSize(f.path), 0), out: 150 + files.length * 120 });
    moduleOutputs.push({ unit: u.groupId, title, output: join(root, `${EXPLAIN_DIR}/out/${id}.json`) });
  }

  // ---- stage 2: architecture-writer -------------------------------------------------------
  const interactions = projectInteractions(graph, byId);
  const archInput = {
    projects: graph.projects,
    counts: analysis.counts,
    stack: analysis.facts.stack.map((s) => ({ name: s.name, version: s.version ?? s.declared ?? '', source: s.source })),
    layers: analysis.layers,
    readingOrder: analysis.readingOrder,
    entryPoints: cap(analysis.entryPoints.map((e) => ({ kind: e.kind, module: e.id, reason: e.reason })), 60),
    interactions,
    moduleSummaries: moduleOutputs,
  };
  const archKey = write('arch', 'architecture-writer', 2, 'Architecture overview', archInput,
    { modules: Object.values(moduleKeys).sort(cmp), reading: analysis.readingOrder, layers: analysis.layers, interactions, depth: opts.depth, audience: opts.config.audience ?? '' },
    { reads: Math.min(10, analysis.readingOrder.length), bytes: analysis.readingOrder.reduce((s, r) => s + fileSize(byId.get(r.id)?.path ?? ''), 0) + moduleOutputs.length * 2500, out: 3000 });
  void archKey;

  // ---- stage 2: flow-tracer per candidate --------------------------------------------------
  const flowInputs = analysis.flowCandidates.map((f) => ({ f, slice: flowSlice(f.nodes, f.entry, graph, byId) }));
  for (const { f, slice } of flowInputs) {
    const paths = [...new Set(slice.nodes.map((n) => n.path).filter((p): p is string => !!p))].sort(cmp);
    write(`flow-${shortId(f.entry)}`, 'flow-tracer', 2, f.title, { flow: { id: f.id, title: f.title, entry: f.entry, category: f.category, reason: f.reason }, ...slice },
      { flow: f.id, slice, files: paths.map((p) => [p, fileHash(p)]), depth: opts.depth },
      { reads: paths.length, bytes: paths.reduce((s, p) => s + fileSize(p), 0), out: 1800 });
  }
  // Flows asked for via /repo-flow persist in explain/requested.json so later full runs keep them.
  const storePath = join(root, EXPLAIN_DIR, 'requested.json');
  const stored = (existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : []) as { description: string; entry?: string }[];
  if (opts.requestedFlow && !stored.some((r) => r.description === opts.requestedFlow!.description && r.entry === opts.requestedFlow!.entry)) {
    stored.push(opts.requestedFlow);
    writeFileEnsured(storePath, canonicalJson(stored, 1));
  }
  const requested: { description: string; entry?: string }[] = [...analysis.requestedFlows.map((description) => ({ description })), ...stored];
  for (const r of requested) {
    const entries = graph.nodes.filter((n) => (n.kind === 'endpoint' || n.kind === 'route') && n.meta.http)
      .map((n) => ({ nodeId: n.id, route: `${n.kind === 'route' ? 'PAGE' : n.meta.http!.methods.join('|')} ${n.meta.http!.fullPath ?? n.meta.http!.pathTemplate}`, path: n.path ?? '' }));
    write(`flow-req-${shortId(r.description + (r.entry ?? ''))}`, 'flow-tracer', 2, r.description,
      { flow: { id: `flow:req:${shortId(r.description + (r.entry ?? ''))}`, title: r.description, requested: true, ...(r.entry ? { entryHint: r.entry } : {}) }, graphPath: join(root, OUTPUT_DIR, 'graph.json'), entries: cap(entries, 400) },
      // Requested flows aren't anchored to a slice up front, so any source change can affect them: key on all module hashes.
      { r, files: graph.nodes.filter((n) => n.kind === 'module').map((n) => fileHash(n.path!)), depth: opts.depth },
      { reads: 12, bytes: 12 * 6000, out: 2000 });
  }

  // ---- stage 2: guide-writer ---------------------------------------------------------------
  const guideInput = {
    runFacts: analysis.facts.run,
    envExample: analysis.facts.envExample.map((e) => ({ name: e.name, path: e.path, line: e.line })),
    patternHints: patternHints(graph),
    recipeCandidates: recipeCandidates(graph, analysis, byId),
    glossaryCandidates: glossaryCandidates(graph, analysis, byId),
    moduleSummaries: moduleOutputs,
  };
  write('guide', 'guide-writer', 2, 'Run locally, conventions, recipes, glossary', guideInput,
    { modules: Object.values(moduleKeys).sort(cmp), facts: guideInput.runFacts, hints: guideInput.patternHints, recipes: guideInput.recipeCandidates, glossary: guideInput.glossaryCandidates, depth: opts.depth, audience: opts.config.audience ?? '', custom: opts.config.customConventions ?? '' },
    { reads: 15, bytes: 15 * 6000 + moduleOutputs.length * 2500, out: 4000 });

  tasks.sort((a, b) => a.stage - b.stage || cmp(a.id, b.id));
  const toRun = tasks.filter((t) => !t.cached);
  const confirmAboveTokens = opts.config.budget?.confirmAboveTokens ?? DEFAULT_CONFIRM_TOKENS;
  const estTokens = toRun.reduce((s, t) => s + t.estTokens, 0);
  const plan: ExplainPlan = {
    version: 1, depth: opts.depth, ...(graph.commit ? { commit: graph.commit } : {}), tasks,
    budget: { tasks: tasks.length, toRun: toRun.length, cached: tasks.length - toRun.length, estTokens, estTokensWithCacheReads: Math.round((estTokens / EST_CALIBRATION.inOut) * EST_CALIBRATION.withCacheReads), estFileReads: toRun.reduce((s, t) => s + t.estReads, 0), confirmAboveTokens, needsConfirm: estTokens > confirmAboveTokens },
  };
  writeFileEnsured(join(root, EXPLAIN_DIR, 'plan.json'), canonicalJson(plan, 1));
  return plan;
}

const cap = <T>(xs: T[], n: number): T[] => xs.slice(0, n);

function descendants(id: string, children: Map<string, GraphNode[]>): GraphNode[] {
  const out: GraphNode[] = [];
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) { const n = stack.pop()!; out.push(n); stack.push(...(children.get(n.id) ?? [])); }
  return out;
}

/** endpoint/route id → handler id, from `handles` edges (first wins, edges are sorted). */
export function handlerIndex(graph: Pick<RepoGraph, 'edges'>): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of graph.edges) if (e.kind === 'handles' && !m.has(e.source)) m.set(e.source, e.target);
  return m;
}

export interface ModuleUnit { groupId: string; path: string; part?: number; modules: GraphNode[] }

/** Partition summarizable modules into units of ≤ `capFiles`: small subtrees merge, large folders split by child folder (then by chunk). */
export function moduleUnits(graph: RepoGraph, children: Map<string, GraphNode[]>, capFiles: number): ModuleUnit[] {
  const summarizable = (n: GraphNode) => n.kind === 'module' && (n.meta.loc ?? 0) > 0 && !TEST_PATH.test(n.path ?? '') && n.meta.role !== 'test' && !/\.d\.ts$/.test(n.path ?? '');
  const groupPath = (id: string) => id.replace(/^[a-z]+:module-group:/, '');
  const count = new Map<string, number>();
  const sub = (g: string): number => {
    if (count.has(g)) return count.get(g)!;
    let c = 0;
    for (const ch of children.get(g) ?? []) c += ch.kind === 'module-group' ? sub(ch.id) : summarizable(ch) ? 1 : 0;
    count.set(g, c);
    return c;
  };
  const all = (g: string): GraphNode[] => (children.get(g) ?? []).flatMap((ch) => (ch.kind === 'module-group' ? all(ch.id) : summarizable(ch) ? [ch] : []));
  const out: ModuleUnit[] = [];
  const visit = (g: string) => {
    const n = sub(g);
    if (!n) return;
    if (n <= capFiles) { out.push({ groupId: g, path: groupPath(g), modules: all(g).sort((a, b) => cmp(a.id, b.id)) }); return; }
    // Too big: the folder's own files plus small child subtrees are packed greedily into parts of ≤ capFiles;
    // only child folders that are themselves too big recurse. (Without packing, a Next app/ tree became one tiny unit per page.)
    const kids = (children.get(g) ?? []).filter((c) => c.kind === 'module-group').sort((a, b) => cmp(a.id, b.id));
    const items: GraphNode[][] = [
      ...(children.get(g) ?? []).filter(summarizable).sort((a, b) => cmp(a.id, b.id)).map((m) => [m]),
      ...kids.filter((k) => sub(k.id) > 0 && sub(k.id) <= capFiles).map((k) => all(k.id).sort((a, b) => cmp(a.id, b.id))),
    ];
    const bins: GraphNode[][] = [];
    for (const it of items) {
      const last = bins[bins.length - 1];
      if (last && last.length + it.length <= capFiles) last.push(...it); else bins.push([...it]);
    }
    bins.forEach((b, i) => out.push({ groupId: g, path: groupPath(g), ...(bins.length > 1 ? { part: i + 1 } : {}), modules: b }));
    for (const k of kids) if (sub(k.id) > capFiles) visit(k.id);
  };
  const roots = graph.nodes.filter((n) => n.kind === 'module-group' && !(n.parent && n.parent.includes(':module-group:'))).sort((a, b) => cmp(a.id, b.id));
  for (const r of roots) visit(r.id);
  return out;
}

/** The flow's nodes and the FLOW_KINDS edges among them, in walk-priority order. */
export function flowSlice(nodeIds: string[], entry: string, graph: RepoGraph, byId: Map<string, GraphNode>) {
  const set = new Set(nodeIds);
  const rank = new Map(FLOW_KINDS.map((k, i) => [k, i]));
  const edges = graph.edges
    .filter((e) => set.has(e.source) && set.has(e.target) && rank.has(e.kind))
    .sort((a, b) => rank.get(a.kind)! - rank.get(b.kind)! || (a.meta?.order ?? 0) - (b.meta?.order ?? 0) || cmp(a.source, b.source) || cmp(a.target, b.target))
    .map((e) => slimEdge(e));
  const moduleOf = (id: string) => { let n = byId.get(id); while (n && n.kind !== 'module') n = n.parent ? byId.get(n.parent) : undefined; return n?.id; };
  const nodes = nodeIds.map((id) => byId.get(id)!).filter(Boolean).map((n) => { const m = moduleOf(n.id); return { ...slimNode(n), ...(m && m !== n.id ? { module: m } : {}) }; });
  return { entry, nodes, edges };
}

export function slimNode(n: GraphNode) {
  return {
    nodeId: n.id, kind: n.kind, label: n.label, ...(n.path ? { path: n.path } : {}), ...(n.line ? { line: n.line } : {}), ...(n.endLine ? { endLine: n.endLine } : {}),
    ...(n.meta.role ? { role: n.meta.role } : {}), ...(n.meta.framework ? { framework: n.meta.framework } : {}), ...(n.meta.signature ? { signature: n.meta.signature } : {}),
    ...(n.meta.doc ? { doc: n.meta.doc } : {}), ...(n.meta.fields ? { fields: n.meta.fields } : {}), ...(n.meta.http ? { http: n.meta.http } : {}),
  };
}
const slimEdge = (e: GraphEdge) => ({
  kind: e.kind, source: e.source, target: e.target, ...(e.inferred ? { inferred: true } : {}),
  ...(e.meta?.confidence ? { confidence: e.meta.confidence } : {}), ...(e.meta?.order !== undefined ? { order: e.meta.order } : {}), ...(e.evidence ? { evidence: e.evidence.slice(0, 2) } : {}),
});

function projectInteractions(graph: RepoGraph, byId: Map<string, GraphNode>) {
  const projectOf = (id: string) => { let n = byId.get(id); while (n && n.kind !== 'project') n = n.parent ? byId.get(n.parent) : undefined; return n?.id; };
  const agg = new Map<string, { from: string; to: string; kind: string; count: number; evidence: { path: string; line: number }[] }>();
  for (const e of graph.edges) {
    if (!['imports', 'http', 'calls'].includes(e.kind)) continue;
    const a = projectOf(e.source), b = projectOf(e.target);
    if (!a || !b || a === b) continue;
    const k = `${a}|${b}|${e.kind}`;
    const x = agg.get(k) ?? { from: a, to: b, kind: e.kind, count: 0, evidence: [] };
    x.count++;
    if (x.evidence.length < 3 && e.evidence?.[0]) x.evidence.push(e.evidence[0]);
    agg.set(k, x);
  }
  return [...agg.values()].sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.kind, y.kind));
}

type Ev = { path: string; line: number };
// Folder-level nodes (module groups, Django apps) have no file to point at.
const evOf = (n: GraphNode | undefined): Ev | undefined => (n?.path && n.kind !== 'module-group' && n.meta.role !== 'django-app' ? { path: n.path, line: n.line ?? 1 } : undefined);

/** Deterministic pattern observations with example locations; the guide-writer names and explains them. */
export function patternHints(graph: RepoGraph) {
  const hints: { pattern: string; count: number; examples: Ev[] }[] = [];
  const add = (pattern: string, nodes: (GraphNode | undefined)[]) => {
    const ev = nodes.map(evOf).filter((x): x is Ev => !!x).sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
    if (ev.length) hints.push({ pattern, count: ev.length, examples: ev.slice(0, 3) });
  };
  const byRole = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) if (n.meta.role && n.kind !== 'script') (byRole.get(`${n.meta.framework ?? n.lang}:${n.meta.role}`) ?? byRole.set(`${n.meta.framework ?? n.lang}:${n.meta.role}`, []).get(`${n.meta.framework ?? n.lang}:${n.meta.role}`)!).push(n);
  for (const [k, ns] of [...byRole].sort(([a], [b]) => cmp(a, b))) {
    const dirs = [...new Set(ns.map((n) => posix.dirname(n.path ?? '')))].sort(cmp);
    add(`${k} (${ns.length}; in ${dirs.slice(0, 3).join(', ')}${dirs.length > 3 ? ', …' : ''})`, ns);
  }
  const edgeHint = (kind: string, label: string) => {
    const es = graph.edges.filter((e) => e.kind === kind);
    if (es.length) hints.push({ pattern: `${label} (${es.length} edges${es.some((e) => e.inferred) ? ', some inferred' : ''})`, count: es.length, examples: es.flatMap((e) => e.evidence?.slice(0, 1) ?? []).sort((a, b) => cmp(a.path, b.path) || a.line - b.line).slice(0, 3) });
  };
  edgeHint('injects', 'dependency injection');
  edgeHint('validates', 'request/response validation with schemas');
  edgeHint('middleware-chain', 'middleware / guards on routes');
  edgeHint('reads-model', 'ORM reads');
  edgeHint('writes-model', 'ORM writes');
  edgeHint('reads-env', 'environment variable reads');
  edgeHint('http', 'frontend → backend HTTP calls');
  edgeHint('uses-hook', 'React hooks');
  edgeHint('tests', 'tests importing the code they test');
  const testMods = graph.nodes.filter((n) => n.kind === 'module' && TEST_PATH.test(n.path ?? ''));
  if (testMods.length) add(`test files (${testMods.length}; naming like ${posix.basename(testMods[0]!.path!)})`, testMods);
  return hints;
}

/** Recipe tasks backed by ≥ 2 real examples in this repo (spec: no recipe otherwise). */
export function recipeCandidates(graph: RepoGraph, analysis: Analysis, byId: Map<string, GraphNode>) {
  const out: { task: string; examples: (Ev & { nodeId: string })[] }[] = [];
  const ex = (ns: GraphNode[]) => ns.map((n) => ({ nodeId: n.id, ...evOf(n)! })).filter((x) => x.path).sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
  const push = (task: string, ns: GraphNode[]) => { const e = ex(ns); if (e.length >= 2) out.push({ task, examples: e.slice(0, 4) }); };
  const handles = handlerIndex(graph);
  const handlerOf = (ep: GraphNode) => byId.get(handles.get(ep.id) ?? '') ?? ep;
  push('add an API endpoint', graph.nodes.filter((n) => n.kind === 'endpoint').map(handlerOf));
  const moduleByPath = new Map(graph.nodes.filter((m) => m.kind === 'module').map((m) => [m.path, m]));
  push('add a page/route', graph.nodes.filter((n) => n.kind === 'route').map((n) => moduleByPath.get(n.path) ?? n));
  const models = graph.nodes.filter((n) => n.kind === 'model' || n.meta.role === 'model');
  const migrations = graph.nodes.filter((n) => n.kind === 'module' && /(^|\/)(migrations|alembic\/versions)\//.test(n.path ?? ''));
  push(migrations.length ? 'add a model + migration' : 'add a model', models);
  push('add a service/dependency', [...new Map(graph.edges.filter((e) => e.kind === 'injects').map((e) => [e.target, byId.get(e.target)!])).values()].filter(Boolean)
    .concat(graph.nodes.filter((n) => n.meta.role === 'provider' || n.meta.role === 'service')));
  push('add a test', graph.nodes.filter((n) => n.kind === 'module' && TEST_PATH.test(n.path ?? '')));
  push('add an env var', graph.edges.filter((e) => e.kind === 'reads-env').map((e) => byId.get(e.source)!).filter(Boolean));
  void analysis;
  return out;
}

function glossaryCandidates(graph: RepoGraph, analysis: Analysis, byId: Map<string, GraphNode>) {
  const terms = new Map<string, { term: string; sources: string[]; refs: string[] }>();
  const add = (term: string, source: string, ref: string) => {
    const k = term.toLowerCase();
    if (k.length < 3 || /^(api|app|src|lib|index|main|utils?|components?|pages?|routes?|v\d+|id|new|edit|list|detail|admin|static|public|types?)$/.test(k)) return;
    const t = terms.get(k) ?? { term, sources: [], refs: [] };
    if (!t.sources.includes(source)) t.sources.push(source);
    if (t.refs.length < 4 && !t.refs.includes(ref)) t.refs.push(ref);
    terms.set(k, t);
  };
  for (const n of graph.nodes) {
    if (n.kind === 'model' || n.meta.role === 'model' || n.meta.role === 'schema' || n.meta.role === 'serializer') add(n.label, n.meta.role ?? n.kind, n.id);
    if ((n.kind === 'endpoint' || n.kind === 'route') && n.meta.http) for (const seg of (n.meta.http.fullPath ?? n.meta.http.pathTemplate).split('/')) if (/^[a-z][a-z-]+$/i.test(seg)) add(seg, 'route segment', n.id);
    if (n.kind === 'module-group') { const base = posix.basename(n.id.replace(/^[a-z]+:module-group:/, '')); if (/^[a-z][a-z-]+$/i.test(base)) add(base, 'folder', n.id); }
  }
  for (const [id, m] of Object.entries(analysis.symbols)) {
    const n = byId.get(id);
    if (n && m.fanIn >= 3 && (n.kind === 'class' || n.kind === 'component')) add(n.label, 'widely used class', id);
  }
  return [...terms.values()].sort((a, b) => b.sources.length - a.sources.length || b.refs.length - a.refs.length || cmp(a.term, b.term)).slice(0, 80);
}
