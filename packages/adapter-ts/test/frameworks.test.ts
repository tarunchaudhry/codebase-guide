import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, graphJsonSchema, listFiles, mergeGraphs, routeTable, type RepoGraph } from '@codebase-guide/core';
import { extractTs } from '../src/index.ts';
import { appRouteUrl, joinPath, matcherToRegExp } from '../src/frameworks/enrich.ts';
import { parsePrismaSchema } from '../src/frameworks/prisma-schema.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const SNAPSHOTS = join(import.meta.dirname, '__snapshots__');
const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name); // stable basename: root project label falls back to it
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (s) => !s.includes('.codebase-guide') });
  return dir;
};
async function extract(root: string, useCache = true) {
  const r = await extractTs(root, listFiles(root), { useCache });
  const graph = mergeGraphs([r.graph], { repoRoot: '<root>' });
  return { graph, json: canonicalJson(graph, 1), run: r.run };
}
const cache = new Map<string, Promise<RepoGraph>>();
const graphOf = (name: string) => cache.get(name) ?? cache.set(name, extract(copy(name), false).then((x) => x.graph)).get(name)!;
const short = (id: string) => id.replace(/^[a-z]+:[a-z-]+:/, '');
const edgeList = (g: RepoGraph, kind: string) => g.edges.filter((e) => e.kind === kind).map((e) => `${short(e.source)} -> ${short(e.target)}${e.inferred ? ' (inferred)' : ''}`).sort();
const meta = (g: RepoGraph, id: string) => g.nodes.find((n) => n.id === id)?.meta;

const FRAMEWORK_FIXTURES = ['01-next-app', '02-next-pages', '03-express-prisma', '04-nest', '05-fastify'];

for (const name of FRAMEWORK_FIXTURES) {
  test(`${name}: snapshot, schema, cold = warm`, async () => {
    const dir = copy(name);
    const cold = await extract(dir, false);
    const warm = await extract(dir, true);
    assert.equal(warm.json, cold.json, 'warm (cached) run must equal cold run');
    assert.deepEqual(warm.run.parsed, []);
    const snap = join(SNAPSHOTS, `${name}.graph.json`);
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) writeFileSync(snap, cold.json);
    assert.equal(cold.json, readFileSync(snap, 'utf8'), `${name} snapshot changed; rerun with UPDATE_SNAPSHOTS=1 if intended`);
    const validate = new Ajv2020({ allErrors: true }).compile(graphJsonSchema);
    assert.ok(validate(cold.graph), JSON.stringify(validate.errors, null, 1));
    assert.ok(!cold.graph.warnings.some((w) => w.code === 'graph-dangling-edge'), 'no dangling edges');
  });
}

test('01 Next App Router: route table', async () => {
  assert.deepEqual(routeTable(await graphOf('01-next-app'), { pages: true }), [
    'GET /api/todos → GET [middleware?]',
    'PAGE / → HomePage',
    'PAGE /about → AboutPage',
    'PAGE /blog/[...slug] → BlogPost',
    'PAGE /dashboard (@analytics) → AnalyticsSlot [middleware?]',
    'PAGE /dashboard → DashboardPage [middleware?]',
    'PAGE /docs/[[...path]] → Docs',
    'PAGE /edge → EdgePage',
    'PAGE /feed → FeedPage',
    'PAGE /photo/[id] (intercepting) → PhotoModal',
    'PAGE /photo/[id] → PhotoPage',
    'PAGE /todos → TodosPage',
    'POST /api/todos → POST [middleware?]',
  ]);
});

test('01 Next App Router: roles, runtime, layout tree, server actions', async () => {
  const g = await graphOf('01-next-app');
  const rt = (f: string) => meta(g, `ts:module:${f}`)?.runtime;
  assert.equal(rt('components/TodoForm.tsx'), 'client');
  assert.equal(rt('components/Button.tsx'), 'client', 'client-ness propagates through imports');
  assert.equal(rt('lib/format.ts'), 'shared', 'imported from both client and server');
  assert.equal(rt('lib/db.ts'), 'server');
  assert.equal(rt('app/actions.ts'), 'server', "'use server' modules stay server even when only client code imports them");
  assert.equal(rt('app/edge/page.tsx'), 'edge');
  assert.equal(rt('middleware.ts'), 'edge');
  assert.equal(meta(g, 'ts:module:app/_components/Header.tsx')?.role, undefined, '_private folders are not routable');
  assert.equal(meta(g, 'ts:module:app/dashboard/@analytics/default.tsx')?.role, 'default');
  assert.deepEqual(edgeList(g, 'invokes-server-action'), [
    'app/todos/page.tsx#TodosPage -> app/todos/page.tsx#deleteAll',
    'components/TodoForm.tsx#TodoForm -> app/actions.ts#createTodo',
  ]);
  const tree = edgeList(g, 'route-child');
  assert.ok(tree.includes('app/layout.tsx -> app/(marketing)/layout.tsx'));
  assert.ok(tree.includes('app/(marketing)/layout.tsx -> app/(marketing)/about/page.tsx'));
  assert.ok(tree.includes('app/dashboard/layout.tsx -> app/dashboard/@analytics/page.tsx'));
  assert.ok(!tree.some((e) => e.includes('route.ts')), 'route handlers are not layout children');
  assert.deepEqual(g.projects[0]!.frameworks, ['next']);
});

test('02 Next Pages Router: route table and roles', async () => {
  const g = await graphOf('02-next-pages');
  assert.deepEqual(routeTable(g, { pages: true }), [
    '* /api/hello → handler',
    'DELETE|GET /api/posts/[id] → postHandler',
    'PAGE / → Home',
    'PAGE /posts → Posts',
    'PAGE /posts/[id] → PostPage',
  ]);
  assert.equal(meta(g, 'ts:module:pages/_app.tsx')?.role, 'app');
  assert.equal(meta(g, 'ts:module:pages/_document.tsx')?.runtime, 'server');
  assert.equal(meta(g, 'ts:module:pages/index.tsx')?.runtime, 'shared');
});

test('03 Express + Prisma: route table, mounts, models', async () => {
  const g = await graphOf('03-express-prisma');
  assert.deepEqual(routeTable(g), [
    'DELETE /api/posts/:id → deletePost [requestLogger, requireAuth]',
    'GET /api/posts → GET / [requestLogger, requireAuth]',
    'GET /api/posts/:id → getPost [requestLogger, requireAuth]',
    'GET /api/users → listUsers [requestLogger]',
    'GET /api/users/:id → getUser [requestLogger]',
    'GET /health → GET /health [requestLogger]',
    'POST /api/users → createUser [requestLogger, requireAuth, validate]',
  ]);
  assert.deepEqual(edgeList(g, 'mounts'), [
    'src/app.ts#app -> src/routes/index.ts#apiRouter',
    'src/routes/index.ts#apiRouter -> src/routes/posts.js#router',
    'src/routes/index.ts#apiRouter -> src/routes/users.ts#router',
  ]);
  assert.deepEqual(edgeList(g, 'model-relation'), [
    'prisma/schema.prisma#Comment -> prisma/schema.prisma#Post',
    'prisma/schema.prisma#Post -> prisma/schema.prisma#Comment',
    'prisma/schema.prisma#Post -> prisma/schema.prisma#User',
    'prisma/schema.prisma#User -> prisma/schema.prisma#Post',
  ]);
  assert.deepEqual(edgeList(g, 'reads-model'), [
    'src/controllers/users.ts#getUser -> prisma/schema.prisma#User',
    'src/controllers/users.ts#listUsers -> prisma/schema.prisma#User',
    'src/routes/posts.js#GET / -> prisma/schema.prisma#Post',
    'src/routes/posts.js#getPost -> prisma/schema.prisma#Post',
  ]);
  assert.deepEqual(edgeList(g, 'writes-model'), [
    'src/controllers/users.ts#createUser -> prisma/schema.prisma#User',
    'src/routes/posts.js#deletePost -> prisma/schema.prisma#Post',
  ]);
  const user = g.nodes.find((n) => n.id === 'config:model:prisma/schema.prisma#User')!;
  assert.deepEqual(user.meta.fields, [{ name: 'id', type: 'Int' }, { name: 'email', type: 'String' }, { name: 'posts', type: 'Post[]', relation: 'many' }]);
  assert.equal(user.meta.doc, 'A registered user.');
  assert.deepEqual(g.nodes.find((n) => n.id === 'config:model:prisma/schema.prisma#Post')!.meta.fields!.find((f) => f.name === 'author'),
    { name: 'author', type: 'User', relation: 'one (fk: authorId)' });
});

test('04 NestJS: route table, module graph, DI', async () => {
  const g = await graphOf('04-nest');
  assert.deepEqual(routeTable(g), [
    'DELETE /api/orders/:id → OrdersController.remove [ThrottleGuard, AuthGuard]',
    'GET /api/orders → OrdersController.list [ThrottleGuard]',
    'GET /api/users → UsersController.findAll [ThrottleGuard, AuthGuard]',
    'GET /api/users/:id → UsersController.findOne [ThrottleGuard, AuthGuard]',
    'POST /api/users → UsersController.create [ThrottleGuard, AuthGuard, LoggingInterceptor]',
  ]);
  assert.deepEqual(edgeList(g, 'injects'), [
    'src/orders/orders.controller.ts#OrdersController -> src/orders/orders.service.ts#OrdersService',
    'src/orders/orders.service.ts#OrdersService -> src/users/users.service.ts#UsersService',
    'src/users/users.controller.ts#UsersController -> src/users/users.service.ts#UsersService',
  ]);
  assert.ok(edgeList(g, 'mounts').includes('src/orders/orders.module.ts#OrdersModule -> src/users/users.module.ts#UsersModule'));
  assert.equal(meta(g, 'ts:class:src/users/users.controller.ts#UsersController')?.role, 'controller');
  assert.equal(meta(g, 'ts:class:src/users/users.service.ts#UsersService')?.role, 'provider');
  assert.equal(meta(g, 'ts:class:src/app.module.ts#AppModule')?.role, 'nest-module');
  assert.deepEqual(meta(g, 'ts:method:src/users/users.controller.ts#UsersController.create')?.decorators, ['@nestjs/common.Post', '@nestjs/common.UseInterceptors']);
  assert.ok(g.warnings.some((w) => w.code === 'nest-token-injection' && w.count === 1));
});

test('05 Fastify: route table and plugin prefixes', async () => {
  const g = await graphOf('05-fastify');
  assert.deepEqual(routeTable(g), [
    'DELETE /users/admin/:id → deleteUser [logRequest, requireUser]',
    'GET / → GET / [logRequest]',
    'GET /sys/health → GET /health [logRequest]',
    'GET /users → listUsers [logRequest, requireUser]',
    'GET /users/:id → getUser [logRequest, requireUser, checkOwner]',
    'POST /users → createUser [logRequest, requireUser]',
  ]);
});

test('helpers: appRouteUrl, joinPath, matcherToRegExp, parsePrismaSchema', () => {
  assert.deepEqual(appRouteUrl(['(shop)', 'cart']), { url: '/cart', intercepting: false, private: false });
  assert.deepEqual(appRouteUrl(['feed', '(..)photo', '[id]']), { url: '/photo/[id]', intercepting: true, private: false });
  assert.deepEqual(appRouteUrl(['a', 'b', '(..)(..)x']), { url: '/x', intercepting: true, private: false });
  assert.deepEqual(appRouteUrl(['a', '@modal', '(...)login']), { url: '/login', slot: '@modal', intercepting: true, private: false });
  assert.equal(appRouteUrl(['_lib', 'x']).private, true);
  assert.equal(joinPath('/api/', '', '/users/', '/'), '/api/users');
  assert.equal(joinPath('', '/'), '/');
  const m = matcherToRegExp('/dashboard/:path*')!;
  assert.ok(m.test('/dashboard') && m.test('/dashboard/a/b') && !m.test('/dash'));
  assert.ok(matcherToRegExp('/((?!api|_next).*)')!.test('/about'));
  assert.ok(!matcherToRegExp('/((?!api|_next).*)')!.test('/api/x'));
  const models = parsePrismaSchema('model A {\n  id Int @id\n  bs B[]\n}\nmodel B {\n  a A? @relation(fields: [aId], references: [id])\n  aId Int?\n}\n');
  assert.deepEqual(models.map((x) => x.fields.filter((f) => f.target).map((f) => `${x.name}.${f.name}:${f.relation}`)), [['A.bs:many'], ['B.a:one (fk: aId)']]);
});
