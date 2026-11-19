import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, graphJsonSchema, routeTable } from '@codebase-guide/core';
import { runExtract } from '../src/extract.ts';

const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name);
  cpSync(join(import.meta.dirname, '../../../fixtures', name), dir, { recursive: true, filter: (s) => !s.includes('.codebase-guide') && !s.includes('__pycache__') });
  return dir;
};
const short = (id: string) => id.replace(/^[a-z]+:[a-z-]+:/, '');

test('09 polyglot: Next → FastAPI links with confidence; dynamic URL not linked', async () => {
  const dir = copy('09-polyglot');
  const cold = await runExtract(dir, { useCache: false });
  const warm = await runExtract(dir, {});
  const norm = (g: typeof cold.graph) => canonicalJson({ ...g, repoRoot: '<root>' }, 1);
  assert.equal(norm(warm.graph), norm(cold.graph), 'cold = warm');
  const snap = join(import.meta.dirname, '__snapshots__', '09-polyglot.graph.json');
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) writeFileSync(snap, norm(cold.graph));
  assert.equal(norm(cold.graph), readFileSync(snap, 'utf8'));
  const validate = new Ajv2020({ allErrors: true }).compile(graphJsonSchema);
  assert.ok(validate(cold.graph), JSON.stringify(validate.errors, null, 1));

  const g = cold.graph;
  assert.deepEqual(routeTable(g), [
    'DELETE /api/items/{item_id} → delete_item', 'GET /api/health → health', 'GET /api/reports/{report_id}/download → download_report',
    'GET /api/session → GET', 'GET /api/users/ → list_users', 'GET /api/users/me → me', 'GET /api/users/{user_id} → get_user', 'POST /api/users/ → create_user',
  ]);
  const http = g.edges.filter((e) => e.kind === 'http');
  assert.ok(http.every((e) => e.inferred === true), 'http edges are always inferred');
  assert.deepEqual(http.map((e) => `${short(e.source)} -> ${short(e.target)} [${e.meta?.confidence}]`).sort(), [
    'backend/app/worker.py#refresh -> backend/app/routers/users.py#get_user [medium]',
    'backend/app/worker.py#sync_users -> backend/app/routers/users.py#create_user [high]',
    'frontend/app/users/page.tsx#UsersPage -> backend/app/routers/users.py#me [high]',
    'frontend/lib/api.ts#createUser -> backend/app/routers/users.py#create_user [medium]',
    'frontend/lib/api.ts#deleteItem -> backend/app/routers/items.py#delete_item [medium]',
    'frontend/lib/api.ts#getHealth -> backend/app/main.py#health [high]',
    'frontend/lib/api.ts#getSession -> frontend/app/api/session/route.ts#GET [high]',
    'frontend/lib/api.ts#getUser -> backend/app/routers/users.py#get_user [medium]',
    'frontend/lib/api.ts#listReports -> backend/app/routers/reports.py#download_report [low]',
  ]);
  assert.ok(!http.some((e) => e.source.endsWith('#callAnything')), 'fully dynamic URL is never linked');
  assert.ok(!http.some((e) => e.source.endsWith('#githubProfile') || e.source.endsWith('#charge')), 'external hosts are not linked');
  assert.equal(g.stats['http.dynamicUrls'], 1);
  assert.equal(g.stats['http.externalUrls'], 2);
  assert.deepEqual(g.projects.map((p) => `${p.id}:${p.frameworks.join('+')}`), ['py:project:backend:fastapi', 'ts:project:frontend:next']);
});
