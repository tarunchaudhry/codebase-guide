import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  EST_CALIBRATION, EXPLAIN_DIR, OUTPUT_DIR, VERSION, gitHead, loadConfig, prepareExplain, readJsonFile, validateExplain,
  type Analysis, type Depth, type ExplainPlan, type RepoGraph,
} from '@codebase-guide/core';
import { runAnalyze } from './analyze.ts';
import { renderReport } from './render.ts';
import { fileURLToPath } from 'node:url';

const USAGE = `codebase-guide <command> [path] [options]
  prepare  [path] [--depth quick|standard|deep] [--update] [--no-cache]   extract → link → analyze → explain plan + budget
  validate [path] [--stage 1|2] [--final]                                  check agent outputs, cache the valid ones
  render   [path] [--split] [--no-snippets] [--open] [--deterministic]     write .codebase-guide/report/
  map      [path] [--open] [--split]                                       deterministic report only (no LLM)
  flow     [path] --describe "<text>" [--entry <file|METHOD path>]         plan one requested flow (for /repo-flow)
  extract  [path] [--no-cache]                                             graph.json only
  analyze  [path]                                                          graph.json + analysis.json
`;

const OPTIONS = {
  depth: { type: 'string' }, update: { type: 'boolean' }, 'no-cache': { type: 'boolean' }, stage: { type: 'string' }, final: { type: 'boolean' },
  split: { type: 'boolean' }, 'no-snippets': { type: 'boolean' }, open: { type: 'boolean' }, deterministic: { type: 'boolean' },
  describe: { type: 'string' }, entry: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const;

/** Every command prints plain text for the calling skill to relay, and never exits non-zero (a failing `!` command aborts the skill). */
export async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...rest] = argv;
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS, strict: true });
    // `/repo-flow "<description>"`: the description may arrive as the first positional.
    if (cmd === 'flow' && !values.describe) {
      const i = positionals.findIndex((p) => !existsSync(p));
      if (i >= 0) values.describe = positionals.splice(i, 1)[0]!;
    }
    const target = positionals[0] ?? '.';
    if (values.help || cmd === 'help') { console.log(USAGE); return; }
    const root = realpathSync(resolve(target));
    const { config, warnings: cfgWarnings } = loadConfig(root);
    const depth = parseDepth(values.depth ?? config.depth);
    const useCache = !values['no-cache'];
    switch (cmd) {
      case 'extract': case 'analyze': {
        const r = await runAnalyze(root, { depth, useCache });
        printHeader(root, r.graph, r.analysis, r.extractMs, r.analyzeMs);
        console.log(`wrote ${join(OUTPUT_DIR, 'graph.json')} and ${join(OUTPUT_DIR, 'analysis.json')}`);
        return;
      }
      case 'prepare': case 'flow': {
        const r = await runAnalyze(root, { depth, useCache });
        printHeader(root, r.graph, r.analysis, r.extractMs, r.analyzeMs);
        for (const w of cfgWarnings) console.log(`config: ${w}`);
        const plan = prepareExplain(root, r.graph, r.analysis, {
          depth, config, useCache,
          ...(cmd === 'flow' ? { requestedFlow: { description: values.describe ?? '', ...(values.entry ? { entry: values.entry } : {}) } } : {}),
        });
        if (cmd === 'flow') {
          if (!values.describe) { console.log('ERROR: /repo-flow needs a description, e.g. /repo-flow "how an order is saved"'); return; }
          const t = plan.tasks.filter((x) => x.id.startsWith('flow-req-') && x.title === values.describe);
          console.log(`ROOT: ${root}`);
          console.log(`VALIDATE: node ${SELF} validate ${JSON.stringify(root)} --stage 2 [--final]`);
          console.log(`RENDER: node ${SELF} render ${JSON.stringify(root)}`);
          printTasks(root, { ...plan, tasks: t, budget: { ...plan.budget, toRun: t.filter((x) => !x.cached).length, estTokens: t.reduce((s, x) => s + (x.cached ? 0 : x.estTokens), 0), estTokensWithCacheReads: Math.round(t.reduce((s, x) => s + (x.cached ? 0 : x.estTokens), 0) * EST_CALIBRATION.withCacheReads / EST_CALIBRATION.inOut), estFileReads: t.reduce((s, x) => s + (x.cached ? 0 : x.estReads), 0) } }, true);
          return;
        }
        printTasks(root, plan, false);
        const pass = (['split', 'no-snippets', 'open'] as const).filter((k) => values[k]).map((k) => ` --${k}`).join('');
        console.log(`ROOT: ${root}`);
        console.log(`VALIDATE: node ${SELF} validate ${JSON.stringify(root)} --stage <1|2> [--final]`);
        console.log(`RENDER: node ${SELF} render ${JSON.stringify(root)}${pass}`);
        console.log(`RENDER_DETERMINISTIC: node ${SELF} render ${JSON.stringify(root)} --deterministic${pass}`);
        return;
      }
      case 'validate': {
        const { graph, analysis } = loadArtifacts(root);
        const stage = values.stage === '1' ? 1 : values.stage === '2' ? 2 : undefined;
        const ex = validateExplain(root, graph, analysis, { ...(stage ? { stage } : {}), ...(values.final ? { final: true } : {}) });
        const shown = ex.tasks.filter((t) => !stage || readPlan(root)?.tasks.find((p) => p.id === t.id)?.stage === stage);
        const retry = shown.filter((t) => t.status === 'retry');
        console.log(`validate${stage ? ` stage ${stage}` : ''}: ${shown.filter((t) => t.status === 'ok').length} ok, ${shown.filter((t) => t.status === 'partial').length} partial, ${retry.length} retry, ${shown.filter((t) => t.status === 'missing').length} missing`);
        for (const t of shown.filter((x) => x.status !== 'ok')) {
          console.log(`  ${t.status.toUpperCase().padEnd(7)} ${t.id}  ${t.agent}  attempt ${t.attempts}/3  ${t.errors.length} issue(s): ${t.errors.slice(0, 2).join(' | ')}`);
          if (t.status === 'retry') console.log(`          re-dispatch with: input=${join(root, EXPLAIN_DIR, 'inputs', `${t.id}.json`)} errors=${join(root, EXPLAIN_DIR, 'errors', `${t.id}.txt`)}`);
        }
        console.log(`grounding: ${ex.grounding.total.pct}% of ${ex.grounding.total.claims} claims · flow steps evidence-backed: ${ex.flowSteps.pct}% of ${ex.flowSteps.total} · inferred claims: ${ex.inferredClaims}`);
        console.log(retry.length ? 'NEXT: re-dispatch the RETRY tasks above, then validate again.' : 'NEXT: done with this stage.');
        return;
      }
      case 'render': case 'map': {
        const deterministic = cmd === 'map' || !!values.deterministic;
        if (cmd === 'map') { const r = await runAnalyze(root, { depth, useCache }); printHeader(root, r.graph, r.analysis, r.extractMs, r.analyzeMs); }
        const res = renderReport(root, { deterministic, split: !!values.split, snippets: !values['no-snippets'] && config.snippets !== false, open: !!values.open, editorScheme: config.editorScheme ?? 'vscode', depth });
        for (const l of res.lines) console.log(l);
        return;
      }
      default:
        console.log(`ERROR: unknown command "${cmd}"\n${USAGE}`);
    }
  } catch (e) {
    console.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseDepth(d: string | undefined): Depth {
  if (d === undefined) return 'standard';
  if (d === 'quick' || d === 'standard' || d === 'deep') return d;
  throw new Error(`--depth must be quick, standard or deep (got "${d}")`);
}

/** The script path the skill invoked, so follow-up commands match the pre-approved `allowed-tools` pattern. */
const SELF = process.argv[1] && /scripts\/[\w-]+\.mjs$/.test(process.argv[1]) ? process.argv[1].replace(/[\w-]+\.mjs$/, 'codebase-guide.mjs') : join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'codebase-guide.mjs');

const readPlan = (root: string) => readJsonFile<ExplainPlan>(join(root, EXPLAIN_DIR, 'plan.json'));

function loadArtifacts(root: string): { graph: RepoGraph; analysis: Analysis } {
  const graph = readJsonFile<RepoGraph>(join(root, OUTPUT_DIR, 'graph.json'));
  const analysis = readJsonFile<Analysis>(join(root, OUTPUT_DIR, 'analysis.json'));
  if (!graph || !analysis) throw new Error(`no ${OUTPUT_DIR}/graph.json or analysis.json yet: run prepare (or /repo-map) first`);
  return { graph, analysis };
}

function printHeader(root: string, g: RepoGraph, a: Analysis, extractMs: number, analyzeMs: number) {
  const c = a.counts;
  console.log(`codebase-guide ${VERSION} · ${root}${g.commit ? ` @ ${g.commit.slice(0, 8)}` : ''}`);
  console.log(`extract+link ${extractMs} ms · analyze ${analyzeMs} ms · ${c.projects} project(s), ${c.files} files, ${c.endpoints} endpoints, ${c.pages} pages, ${c.models} models`);
  const frameworks = [...new Set(g.projects.flatMap((p) => p.frameworks))];
  if (!frameworks.length) console.log('frameworks: none recognized, so the report uses the generic language-level graph');
  else console.log(`frameworks: ${frameworks.join(', ')}`);
  const top = [...g.warnings].sort((x, y) => (y.count ?? 1) - (x.count ?? 1)).slice(0, 5);
  if (top.length) console.log(`warnings: ${top.map((w) => `${w.code}×${w.count ?? 1}`).join(', ')}`);
  if (g.warnings.some((w) => w.code === 'py-python-missing')) console.log('note: python3 ≥ 3.9 not found, so Python files were skipped and only the JS/TS side is in the report');
  if (g.warnings.some((w) => w.code.startsWith('django-settings'))) console.log('note: Django settings could not be resolved statically; set "djangoSettings" in .codebase-guide/config.json');
}

function printTasks(root: string, plan: ExplainPlan, single: boolean) {
  const b = plan.budget;
  console.log(`explain plan (${plan.depth}): ${b.tasks} task(s), ${b.cached} cached, ${b.toRun} to run`);
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
  console.log(`estimated cost: ~${k(b.estTokens)} input+output tokens (~${k(b.estTokensWithCacheReads)} including cache re-reads), ~${b.estFileReads} file reads; confirm threshold ${k(b.confirmAboveTokens)} input+output. Estimates are calibrated on fixture runs and can be off by 2x either way.`);
  console.log(`CONFIRM: ${b.needsConfirm ? 'yes (over threshold: ask the user before running agents)' : 'no'}`);
  const agentName = (a: string) => `codebase-guide:${a}`;
  for (const stage of [1, 2] as const) {
    const ts = plan.tasks.filter((t) => t.stage === stage);
    if (!ts.length) continue;
    const run = ts.filter((t) => !t.cached);
    console.log(`STAGE ${stage}: ${run.length} to run, ${ts.length - run.length} cached`);
    for (const t of run) console.log(`  RUN ${t.id}  agent=${agentName(t.agent)}  input=${join(root, t.input)}  (${t.title})`);
    for (const t of ts.filter((x) => x.cached)) console.log(`  CACHE-HIT ${t.id}  key=${t.key.slice(0, 12)}  (${t.title})`);
  }
  if (!b.toRun) console.log(single ? 'NEXT: nothing to run; render.' : 'NEXT: everything is cached; run validate, then render.');
}

export function readMeta(root: string): { commit?: string } | undefined {
  const p = join(root, OUTPUT_DIR, 'report', 'meta.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
}
export { gitHead };
