import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPLAIN_CACHE, loadConfig, prepareExplain, readJsonFile, validateExplain, type ExplainPlan, type ExplainTask } from '@codebase-guide/core';
import { runAnalyze } from '../src/analyze.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (src) => !src.includes('.codebase-guide') });
  return dir;
};
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A deterministic stand-in for each agent: valid, grounded output built only from its input. */
function fakeAgent(t: ExplainTask, input: J): J {
  if (t.agent === 'module-summarizer') {
    return {
      readsUsed: 1,
      files: input.files.map((f: J) => ({ nodeId: f.nodeId, oneLine: `Summary of ${f.path}.`, responsibilities: ['one thing'] })),
      symbols: input.files.flatMap((f: J) => f.symbols.map((s: J) => ({ nodeId: s.nodeId, oneLine: `Does ${s.label}.` }))),
      module: { nodeId: input.unit.nodeId, purpose: 'Holds the code.', keyFiles: [input.files[0].nodeId], publicApi: [], gotchas: [{ text: 'No tests.', refs: [input.files[0].nodeId] }], openQuestions: [] },
    };
  }
  if (t.agent === 'architecture-writer') {
    const ids = input.readingOrder.map((r: J) => r.id);
    const para = (n: number) => ({ text: Array.from({ length: 70 }, (_, i) => `word${n}${i}`).join(' '), refs: [ids[0]] });
    return { overview: { text: 'A small service.', refs: [ids[0]] }, architectureNarrative: [para(1), para(2), para(3), para(4), para(5)], layers: [], projectInteractions: [], readingOrderReasons: ids.map((nodeId: string) => ({ nodeId, reason: 'Read it.' })), openQuestions: [] };
  }
  if (t.agent === 'flow-tracer') {
    const steps = [{ order: 1, nodeId: input.entry, summary: 'Entry.' }];
    for (const e of input.edges as J[]) if (steps.some((s) => s.nodeId === e.source) && !steps.some((s) => s.nodeId === e.target)) steps.push({ order: steps.length + 1, nodeId: e.target, summary: `Then ${e.kind}.` });
    return { id: input.flow.id, title: input.flow.title, story: 'It flows.', entry: input.entry, steps, participants: [], externalBoundaries: [], openQuestions: [] };
  }
  return {
    runLocally: input.runFacts.slice(0, 3).map((f: J) => ({ step: f.label, command: f.command, source: f.source })),
    conventions: input.patternHints.filter((h: J) => h.examples.length >= 2).slice(0, 2).map((h: J) => ({ name: h.pattern, description: 'Seen here.', examples: h.examples, confidence: 'convention' })),
    recipes: input.recipeCandidates.map((r: J) => ({ task: r.task, steps: [{ text: 'Copy this.', exampleRef: r.examples[0].nodeId }] })),
    glossary: [{ term: 'User', definition: 'A user.', refs: [] }],
    openQuestions: input.runFacts.length ? [] : ['How do you run it?'],
  };
}

async function setup(name: string, depth: 'quick' | 'standard' | 'deep' = 'standard') {
  const dir = copy(name);
  const { graph, analysis } = await runAnalyze(dir);
  const plan = () => prepareExplain(dir, graph, analysis, { depth, config: loadConfig(dir).config, useCache: true });
  return { dir, graph, analysis, plan };
}
const runAll = (dir: string, plan: ExplainPlan, tweak?: (t: ExplainTask, out: J) => J) => {
  for (const t of plan.tasks.filter((x) => !x.cached)) {
    const out = fakeAgent(t, readJsonFile<J>(join(dir, t.input))!);
    writeFileSync(join(dir, t.output), JSON.stringify(tweak ? tweak(t, out) : out));
  }
};

test('prepare: tasks, inputs, budget; nothing cached on a fresh repo', async () => {
  const { dir, plan } = await setup('07-fastapi-sqla');
  const p = plan();
  assert.deepEqual(p.tasks.map((t) => t.agent).filter((a, i, xs) => xs.indexOf(a) === i), ['module-summarizer', 'architecture-writer', 'flow-tracer', 'guide-writer']);
  assert.equal(p.tasks.filter((t) => t.agent === 'flow-tracer').length, 7);
  assert.ok(p.budget.estTokens > 0 && p.budget.estFileReads > 0 && p.budget.cached === 0);
  assert.equal(p.budget.needsConfirm, false);
  for (const t of p.tasks) assert.ok(existsSync(join(dir, t.input)), t.input);
  const guide = readJsonFile<J>(join(dir, p.tasks.find((t) => t.id === 'guide')!.input))!;
  assert.ok(!JSON.stringify(guide).includes('do-not-read-me'), 'no secret values in agent inputs');
});

test('validate: complete fake run is fully grounded and cached', async () => {
  const { dir, graph, analysis, plan } = await setup('07-fastapi-sqla');
  const p = plan();
  runAll(dir, p);
  const ex = validateExplain(dir, graph, analysis, {});
  assert.deepEqual(ex.tasks.filter((t) => t.status !== 'ok').map((t) => `${t.id}: ${t.errors.join('; ')}`), []);
  assert.equal(ex.grounding.total.pct >= 85, true, `grounding ${ex.grounding.total.pct}`);
  assert.ok(ex.flowSteps.pct >= 80, `flow steps ${ex.flowSteps.pct}`);
  for (const t of p.tasks) assert.ok(existsSync(join(dir, EXPLAIN_CACHE, `${t.key}.json`)), `cached ${t.id}`);
});

test('validate: invented run commands, unknown refs and unbacked recipes are rejected; retries then partial', async () => {
  const { dir, graph, analysis, plan } = await setup('07-fastapi-sqla');
  const p = plan();
  runAll(dir, p, (t, out) => {
    if (t.agent === 'guide-writer') {
      out.runLocally.push({ step: 'Start', command: 'npm start', source: { path: 'pyproject.toml', line: 8 } });
      out.recipes.push({ task: 'add a GraphQL resolver', steps: [{ text: 'x', exampleRef: 'app/main.py:1' }] });
      out.conventions[0].examples = out.conventions[0].examples.slice(0, 2);
    }
    if (t.agent === 'module-summarizer') out.module.gotchas.push({ text: 'Bad ref.', refs: ['py:function:nope.py#ghost'] });
    return out;
  });
  const first = validateExplain(dir, graph, analysis, {});
  const guide = first.tasks.find((t) => t.id === 'guide')!;
  assert.equal(guide.status, 'retry');
  assert.ok(guide.errors.some((e) => e.includes('"npm start"') && e.includes("doesn't match an analyzer run fact")));
  assert.ok(guide.errors.some((e) => e.includes('add a GraphQL resolver')));
  assert.ok(first.tasks.find((t) => t.agent === 'module-summarizer')!.errors.some((e) => e.includes('unknown node id "py:function:nope.py#ghost"')));
  assert.ok(existsSync(join(dir, '.codebase-guide/explain/errors/guide.txt')));
  validateExplain(dir, graph, analysis, {});
  const third = validateExplain(dir, graph, analysis, {});
  const g3 = third.tasks.find((t) => t.id === 'guide')!;
  assert.equal(g3.status, 'partial', 'after 2 retries the valid parts are kept');
  assert.ok(third.guide!.runLocally.every((r) => analysis.facts.run.some((f) => f.command === r.command && f.source.path === r.source.path && f.source.line === r.source.line)), 'zero invented run commands');
  assert.ok(!third.guide!.recipes.some((r) => r.task === 'add a GraphQL resolver'));
  assert.equal(third.guide!.conventions[0]!.confidence, 'observed-rarely', '< 3 examples is never a "convention"');
  assert.deepEqual(third.modules[Object.keys(third.modules)[0]!]!.gotchas.map((g) => g.text), ['No tests.', 'Bad ref.']);
  assert.equal(third.modules[Object.keys(third.modules)[0]!]!.gotchas[1]!.inferred, true, 'claim with no valid ref is forced inferred');
});

test('validate: flow steps without an edge or evidence are forced inferred; edge evidence is attached', async () => {
  const { dir, graph, analysis, plan } = await setup('07-fastapi-sqla');
  const p = plan();
  const flow = p.tasks.find((t) => t.title === 'GET /api/users/me')!;
  runAll(dir, p, (t, out) => {
    if (t.id === flow.id) out.steps.push({ order: 99, nodeId: 'py:function:app/main.py#run', summary: 'Unrelated hop.' });
    return out;
  });
  const ex = validateExplain(dir, graph, analysis, {});
  const f = ex.flows.find((x) => x.title === 'GET /api/users/me')!;
  const last = f.steps[f.steps.length - 1]!;
  assert.equal(last.nodeId, 'py:function:app/main.py#run');
  assert.equal(last.inferred, true);
  assert.ok(f.steps.slice(1, -1).every((s) => !s.inferred && s.evidence.length), 'edge-backed steps carry the edge evidence');
});

test('recipes appear only where ≥ 2 examples exist', async () => {
  const { dir, graph, analysis, plan } = await setup('08-flask');
  runAll(dir, plan());
  const ex = validateExplain(dir, graph, analysis, {});
  const input = readJsonFile<J>(join(dir, '.codebase-guide/explain/inputs/guide.json'))!;
  for (const r of input.recipeCandidates) assert.ok(r.examples.length >= 2, r.task);
  assert.deepEqual(ex.guide!.recipes.map((r) => r.task).sort(), input.recipeCandidates.map((r: J) => r.task).sort());
  assert.ok(!ex.guide!.recipes.some((r) => r.task === 'add a test'), 'fixture 08 has no tests, so no test recipe');
});

test('incremental: one changed file regenerates only its unit and the ancestors that depend on it', async () => {
  const { dir, plan } = await setup('06-django-drf', 'deep');
  const p1 = plan();
  assert.ok(p1.tasks.filter((t) => t.agent === 'module-summarizer').length >= 2, 'fixture splits into several units');
  runAll(dir, p1);
  const { graph: g1, analysis: a1 } = await runAnalyze(dir);
  validateExplain(dir, g1, a1, {});
  const p2 = prepareExplain(dir, g1, a1, { depth: 'deep', config: {}, useCache: true });
  assert.equal(p2.budget.toRun, 0, 'second run: every task is a cache hit');

  writeFileSync(join(dir, 'accounts/views.py'), readFileSync(join(dir, 'accounts/views.py'), 'utf8') + '\n# touched\n');
  const { graph, analysis } = await runAnalyze(dir);
  const p3 = prepareExplain(dir, graph, analysis, { depth: 'deep', config: {}, useCache: true });
  const rerun = p3.tasks.filter((t) => !t.cached);
  const rerunUnits = rerun.filter((t) => t.agent === 'module-summarizer');
  assert.equal(rerunUnits.length, 1, 'only the unit holding the changed file');
  assert.ok(readJsonFile<J>(join(dir, rerunUnits[0]!.input))!.files.some((f: J) => f.path === 'accounts/views.py'));
  assert.ok(rerun.some((t) => t.id === 'arch') && rerun.some((t) => t.id === 'guide'), 'ancestors (architecture, guide) regenerate');
  const flowsRerun = rerun.filter((t) => t.agent === 'flow-tracer').map((t) => t.title);
  assert.ok(flowsRerun.every((t) => /accounts|login|profile/.test(t)), `only flows through accounts/views.py: ${flowsRerun.join(', ')}`);
  assert.ok(p3.tasks.some((t) => t.agent === 'flow-tracer' && t.cached), 'untouched flows stay cached');
  assert.ok(p3.tasks.filter((t) => t.agent === 'module-summarizer' && t.cached).length >= 1);
});
