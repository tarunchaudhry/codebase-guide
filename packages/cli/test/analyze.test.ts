import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, classifyRun, composeServices, readmeCommands, tarjan } from '@codebase-guide/core';
import { runAnalyze } from '../src/analyze.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (src) => !src.includes('.codebase-guide') });
  return dir;
};
const short = (id: string) => id.replace(/^[a-z]+:[a-z-]+:/, '');
const analyzeFixture = async (name: string) => (await runAnalyze(copy(name))).analysis;

test('reading order top-3', async () => {
  const top3 = async (f: string) => (await analyzeFixture(f)).readingOrder.slice(0, 3).map((r) => short(r.id));
  assert.deepEqual(await top3('03-express-prisma'), ['src/app.ts', 'src/routes/posts.js', 'src/controllers/users.ts']);
  assert.deepEqual(await top3('06-django-drf'), ['shop/models.py', 'accounts/views.py', 'shop/views.py']);
  assert.deepEqual(await top3('07-fastapi-sqla'), ['app/db.py', 'app/routers/items.py', 'app/routers/users.py']);
  assert.deepEqual(await top3('01-next-app'), ['lib/db.ts', 'app/actions.ts', 'middleware.ts']);
});

test('reading order reasons are built from metrics', async () => {
  const a = await analyzeFixture('07-fastapi-sqla');
  const byId = Object.fromEntries(a.readingOrder.map((r) => [short(r.id), r.reason]));
  assert.equal(byId['app/db.py'], 'used by 4 modules');
  assert.equal(byId['app/models.py'], 'used by 3 modules; defines 2 models (Item, User)');
  assert.ok(a.readingOrder.length <= 10);
});

test('cycles: Tarjan SCCs over imports', async () => {
  assert.deepEqual((await analyzeFixture('10-pnpm-workspace')).cycles.map((c) => c.map(short)), [['apps/web/src/lib/cart.ts', 'apps/web/src/lib/totals.ts']]);
  assert.deepEqual((await analyzeFixture('07-fastapi-sqla')).cycles, []);
  const adj = new Map([['a', ['b']], ['b', ['c']], ['c', ['a', 'd']], ['d', ['e']], ['e', ['d']], ['f', ['f']]]);
  assert.deepEqual(tarjan(['a', 'b', 'c', 'd', 'e', 'f'], adj).filter((c) => c.length > 1), [['a', 'b', 'c'], ['d', 'e']]);
});

test('unused-export candidates skip framework conventions', async () => {
  assert.deepEqual((await analyzeFixture('10-pnpm-workspace')).unusedExports.map((u) => short(u.id)),
    ['apps/api/src/handlers.js#getOrder', 'apps/web/src/App.tsx#App', 'apps/web/src/lib/totals.ts#emptyCart', 'packages/shared/src/strings.ts#unusedHelper']);
  assert.deepEqual((await analyzeFixture('py-basic')).unusedExports.map((u) => short(u.id)), ['src/shop/services/orders.py#late', 'src/shop/services/orders.py#shadow']);
  // pages, layouts, route handlers, Django views/models/serializers and decorated functions are never candidates
  for (const f of ['01-next-app', '06-django-drf', '07-fastapi-sqla', '04-nest']) assert.deepEqual((await analyzeFixture(f)).unusedExports, [], f);
});

test('test proximity: modules with no tests edge', async () => {
  const a = await analyzeFixture('10-pnpm-workspace');
  assert.ok(!a.untested.some((id) => id.endsWith('lib/cart.ts')), 'cart.ts has cart.test.ts');
  assert.ok(!a.untested.some((id) => id.endsWith('shared/src/format.ts')));
  assert.ok(a.untested.some((id) => id.endsWith('lib/totals.ts')));
  assert.ok(!a.untested.some((id) => /\.test\.ts$/.test(id)));
});

test('entry points', async () => {
  const kinds = (a: Awaited<ReturnType<typeof analyzeFixture>>) => [...new Set(a.entryPoints.map((e) => `${e.kind}:${short(e.id)}`))].sort();
  assert.deepEqual(kinds(await analyzeFixture('07-fastapi-sqla')), [
    'endpoint:app/main.py', 'endpoint:app/routers/items.py', 'endpoint:app/routers/users.py', 'script:app/main.py',
  ]);
  const six = kinds(await analyzeFixture('06-django-drf'));
  assert.ok(six.includes('management-command:shop/management/commands/import_products.py'));
  assert.ok(six.includes('main:manage.py'));
  const nine = kinds(await analyzeFixture('09-polyglot'));
  assert.ok(nine.includes('page:frontend/app/users/page.tsx') && nine.includes('worker:backend/app/worker.py'));
});

test('run-locally facts: every command has a source line, nothing invented', async () => {
  const a = await analyzeFixture('09-polyglot');
  assert.deepEqual(a.facts.run.map((r) => `${r.kind} ${r.command} @${r.source.path}:${r.source.line}`), [
    'install make install @Makefile:1',
    'dev make dev @Makefile:4',
    'test make test @Makefile:7',
    'other cp backend/.env.example backend/.env @README.md:8',
    'start docker compose up @docker-compose.yml:1',
    'service docker compose up db @docker-compose.yml:2',
    'service docker compose up api @docker-compose.yml:6',
    'install npm install @frontend/package.json:1',
    'build npm run build @frontend/package.json:4',
    'dev npm run dev @frontend/package.json:4',
  ]);
  assert.deepEqual(a.facts.run.find((r) => r.label === 'db')?.ports, ['5432:5432']);
  assert.deepEqual(a.facts.envExample.map((e) => e.name), ['DATABASE_URL', 'GITHUB_TOKEN']);
  assert.ok(!canonicalJson(a).includes('postgres://localhost/shop'), 'env example values never reach analysis.json');
  assert.deepEqual((await analyzeFixture('06-django-drf')).facts.run.map((r) => r.command), [
    'python manage.py migrate', 'python manage.py runserver', 'python manage.py test', 'pip install -r requirements.txt', 'python manage.py import_products',
  ]);
  assert.deepEqual((await analyzeFixture('07-fastapi-sqla')).facts.run.map((r) => `${r.command} → ${r.script}`), ['serve → app.main:run']);
});

test('tech stack with versions and sources', async () => {
  const s = (await analyzeFixture('07-fastapi-sqla')).facts.stack.map((x) => `${x.name}@${x.version ?? x.declared}`);
  assert.deepEqual(s, ['Python@>=3.10', 'fastapi@0.118.0', 'pydantic@2.11.9', 'sqlalchemy@2.0.43', 'uvicorn@0.37.0']);
});

test('flow candidates: auth, write and job slots, then score', async () => {
  assert.deepEqual((await analyzeFixture('07-fastapi-sqla')).flowCandidates.map((f) => `${f.category}:${f.title}`), [
    'write:DELETE /api/users/{user_id}', 'auth:GET /api/users/me', 'top:POST /api/users/', 'top:GET /api/items/{item_id}',
    'top:GET /api/items/', 'top:GET /api/users/', 'top:GET /health',
  ]);
  const six = await analyzeFixture('06-django-drf');
  assert.ok(six.flowCandidates.some((f) => f.category === 'job' && f.title === 'Command import_products'));
  assert.ok(six.flowCandidates.some((f) => f.category === 'auth' && f.title === 'POST /accounts/login/'));
  assert.equal(six.flowCandidates.length, 8, 'standard depth = 8');
  const quick = await runAnalyze(copy('06-django-drf'), { depth: 'quick' });
  assert.equal(quick.analysis.flowCandidates.length, 5);
});

test('determinism: analysis.json is byte-identical across runs', async () => {
  const a = await runAnalyze(copy('09-polyglot'));
  const b = await runAnalyze(copy('09-polyglot'));
  assert.equal(readFileSync(a.analysisPath, 'utf8'), readFileSync(b.analysisPath, 'utf8'));
});

test('fact parsers', () => {
  assert.deepEqual(composeServices('version: "3"\nservices:\n  web:\n    image: "node:22"\n    ports:\n      - 3000:3000 # app\n  redis:\n    image: redis\nvolumes:\n  data:\n'), [
    { name: 'web', line: 3, image: 'node:22', ports: ['3000:3000'] }, { name: 'redis', line: 7, image: 'redis', ports: [] },
  ]);
  assert.deepEqual(readmeCommands('# Dev\n```\n$ pnpm i\nnot a command\n```\n```js\nnpm run x\n```\n', 'README.md').map((r) => `${r.command}@${r.source.line}/${r.section}`), ['pnpm i@3/Dev']);
  assert.equal(classifyRun('dev', 'next dev'), 'dev');
  assert.equal(classifyRun('migrate', 'prisma migrate deploy'), 'migrate');
  assert.equal(classifyRun('test', 'vitest run'), 'test');
  assert.equal(classifyRun('build', 'tsc -p .'), 'build');
  assert.equal(classifyRun('', 'uvicorn app.main:app --reload'), 'dev');
});
