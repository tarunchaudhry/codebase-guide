import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, graphJsonSchema, listFiles, mergeGraphs, type RepoGraph } from '@codebase-guide/core';
import { extractTs } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const SNAPSHOTS = join(import.meta.dirname, '__snapshots__');

function copyFixture(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name); // stable basename: root project label falls back to it
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (src) => !src.includes('.codebase-guide') });
  return dir;
}

async function extract(root: string, useCache = true) {
  const files = listFiles(root);
  const r = await extractTs(root, files, { useCache });
  const graph = mergeGraphs([r.graph], { repoRoot: '<root>' });
  return { graph, json: canonicalJson(graph, 1), run: r.run };
}

const short = (id: string) => id.replace(/^[a-z]+:[a-z-]+:/, '');
const edgeList = (g: RepoGraph, kind: string) => g.edges.filter((e) => e.kind === kind).map((e) => `${short(e.source)} -> ${short(e.target)}`);

test('fixture 10: snapshot + schema', async () => {
  const { graph, json } = await extract(copyFixture('10-pnpm-workspace'));
  const snap = join(SNAPSHOTS, '10-pnpm-workspace.graph.json');
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) writeFileSync(snap, json);
  assert.equal(json, readFileSync(snap, 'utf8'), 'graph.json snapshot changed; rerun with UPDATE_SNAPSHOTS=1 if intended');
  const validate = new Ajv2020({ allErrors: true }).compile(graphJsonSchema);
  assert.ok(validate(graph), JSON.stringify(validate.errors, null, 1));
});

test('fixture 10: key structure and edges', async () => {
  const { graph } = await extract(copyFixture('10-pnpm-workspace'));
  assert.deepEqual(graph.projects.map((p) => p.id), ['js:project:apps/api', 'ts:project:apps/web', 'ts:project:packages/shared']);
  const calls = edgeList(graph, 'calls');
  // cross-package via workspace exports map (no node_modules), incl. subpath export and CJS destructured require
  assert.ok(calls.includes('apps/web/src/hooks/useFormatted.ts#useFormatted -> packages/shared/src/format.ts#formatPrice'));
  assert.ok(calls.includes('apps/web/src/hooks/useFormatted.ts#useFormatted -> packages/shared/src/money.ts#toCents'));
  assert.ok(calls.includes('apps/api/src/server.js#start -> packages/shared/src/format.ts#formatPrice'));
  // CJS exports.x = function, module.exports = { query }
  assert.ok(calls.includes('apps/api/src/server.js#start -> apps/api/src/handlers.js#listOrders'));
  assert.ok(calls.includes('apps/api/src/handlers.js#listOrders -> apps/api/src/db.js#query'));
  // this.method() and new Class()
  assert.ok(calls.includes('apps/web/src/lib/cart.ts#Cart.add -> apps/web/src/lib/cart.ts#Cart.total'));
  assert.ok(calls.includes('apps/web/src/lib/totals.ts#emptyCart -> apps/web/src/lib/cart.ts#Cart'));
  assert.deepEqual(edgeList(graph, 'renders'), ['apps/web/src/App.tsx#App -> apps/web/src/components/PriceTag.tsx#PriceTag']);
  assert.deepEqual(edgeList(graph, 'uses-hook'), ['apps/web/src/components/PriceTag.tsx#PriceTag -> apps/web/src/hooks/useFormatted.ts#useFormatted']);
  assert.deepEqual(edgeList(graph, 'dynamic-imports'), ['apps/web/src/App.tsx -> apps/web/src/pages/Settings.tsx']);
  assert.deepEqual(edgeList(graph, 'tests').sort(), ['apps/web/src/lib/cart.test.ts -> apps/web/src/lib/cart.ts', 'packages/shared/src/__tests__/format.test.ts -> packages/shared/src/format.ts']);
  assert.ok(edgeList(graph, 'imports').includes('apps/web/src/App.tsx -> apps/web/src/components/PriceTag.tsx'), 'tsconfig paths alias @/*');
  assert.deepEqual(graph.nodes.filter((n) => n.kind === 'env-var').map((n) => n.label), ['DATABASE_URL', 'DEFAULT_LOCALE', 'PLUGIN_PATH', 'PORT', 'VITE_API_URL']);
  assert.deepEqual(graph.nodes.filter((n) => n.kind === 'script').map((n) => `${n.path}#${n.label}`),
    ['apps/api/package.json#start', 'apps/web/package.json#build', 'apps/web/package.json#dev', 'apps/web/package.json#test', 'package.json#dev', 'package.json#test']);
  assert.deepEqual(graph.warnings.map((w) => `${w.code}×${w.count}`), ['ts-dynamic-require×1']);
  const fp = graph.nodes.find((n) => n.id === 'ts:function:packages/shared/src/format.ts#formatPrice')!;
  assert.deepEqual(fp.meta, { complexity: 2, doc: 'Format an amount in cents as a currency string.', exported: true, loc: 4, signature: "formatPrice(cents: number, currency = 'USD'): string" });
});

test('secret files are never listed', () => {
  const files = listFiles(copyFixture('10-pnpm-workspace'));
  assert.ok(!files.includes('apps/api/.env'));
  assert.ok(files.includes('apps/api/.env.example'));
});

test('determinism: two cold runs and a warm run are byte-identical', async () => {
  const a = await extract(copyFixture('10-pnpm-workspace'), false);
  const dir = copyFixture('10-pnpm-workspace');
  const b = await extract(dir, false);
  const warm = await extract(dir, true);
  assert.equal(a.json, b.json);
  assert.equal(warm.json, b.json);
  assert.deepEqual(warm.run.parsed, [], 'warm run parsed nothing');
});

test('incremental: re-parse changed file + importers (through barrels); result equals a cold run', async () => {
  const dir = copyFixture('10-pnpm-workspace');
  await extract(dir);
  writeFileSync(join(dir, 'packages/shared/src/money.ts'), 'export function toCents(amount: number): number {\n  return Math.round(amount * 1000) / 10;\n}\n');
  const leaf = await extract(dir);
  assert.deepEqual(leaf.run.parsed, ['apps/web/src/hooks/useFormatted.ts', 'packages/shared/src/money.ts']);

  // format.ts is re-exported by index.ts, so importers of the barrel re-parse too.
  writeFileSync(join(dir, 'packages/shared/src/format.ts'), readFileSync(join(dir, 'packages/shared/src/format.ts'), 'utf8').replace('formatPrice', 'formatMoney').replace("'USD'", "'EUR'") + '\nexport const formatPrice = formatMoney;\n');
  const barrel = await extract(dir);
  assert.deepEqual(barrel.run.parsed, [
    'apps/api/src/server.js', 'apps/web/src/hooks/useFormatted.ts',
    'packages/shared/src/__tests__/format.test.ts', 'packages/shared/src/format.ts', 'packages/shared/src/index.ts',
  ]);
  const cold = await extract(dir, false);
  assert.equal(barrel.json, cold.json, 'incremental result must equal a cold run');
});
