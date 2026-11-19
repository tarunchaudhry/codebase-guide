import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Analysis } from './analyze.ts';
import { FLOW_KINDS } from './analyze.ts';
import { EXPLAIN_CACHE, EXPLAIN_DIR, recipeCandidates, type ExplainPlan, type ExplainTask } from './explain.ts';
import { isSecretPath, readJsonFile, writeFileEnsured } from './files.ts';
import { canonicalJson } from './graph.ts';
import type { Evidence, GraphNode, RepoGraph } from './schema.ts';

export type Section = 'overview' | 'architecture' | 'modules' | 'files' | 'symbols' | 'flows' | 'conventions' | 'recipes' | 'glossary' | 'runLocally';
export interface Grounding { claims: number; grounded: number; pct: number }
export type TaskStatus = 'ok' | 'retry' | 'partial' | 'missing';
export interface TaskResult { id: string; agent: string; title: string; status: TaskStatus; attempts: number; errors: string[]; cached: boolean }

/** Ref-checked explanations, merged for the renderer (`.codebase-guide/explain/validated.json`). */
export interface Explanations {
  version: 1;
  depth: string;
  modules: Record<string, ModuleSummary>;
  files: Record<string, { oneLine: string; responsibilities: string[] }>;
  symbols: Record<string, string>;
  architecture?: ArchitectureOut;
  flows: FlowOut[];
  guide?: GuideOut;
  grounding: Record<Section, Grounding> & { total: Grounding };
  flowSteps: { total: number; backed: number; pct: number };
  inferredClaims: number;
  readsUsed: number;
  tasks: TaskResult[];
}

export interface Claim { text: string; refs: string[]; evidence: Evidence[]; inferred?: boolean }
export interface ModuleSummary {
  nodeId: string; purpose: string; purposeInferred?: boolean; responsibilities: string[]; keyFiles: string[]; publicApi: string[];
  gotchas: Claim[]; openQuestions: string[]; files: string[];
}
export interface ArchitectureOut {
  overview: Claim; narrative: Claim[]; layers: { name: string; nodeIds: string[] }[];
  projectInteractions: (Claim & { from: string; to: string })[]; readingOrderReasons: Record<string, string>; openQuestions: string[];
}
export interface FlowStep { order: number; nodeId: string; via?: string; summary: string; dataIn?: string; dataOut?: string; evidence: Evidence[]; inferred?: boolean; inferredWhy?: string }
export interface FlowOut {
  id: string; title: string; story: string; entry: string; category?: string; steps: FlowStep[]; participants: string[];
  externalBoundaries: (Claim & { kind: string; name: string })[]; openQuestions: string[];
}
export interface GuideOut {
  runLocally: { step: string; command: string; source: Evidence }[];
  conventions: { name: string; description: string; examples: Evidence[]; confidence: 'convention' | 'observed-rarely'; inferred?: boolean; source?: 'config' }[];
  recipes: { task: string; steps: { text: string; exampleRef: string; evidence?: Evidence }[] }[];
  glossary: (Claim & { term: string; definition: string })[];
  openQuestions: string[];
}

const SECTIONS: Section[] = ['overview', 'architecture', 'modules', 'files', 'symbols', 'flows', 'conventions', 'recipes', 'glossary', 'runLocally'];
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Checks refs/evidence against the graph and the filesystem. One per validation run. */
export class RefChecker {
  readonly byId: Map<string, GraphNode>;
  private lines = new Map<string, number>();
  readonly pairs = new Map<string, Evidence | null>();
  readonly root: string;
  readonly graph: RepoGraph;
  constructor(root: string, graph: RepoGraph) {
    this.root = root;
    this.graph = graph;
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const flowKinds = new Set(FLOW_KINDS);
    for (const e of graph.edges) if (flowKinds.has(e.kind)) this.pairs.set(`${e.source}>${e.target}`, e.evidence?.[0] ?? this.pairs.get(`${e.source}>${e.target}`) ?? null);
  }
  node(id: string) { return this.byId.get(id); }
  lineCount(path: string): number {
    if (!this.lines.has(path)) {
      const ok = path && !path.startsWith('/') && !path.split('/').includes('..') && !isSecretPath(path) && existsSync(join(this.root, path)) && statSync(join(this.root, path)).isFile();
      this.lines.set(path, ok ? readFileSync(join(this.root, path), 'utf8').split('\n').length : 0);
    }
    return this.lines.get(path)!;
  }
  /** Keeps valid refs; reports the rest. */
  refs(v: unknown, errors: string[], where: string): string[] {
    const out: string[] = [];
    for (const r of strs(v)) { if (this.byId.has(r)) out.push(r); else errors.push(`${where}: unknown node id "${r}"`); }
    return [...new Set(out)];
  }
  evidence(v: unknown, errors: string[], where: string): Evidence[] {
    const out: Evidence[] = [];
    for (const e of Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []) {
      const ev = this.oneEvidence(e);
      if (ev) out.push(ev); else errors.push(`${where}: invalid evidence ${JSON.stringify(e)} (path must exist in the repo and line must be in range)`);
    }
    return out;
  }
  oneEvidence(e: unknown): Evidence | undefined {
    const o = obj(e);
    let path = str(o.path), line = Number(o.line);
    if (typeof e === 'string') { const m = /^(.+):(\d+)$/.exec(e); if (m) { path = m[1]!; line = Number(m[2]); } }
    path = path.replace(/^\.\//, '');
    if (!path || !Number.isInteger(line) || line < 1) return undefined;
    const n = this.lineCount(path);
    return n && line <= n ? { path, line } : undefined;
  }
  /** "nodeId" or "path:line" → evidence. */
  exampleRef(ref: string): Evidence | undefined {
    const n = this.byId.get(ref);
    if (n?.path) return { path: n.path, line: n.line ?? 1 };
    return this.oneEvidence(ref);
  }
}

class Tally {
  s = Object.fromEntries(SECTIONS.map((k) => [k, { claims: 0, grounded: 0 }])) as Record<Section, { claims: number; grounded: number }>;
  inferred = 0;
  add(section: Section, grounded: boolean) { this.s[section].claims++; if (grounded) this.s[section].grounded++; else this.inferred++; }
  result() {
    const pct = (g: number, c: number) => (c ? Math.round((1000 * g) / c) / 10 : 100);
    const out = {} as Record<Section, Grounding> & { total: Grounding };
    let c = 0, g = 0;
    for (const k of SECTIONS) { const x = this.s[k]; out[k] = { ...x, pct: pct(x.grounded, x.claims) }; c += x.claims; g += x.grounded; }
    out.total = { claims: c, grounded: g, pct: pct(g, c) };
    return out;
  }
}

function claim(rc: RefChecker, raw: unknown, errors: string[], where: string, textKey = 'text'): Claim {
  const o = obj(raw);
  const refs = rc.refs(o.refs, errors, where);
  const evidence = rc.evidence(o.evidence, errors, where);
  return { text: typeof raw === 'string' ? raw.trim() : str(o[textKey]), refs, evidence, ...(refs.length || evidence.length ? {} : { inferred: true }) };
}

// ---- per-agent validators -------------------------------------------------------------------

interface Ctx { rc: RefChecker; analysis: Analysis; input: Record<string, unknown>; tally: Tally }

export function validateModule(raw: unknown, ctx: Ctx): { out: { module: ModuleSummary; files: Explanations['files']; symbols: Explanations['symbols'] }; errors: string[] } {
  const { rc, input, tally } = ctx;
  const errors: string[] = [];
  const o = obj(raw);
  const unit = obj(input.unit);
  const unitFiles = arr(input.files);
  const fileIds = new Set(unitFiles.map((f) => str(f.nodeId)));
  const inUnit = (id: string) => { let n = rc.node(id); while (n && n.kind !== 'module') n = n.parent ? rc.node(n.parent) : undefined; return !!n && fileIds.has(n.id); };
  const files: Explanations['files'] = {};
  for (const f of arr(o.files)) {
    const id = str(f.nodeId);
    if (!fileIds.has(id)) { errors.push(`files: "${id}" is not a file of this unit`); continue; }
    if (!str(f.oneLine)) { errors.push(`files: "${id}" has an empty oneLine`); continue; }
    files[id] = { oneLine: str(f.oneLine), responsibilities: strs(f.responsibilities) };
    tally.add('files', true);
  }
  const missing = [...fileIds].filter((id) => !files[id]);
  if (missing.length) errors.push(`files: missing summaries for ${missing.length} file(s): ${missing.slice(0, 8).join(', ')}`);
  const symbols: Explanations['symbols'] = {};
  for (const s of arr(o.symbols)) {
    const id = str(s.nodeId);
    if (!rc.node(id) || !inUnit(id)) { errors.push(`symbols: "${id}" is not a symbol in this unit`); continue; }
    if (str(s.oneLine)) { symbols[id] = str(s.oneLine); tally.add('symbols', true); }
  }
  const m = obj(o.module);
  if (str(m.nodeId) && str(m.nodeId) !== str(unit.nodeId)) errors.push(`module.nodeId must be "${str(unit.nodeId)}"`);
  const keyFiles = rc.refs(m.keyFiles, errors, 'module.keyFiles').filter((id) => fileIds.has(id));
  const publicApi = rc.refs(m.publicApi, errors, 'module.publicApi');
  const gotchas = arr(m.gotchas).map((g, i) => claim(rc, g, errors, `module.gotchas[${i}]`)).filter((g) => g.text);
  for (const g of gotchas) tally.add('modules', !g.inferred);
  if (!str(m.purpose)) errors.push('module.purpose is empty');
  tally.add('modules', keyFiles.length > 0);
  return {
    out: {
      module: {
        nodeId: str(unit.nodeId), purpose: str(m.purpose), ...(keyFiles.length ? {} : { purposeInferred: true }), responsibilities: strs(m.responsibilities),
        keyFiles, publicApi, gotchas, openQuestions: strs(m.openQuestions), files: [...fileIds].sort(),
      },
      files, symbols,
    },
    errors,
  };
}

export function validateArchitecture(raw: unknown, ctx: Ctx): { out: ArchitectureOut; errors: string[] } {
  const { rc, analysis, tally } = ctx;
  const errors: string[] = [];
  const o = obj(raw);
  const overview = claim(rc, o.overview, errors, 'overview');
  if (!overview.text) errors.push('overview is empty');
  if (words(overview.text) > 150) errors.push(`overview has ${words(overview.text)} words (max 150)`);
  tally.add('overview', !overview.inferred);
  const narrative = arr(o.architectureNarrative ?? o.narrative).map((p, i) => claim(rc, p, errors, `architectureNarrative[${i}]`)).filter((p) => p.text);
  const total = narrative.reduce((s, p) => s + words(p.text), 0);
  // ponytail: the 300-word floor scales down for tiny repos so the model isn't asked to pad; the 600 ceiling is the spec's.
  const min = Math.min(300, 100 + 15 * analysis.counts.modules!);
  if (total < min || total > 600) errors.push(`architectureNarrative has ${total} words (want ${min}–600)`);
  narrative.forEach((p, i) => { tally.add('architecture', !p.inferred); if (p.inferred) errors.push(`architectureNarrative[${i}] cites no nodes`); });
  const layers = arr(o.layers).map((l, i) => ({ name: str(l.name), nodeIds: rc.refs(l.nodeIds, errors, `layers[${i}]`) })).filter((l) => l.name && l.nodeIds.length);
  const projectInteractions = arr(o.projectInteractions).map((p, i) => ({ ...claim(rc, p, errors, `projectInteractions[${i}]`, 'description'), from: str(p.from), to: str(p.to) })).filter((p) => p.text);
  for (const p of projectInteractions) tally.add('architecture', !p.inferred);
  const order = new Set(analysis.readingOrder.map((r) => r.id));
  const readingOrderReasons: Record<string, string> = {};
  for (const r of arr(o.readingOrderReasons)) {
    const id = str(r.nodeId);
    if (!order.has(id)) { errors.push(`readingOrderReasons: "${id}" is not in the analyzer's reading order (the order can't change)`); continue; }
    if (str(r.reason)) readingOrderReasons[id] = str(r.reason);
  }
  return { out: { overview, narrative, layers, projectInteractions, readingOrderReasons, openQuestions: strs(o.openQuestions) }, errors };
}

export function validateFlow(raw: unknown, ctx: Ctx): { out: FlowOut; errors: string[] } {
  const { rc, input, tally } = ctx;
  const errors: string[] = [];
  const o = obj(raw);
  const meta = obj(input.flow);
  const entry = str(o.entry) || str(input.entry);
  if (!rc.node(entry)) errors.push(`entry "${entry}" is not a node id`);
  if (!meta.requested && entry !== str(input.entry)) errors.push(`entry must be "${str(input.entry)}"`);
  const story = str(o.story);
  if (!story) errors.push('story is empty');
  if (words(story) > 200) errors.push(`story has ${words(story)} words (max 200)`);
  const steps: FlowStep[] = [];
  const raws = arr(o.steps).sort((a, b) => Number(a.order) - Number(b.order));
  for (const [i, s] of raws.entries()) {
    const id = str(s.nodeId);
    if (!rc.node(id)) { errors.push(`steps[${i}]: unknown node id "${id}"`); continue; }
    const evidence = rc.evidence(s.evidence, errors, `steps[${i}]`);
    let why: string | undefined;
    if (steps.length) {
      // A step is backed by a graph edge from any earlier step (fan-out: middleware, then handler), or by its own evidence.
      const hit = steps.map((p) => rc.pairs.get(`${p.nodeId}>${id}`)).find((x) => x !== undefined);
      if (hit && !evidence.length) evidence.push(hit);
      if (hit === undefined && !evidence.length) why = 'no graph edge from an earlier step and no file:line evidence';
    } else if (id !== entry) errors.push(`steps[0] must be the entry node "${entry}"`);
    else if (!evidence.length) { const n = rc.node(id)!; if (n.path) evidence.push({ path: n.path, line: n.line ?? 1 }); }
    const step: FlowStep = { order: steps.length + 1, nodeId: id, summary: str(s.summary), evidence, ...(str(s.via) ? { via: str(s.via) } : {}),
      ...(str(s.dataIn) ? { dataIn: str(s.dataIn) } : {}), ...(str(s.dataOut) ? { dataOut: str(s.dataOut) } : {}), ...(why ? { inferred: true, inferredWhy: why } : s.inferred === true ? { inferred: true, inferredWhy: 'marked inferred by the tracer' } : {}) };
    if (!step.summary) errors.push(`steps[${i}] has an empty summary`);
    steps.push(step);
    tally.add('flows', !step.inferred);
  }
  if (!steps.length) errors.push('flow has no valid steps');
  const participants = rc.refs(o.participants, errors, 'participants');
  const externalBoundaries = arr(o.externalBoundaries).map((b, i) => ({ ...claim(rc, b, errors, `externalBoundaries[${i}]`, 'name'), kind: str(b.kind) || 'external', name: str(b.name) })).filter((b) => b.name);
  for (const b of externalBoundaries) tally.add('flows', !b.inferred);
  return {
    out: { id: str(meta.id) || str(o.id), title: str(o.title) || str(meta.title), story, entry, ...(str(meta.category) ? { category: str(meta.category) } : {}), steps, participants, externalBoundaries, openQuestions: strs(o.openQuestions) },
    errors,
  };
}

export function validateGuide(raw: unknown, ctx: Ctx): { out: GuideOut; errors: string[] } {
  const { rc, analysis, tally } = ctx;
  const errors: string[] = [];
  const o = obj(raw);
  const facts = analysis.facts.run;
  const runLocally: GuideOut['runLocally'] = [];
  for (const [i, r] of arr(o.runLocally).entries()) {
    const src = obj(r.source);
    const fact = facts.find((f) => f.source.path === str(src.path) && f.source.line === Number(src.line) && f.command === str(r.command));
    if (!fact) { errors.push(`runLocally[${i}]: "${str(r.command)}" @ ${str(src.path)}:${String(src.line)} doesn't match an analyzer run fact (commands must be copied exactly from runFacts)`); continue; }
    runLocally.push({ step: str(r.step) || fact.label, command: fact.command, source: fact.source });
    tally.add('runLocally', true);
  }
  const conventions: GuideOut['conventions'] = [];
  for (const [i, c] of arr(o.conventions).entries()) {
    const examples = rc.evidence(c.examples, errors, `conventions[${i}]`);
    const name = str(c.name);
    if (!name) continue;
    // Spec: < 3 places → "observed once/rarely", never "convention". No examples → inferred.
    conventions.push({ name, description: str(c.description), examples, ...(c.source === 'config' ? { source: 'config' as const } : {}), confidence: examples.length >= 3 && c.confidence !== 'observed-rarely' ? 'convention' : 'observed-rarely', ...(examples.length ? {} : { inferred: true }) });
    if (examples.length < 2 && c.source !== 'config') errors.push(`conventions[${i}] "${name}" needs ≥ 2 example locations (or "source": "config" for a customConventions item)`);
    tally.add('conventions', examples.length > 0);
  }
  const allowed = new Map(recipeCandidates(rc.graph, analysis, rc.byId).map((r) => [r.task.toLowerCase(), r.task]));
  const recipes: GuideOut['recipes'] = [];
  for (const [i, r] of arr(o.recipes).entries()) {
    const task = allowed.get(str(r.task).toLowerCase());
    if (!task) { errors.push(`recipes[${i}]: "${str(r.task)}" isn't a recipe candidate (each recipe needs ≥ 2 real examples; use a task name from recipeCandidates)`); continue; }
    const steps: GuideOut['recipes'][number]['steps'] = [];
    for (const [j, s] of arr(r.steps).entries()) {
      const ref = str(s.exampleRef);
      const ev = rc.exampleRef(ref);
      if (!ev) { errors.push(`recipes[${i}].steps[${j}]: exampleRef "${ref}" is not a node id or a valid path:line`); continue; }
      steps.push({ text: str(s.text), exampleRef: ref, evidence: ev });
      tally.add('recipes', true);
    }
    if (steps.length) recipes.push({ task, steps });
  }
  const glossary = arr(o.glossary).map((g, i) => ({ ...claim(rc, g, errors, `glossary[${i}]`, 'definition'), term: str(g.term), definition: str(g.definition) })).filter((g) => g.term && g.definition);
  for (const g of glossary) tally.add('glossary', !g.inferred);
  if (!facts.length && !strs(o.openQuestions).length) errors.push('runFacts is empty: add an open question about how to run the project');
  return { out: { runLocally, conventions, recipes, glossary, openQuestions: strs(o.openQuestions) }, errors };
}

// ---- driver -------------------------------------------------------------------------------

interface State { [taskId: string]: { key: string; attempts: number; status: TaskStatus } }

export interface ValidateOptions { final?: boolean; stage?: 1 | 2 }

/**
 * Validate every task output in the plan. Valid (or, after the retry budget, partially valid) outputs are cleaned,
 * cached by key and merged into validated.json. Returns per-task status so the orchestrator knows what to re-run.
 */
export function validateExplain(root: string, graph: RepoGraph, analysis: Analysis, opts: ValidateOptions = {}): Explanations {
  const plan = readJsonFile<ExplainPlan>(join(root, EXPLAIN_DIR, 'plan.json'));
  if (!plan) throw new Error('no explain plan: run prepare first');
  const statePath = join(root, EXPLAIN_DIR, 'state.json');
  const state = readJsonFile<State>(statePath) ?? {};
  const rc = new RefChecker(root, graph);
  const tally = new Tally();
  const ex: Explanations = {
    version: 1, depth: plan.depth, modules: {}, files: {}, symbols: {}, flows: [], grounding: tally.result(),
    flowSteps: { total: 0, backed: 0, pct: 100 }, inferredClaims: 0, readsUsed: 0, tasks: [],
  };
  for (const t of plan.tasks) {
    const prev = state[t.id];
    const st = prev && prev.key === t.key ? prev : { key: t.key, attempts: 0, status: 'missing' as TaskStatus };
    const inStage = !opts.stage || t.stage === opts.stage;
    const outPath = join(root, t.output);
    let raw: unknown;
    let parseError: string | undefined;
    if (existsSync(outPath)) {
      try { raw = JSON.parse(readFileSync(outPath, 'utf8').replace(/^﻿/, '').replace(/^```(?:json)?\s*|\s*```\s*$/g, '')); } catch (e) { parseError = `output is not valid JSON: ${(e as Error).message}`; }
    }
    if (raw === undefined) {
      if (inStage && st.status !== 'ok' && st.status !== 'partial') { st.attempts += existsSync(outPath) ? 1 : 0; st.status = opts.final || st.attempts >= 3 ? 'missing' : 'retry'; }
      ex.tasks.push({ id: t.id, agent: t.agent, title: t.title, status: st.status === 'ok' ? 'missing' : st.status, attempts: st.attempts, errors: [parseError ?? 'no output written'], cached: false });
      state[t.id] = st;
      if (st.status === 'retry') writeFileEnsured(join(root, EXPLAIN_DIR, 'errors', `${t.id}.txt`), `${parseError ?? 'No output file was written.'}\nWrite valid JSON to ${outPath}.\n`);
      continue;
    }
    const input = readJsonFile<Record<string, unknown>>(join(root, t.input)) ?? {};
    const local = new Tally();
    const ctx: Ctx = { rc, analysis, input, tally: local };
    const r = runValidator(t, raw, ctx);
    const cachedOk = t.cached && st.status !== 'retry';
    if (!cachedOk && inStage && st.status !== 'ok' && st.status !== 'partial') st.attempts++;
    const status: TaskStatus = !r.errors.length ? 'ok' : cachedOk || opts.final || st.attempts >= 3 || !inStage ? 'partial' : 'retry';
    st.status = status;
    state[t.id] = st;
    ex.tasks.push({ id: t.id, agent: t.agent, title: t.title, status, attempts: st.attempts, errors: r.errors, cached: t.cached });
    if (status === 'retry') {
      writeFileEnsured(join(root, EXPLAIN_DIR, 'errors', `${t.id}.txt`), `Validation failed (attempt ${st.attempts} of 3). Fix these and rewrite ${outPath}:\n- ${r.errors.join('\n- ')}\n`);
      continue;
    }
    // Merge, tally and cache the cleaned output (it re-validates cleanly next time).
    for (const k of SECTIONS) { tally.s[k].claims += local.s[k].claims; tally.s[k].grounded += local.s[k].grounded; }
    tally.inferred += local.inferred;
    ex.readsUsed += Number(obj(raw).readsUsed) || 0;
    merge(ex, t, r.out);
    if (!t.cached || status === 'ok') writeFileEnsured(join(root, EXPLAIN_CACHE, `${t.key}.json`), canonicalJson(cleanForCache(t, raw, r.out), 1));
  }
  ex.grounding = tally.result();
  ex.inferredClaims = tally.inferred;
  const steps = ex.flows.flatMap((f) => f.steps);
  const backed = steps.filter((s) => !s.inferred && s.evidence.length).length;
  ex.flowSteps = { total: steps.length, backed, pct: steps.length ? Math.round((1000 * backed) / steps.length) / 10 : 100 };
  writeFileEnsured(statePath, canonicalJson(state, 1));
  writeFileEnsured(join(root, EXPLAIN_DIR, 'validated.json'), canonicalJson(ex, 1));
  return ex;
}

function runValidator(t: ExplainTask, raw: unknown, ctx: Ctx): { out: unknown; errors: string[] } {
  switch (t.agent) {
    case 'module-summarizer': return validateModule(raw, ctx);
    case 'architecture-writer': return validateArchitecture(raw, ctx);
    case 'flow-tracer': return validateFlow(raw, ctx);
    case 'guide-writer': return validateGuide(raw, ctx);
  }
}

function merge(ex: Explanations, t: ExplainTask, out: unknown) {
  if (t.agent === 'module-summarizer') {
    const o = out as ReturnType<typeof validateModule>['out'];
    const prev = ex.modules[o.module.nodeId];
    // Split units (part 1, 2, …) of one folder merge into one module entry.
    ex.modules[o.module.nodeId] = prev ? { ...prev, files: [...prev.files, ...o.module.files].sort(), keyFiles: [...prev.keyFiles, ...o.module.keyFiles], publicApi: [...prev.publicApi, ...o.module.publicApi], gotchas: [...prev.gotchas, ...o.module.gotchas], responsibilities: [...prev.responsibilities, ...o.module.responsibilities], openQuestions: [...prev.openQuestions, ...o.module.openQuestions] } : o.module;
    Object.assign(ex.files, o.files);
    Object.assign(ex.symbols, o.symbols);
  } else if (t.agent === 'architecture-writer') ex.architecture = out as ArchitectureOut;
  else if (t.agent === 'flow-tracer') ex.flows.push(out as FlowOut);
  else ex.guide = out as GuideOut;
}

/** Cache the agent's raw shape with invalid parts removed, so a cache hit re-validates to the same result. */
function cleanForCache(t: ExplainTask, raw: unknown, out: unknown): unknown {
  const o = obj(raw);
  const readsUsed = Number(o.readsUsed) || 0;
  if (t.agent === 'module-summarizer') {
    const m = out as ReturnType<typeof validateModule>['out'];
    return {
      readsUsed,
      files: Object.entries(m.files).map(([nodeId, f]) => ({ nodeId, ...f })),
      symbols: Object.entries(m.symbols).map(([nodeId, oneLine]) => ({ nodeId, oneLine })),
      module: { nodeId: m.module.nodeId, purpose: m.module.purpose, responsibilities: m.module.responsibilities, keyFiles: m.module.keyFiles, publicApi: m.module.publicApi, gotchas: m.module.gotchas.map((g) => ({ text: g.text, refs: g.refs, evidence: g.evidence })), openQuestions: m.module.openQuestions },
    };
  }
  if (t.agent === 'architecture-writer') {
    const a = out as ArchitectureOut;
    const c = (x: Claim) => ({ text: x.text, refs: x.refs, evidence: x.evidence });
    return { readsUsed, overview: c(a.overview), architectureNarrative: a.narrative.map(c), layers: a.layers, projectInteractions: a.projectInteractions.map((p) => ({ from: p.from, to: p.to, description: p.text, refs: p.refs, evidence: p.evidence })), readingOrderReasons: Object.entries(a.readingOrderReasons).map(([nodeId, reason]) => ({ nodeId, reason })), openQuestions: a.openQuestions };
  }
  if (t.agent === 'flow-tracer') {
    const f = out as FlowOut;
    return { readsUsed, id: f.id, title: f.title, story: f.story, entry: f.entry, steps: f.steps.map((s) => ({ order: s.order, nodeId: s.nodeId, ...(s.via ? { via: s.via } : {}), summary: s.summary, ...(s.dataIn ? { dataIn: s.dataIn } : {}), ...(s.dataOut ? { dataOut: s.dataOut } : {}), evidence: s.evidence, ...(s.inferredWhy === 'marked inferred by the tracer' ? { inferred: true } : {}) })), participants: f.participants, externalBoundaries: f.externalBoundaries.map((b) => ({ kind: b.kind, name: b.name, refs: b.refs, evidence: b.evidence })), openQuestions: f.openQuestions };
  }
  const g = out as GuideOut;
  return { readsUsed, runLocally: g.runLocally, conventions: g.conventions.map((c) => ({ name: c.name, description: c.description, examples: c.examples, confidence: c.confidence, ...(c.source ? { source: c.source } : {}) })), recipes: g.recipes.map((r) => ({ task: r.task, steps: r.steps.map((s) => ({ text: s.text, exampleRef: s.exampleRef })) })), glossary: g.glossary.map((x) => ({ term: x.term, definition: x.definition, refs: x.refs, evidence: x.evidence })), openQuestions: g.openQuestions };
}

