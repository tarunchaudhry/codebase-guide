import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, graphJsonSchema, listFiles, mergeGraphs, routeTable, type RepoGraph } from '@codebase-guide/core';
import { extractPy } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name); // stable basename: root project label falls back to it
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (s) => !s.includes('.codebase-guide') && !s.includes('__pycache__') });
  return dir;
};
async function extract(root: string, useCache = true) {
  const r = await extractPy(root, listFiles(root), { useCache });
  const graph = mergeGraphs([r.graph], { repoRoot: '<root>' });
  return { graph, json: canonicalJson(graph, 1), run: r.run };
}
const cache = new Map<string, Promise<RepoGraph>>();
const graphOf = (n: string) => cache.get(n) ?? cache.set(n, extract(copy(n), false).then((x) => x.graph)).get(n)!;
const short = (id: string) => id.replace(/^[a-z]+:[a-z-]+:/, '');
const edgeList = (g: RepoGraph, kind: string) => g.edges.filter((e) => e.kind === kind).map((e) => `${short(e.source)} -> ${short(e.target)}${e.inferred ? ' (inferred)' : ''}`).sort();
const meta = (g: RepoGraph, id: string) => g.nodes.find((n) => n.id === id)?.meta;

for (const name of ['06-django-drf', '07-fastapi-sqla', '08-flask']) {
  test(`${name}: snapshot, schema, cold = warm`, async () => {
    const dir = copy(name);
    const cold = await extract(dir, false);
    const warm = await extract(dir, true);
    assert.equal(warm.json, cold.json);
    assert.deepEqual(warm.run.parsed, []);
    const snap = join(import.meta.dirname, '__snapshots__', `${name}.graph.json`);
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(snap)) writeFileSync(snap, cold.json);
    assert.equal(cold.json, readFileSync(snap, 'utf8'));
    const validate = new Ajv2020({ allErrors: true }).compile(graphJsonSchema);
    assert.ok(validate(cold.graph), JSON.stringify(validate.errors, null, 1));
    assert.ok(!cold.graph.warnings.some((w) => w.code === 'graph-dangling-edge'));
  });
}

test('06 Django + DRF: route table', async () => {
  assert.deepEqual(routeTable(await graphOf('06-django-drf')), [
    '* /api/legacy/products/(?P<pk>\\d+)/ → product_detail [AuditMiddleware]',
    '* /health/ → health [AuditMiddleware]',
    'DELETE /api/products/<pk>/ → ProductViewSet [AuditMiddleware, IsStaffOrReadOnly]',
    'GET /api/legacy/products/ → ProductListView [AuditMiddleware]',
    'GET /api/orders/ → OrderViewSet.list [AuditMiddleware]',
    'GET /api/orders/<pk>/ → OrderViewSet [AuditMiddleware]',
    'GET /api/products/ → ProductViewSet [AuditMiddleware, IsStaffOrReadOnly]',
    'GET /api/products/<pk>/ → ProductViewSet [AuditMiddleware, IsStaffOrReadOnly]',
    'GET|POST /accounts/profile/ → profile [AuditMiddleware]',
    'PATCH /api/products/<pk>/ → ProductViewSet [AuditMiddleware, IsStaffOrReadOnly]',
    'POST /accounts/login/ → LoginView [AuditMiddleware]',
    'POST /api/products/ → ProductViewSet [AuditMiddleware, IsStaffOrReadOnly]',
    'POST /api/products/<pk>/restock/ → ProductViewSet.restock [AuditMiddleware, IsStaffOrReadOnly]',
    'PUT /api/products/<pk>/ → ProductViewSet [AuditMiddleware, IsStaffOrReadOnly]',
  ]);
});

test('06 Django + DRF: models, relations, serializers, ORM, signals, commands, apps', async () => {
  const g = await graphOf('06-django-drf');
  assert.deepEqual(edgeList(g, 'model-relation'), [
    'shop/models.py#Order -> accounts/models.py#Customer',
    'shop/models.py#OrderItem -> shop/models.py#Order',
    'shop/models.py#OrderItem -> shop/models.py#Product',
    'shop/models.py#Product -> shop/models.py#Category',
  ]);
  assert.deepEqual(meta(g, 'py:class:shop/models.py#Product')?.fields, [
    { name: 'created_at', type: 'DateTimeField' }, { name: 'name', type: 'CharField' },
    { name: 'category', type: 'ForeignKey', relation: 'fk' }, { name: 'stock', type: 'IntegerField' },
  ]);
  assert.equal(meta(g, 'py:class:shop/models.py#TimeStamped')?.role, 'abstract-model');
  assert.deepEqual(meta(g, 'py:class:accounts/models.py#Customer')?.fields?.[0], { name: 'user', type: 'OneToOneField', relation: 'o2o → external' });
  assert.deepEqual(edgeList(g, 'serializes'), [
    'shop/serializers.py#OrderSerializer -> shop/models.py#Order', 'shop/serializers.py#ProductSerializer -> shop/models.py#Product',
    'shop/views.py#OrderViewSet -> shop/serializers.py#OrderSerializer', 'shop/views.py#ProductViewSet -> shop/serializers.py#ProductSerializer',
  ]);
  assert.deepEqual(edgeList(g, 'writes-model'), [
    'shop/management/commands/import_products.py#Command.handle -> shop/models.py#Product',
    'shop/views.py#ProductViewSet.restock -> shop/models.py#Product',
  ]);
  assert.ok(edgeList(g, 'reads-model').includes('accounts/views.py#profile -> accounts/models.py#Customer'));
  assert.ok(edgeList(g, 'calls').includes('shop/models.py#Order -> shop/signals.py#notify_order (inferred)'));
  assert.equal(meta(g, 'py:function:shop/signals.py#notify_order')?.role, 'signal-handler');
  const cmd = g.nodes.find((n) => n.id === 'config:script:shop/management/commands/import_products.py#import_products');
  assert.equal(cmd?.meta.signature, 'python manage.py import_products');
  assert.equal(meta(g, 'py:module-group:shop')?.role, 'django-app');
  assert.equal(meta(g, 'py:module-group:accounts')?.role, 'django-app');
  assert.deepEqual(g.projects[0]!.frameworks, ['django', 'drf']);
  assert.deepEqual(g.warnings, []);
});

test('07 FastAPI + SQLAlchemy + Pydantic: routes, DI, validation, models, ORM', async () => {
  const g = await graphOf('07-fastapi-sqla');
  assert.deepEqual(routeTable(g), [
    'DELETE /api/users/{user_id} → delete_user [add_request_id, TimingMiddleware]',
    'GET /api/items/ → list_items [add_request_id, TimingMiddleware]',
    'GET /api/items/{item_id} → get_item [add_request_id, TimingMiddleware]',
    'GET /api/users/ → list_users [add_request_id, TimingMiddleware]',
    'GET /api/users/me → me [add_request_id, TimingMiddleware]',
    'GET /health → health [add_request_id, TimingMiddleware]',
    'POST /api/users/ → create_user [add_request_id, TimingMiddleware]',
  ]);
  const inj = edgeList(g, 'injects');
  for (const e of [
    'app/deps.py#get_current_user -> app/db.py#get_db', 'app/deps.py#require_admin -> app/deps.py#get_current_user',
    'app/routers/users.py#me -> app/deps.py#get_current_user', 'app/routers/users.py#create_user -> app/db.py#get_db',
  ]) assert.ok(inj.includes(e), e);
  // endpoint-level dependencies: route `dependencies=[…]` and include_router(dependencies=[…])
  const epInj = g.edges.filter((e) => e.kind === 'injects' && e.source.startsWith('py:endpoint:')).map((e) => `${short(e.source)} -> ${short(e.target)}`).sort();
  assert.deepEqual(epInj, ['app/routers/items.py#get_item -> app/deps.py#verify_api_key', 'app/routers/items.py#list_items -> app/deps.py#verify_api_key', 'app/routers/users.py#delete_user -> app/deps.py#require_admin']);
  assert.ok(edgeList(g, 'validates').includes('app/routers/users.py#create_user -> app/schemas.py#UserCreate'), 'body model');
  assert.equal(g.edges.filter((e) => e.kind === 'validates' && e.source.startsWith('py:endpoint:')).length, 5, 'response_model on 5 endpoints');
  assert.deepEqual(edgeList(g, 'model-relation'), ['app/models.py#Item -> app/models.py#User', 'app/models.py#User -> app/models.py#Item']);
  assert.deepEqual(edgeList(g, 'reads-model'), [
    'app/deps.py#get_current_user -> app/models.py#User (inferred)', 'app/routers/items.py#get_item -> app/models.py#Item (inferred)',
    'app/routers/items.py#list_items -> app/models.py#Item', 'app/routers/users.py#list_users -> app/models.py#User (inferred)',
  ]);
  assert.deepEqual(edgeList(g, 'writes-model'), ['app/routers/users.py#create_user -> app/models.py#User (inferred)', 'app/routers/users.py#delete_user -> app/models.py#User']);
  assert.deepEqual(meta(g, 'py:class:app/models.py#Item')?.fields, [
    { name: 'id', type: 'int' }, { name: 'title', type: 'String' }, { name: 'owner_id', type: 'int', relation: 'fk (users.id)' }, { name: 'owner', type: 'User', relation: 'relationship' },
  ]);
  assert.equal(meta(g, 'py:class:app/schemas.py#UserOut')?.role, 'schema');
  assert.deepEqual(g.projects[0]!.frameworks, ['fastapi', 'pydantic', 'sqlalchemy']);
});

test('08 Flask: blueprints, hooks, MethodView, flask-sqlalchemy', async () => {
  const g = await graphOf('08-flask');
  assert.deepEqual(routeTable(g), [
    'DELETE|GET /api/v1/posts/<int:post_id> → PostView [load_user]',
    'GET /api/v1/posts → list_posts [load_user]',
    'GET|POST /auth/login → login [load_user, check_csrf]',
    'POST /api/v1/posts → create_post [load_user]',
  ]);
  assert.deepEqual(edgeList(g, 'model-relation'), ['blog/models.py#Post -> blog/models.py#User', 'blog/models.py#User -> blog/models.py#Post']);
  assert.deepEqual(edgeList(g, 'writes-model'), ['blog/api/posts.py#PostView.delete -> blog/models.py#Post', 'blog/api/posts.py#create_post -> blog/models.py#Post (inferred)']);
  assert.deepEqual(g.projects[0]!.frameworks, ['flask', 'sqlalchemy']);
});
