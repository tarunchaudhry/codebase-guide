import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, graphJsonSchema, listFiles, mergeGraphs } from '@codebase-guide/core';
import { runExtract } from '../../cli/src/extract.ts';
import { extractPy } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name); // stable basename: root project label falls back to it
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (s) => !s.includes('.codebase-guide') });
  return dir;
};

test('py-basic: snapshot + schema via the Node wrapper', async () => {
  const root = copy('py-basic');
  const r = await extractPy(root, listFiles(root), { useCache: false });
  const graph = mergeGraphs([r.graph], { repoRoot: '<root>' });
  const json = canonicalJson(graph, 1);
  const snap = join(import.meta.dirname, '__snapshots__', 'py-basic.graph.json');
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) writeFileSync(snap, json);
  assert.equal(json, readFileSync(snap, 'utf8'));
  const validate = new Ajv2020({ allErrors: true }).compile(graphJsonSchema);
  assert.ok(validate(graph), JSON.stringify(validate.errors, null, 1));
  assert.ok(!graph.warnings.some((w) => w.code === 'graph-dangling-edge'));
});

test('.env is never handed to the sidecar', async () => {
  const root = copy('py-basic');
  assert.ok(existsSync(join(root, '.env')));
  assert.ok(!listFiles(root).includes('.env'));
});

test('Python missing: TS side still extracts, with a warning', async () => {
  const root = copy('10-pnpm-workspace');
  writeFileSync(join(root, 'apps/api/worker.py'), 'def run():\n    return 1\n');
  const r = await runExtract(root, { python: '/nonexistent/python3', useCache: false });
  assert.ok(r.graph.nodes.some((n) => n.id === 'ts:function:packages/shared/src/format.ts#formatPrice'));
  assert.ok(!r.graph.nodes.some((n) => n.lang === 'py'));
  const w = r.graph.warnings.find((x) => x.code === 'py-python-missing');
  assert.ok(w, 'expected py-python-missing warning');
  assert.match(w.message, /1 Python files were not analyzed/);
});

test('polyglot merge: TS + Python in one graph, env vars shared by name', async () => {
  const root = copy('10-pnpm-workspace');
  writeFileSync(join(root, 'apps/api/worker.py'), 'import os\n\nPORT = os.getenv("PORT")\n');
  const r = await runExtract(root, { useCache: false });
  const port = r.graph.edges.filter((e) => e.target === 'config:env-var:PORT').map((e) => e.source).sort();
  assert.deepEqual(port, ['js:module:apps/api/src/server.js', 'py:module:apps/api/worker.py']);
  // no pyproject/requirements next to it, so the stray .py belongs to a root-level Python project
  assert.ok(r.graph.projects.some((p) => p.id === 'py:project:.'));
});
