import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointSegments, linkHttp, matchSegments, outboundSegments, type GraphNode } from '../src/index.ts';

const seg = (p: string) => outboundSegments(p, []) as ReturnType<typeof endpointSegments>;

test('param syntaxes normalize to one param segment', () => {
  for (const p of ['/u/{id}', '/u/:id', '/u/[id]', '/u/<int:id>', '/u/<id>', '/u/(?P<pk>[^/.]+)']) {
    assert.deepEqual(endpointSegments(p), [{ lit: 'u' }, { param: true }], p);
  }
  assert.deepEqual(endpointSegments('/docs/[...slug]'), [{ lit: 'docs' }, { rest: true }]);
  assert.deepEqual(endpointSegments('/api/users/'), [{ lit: 'api' }, { lit: 'users' }], 'trailing slash ignored');
});

test('confidence levels', () => {
  assert.equal(matchSegments(seg('/api/users'), endpointSegments('/api/users/')), 'high');
  assert.equal(matchSegments(seg('/api/users/{param}'), endpointSegments('/api/users/{user_id}')), 'medium');
  assert.equal(matchSegments(seg('/api/users/42'), endpointSegments('/api/users/:id')), 'medium');
  assert.equal(matchSegments(seg('/api/users/{param}'), endpointSegments('/api/users/me')), 'low');
  assert.equal(matchSegments(seg('/api/reports'), endpointSegments('/api/reports/{id}/download')), 'low');
  assert.equal(matchSegments(seg('/docs/a/b'), endpointSegments('/docs/[...slug]')), 'medium');
  assert.equal(matchSegments(seg('/api/users'), endpointSegments('/api/orders')), undefined);
});

test('hosts: localhost and configured bases stripped, other hosts are external', () => {
  assert.deepEqual(outboundSegments('http://localhost:8000/api/x?q=1', []), [{ lit: 'api' }, { lit: 'x' }]);
  assert.equal(outboundSegments('https://api.github.com/users', []), 'external');
  assert.deepEqual(outboundSegments('https://api.shop.com/v1/users', ['https://api.shop.com']), [{ lit: 'v1' }, { lit: 'users' }]);
});

test('linkHttp: method filter, best confidence only, dynamic never linked, edges inferred', () => {
  const ep = (id: string, method: string, fullPath: string): GraphNode => ({ id, kind: 'endpoint', label: id, parent: null, level: 3, lang: 'py', meta: { http: { methods: [method], pathTemplate: fullPath, fullPath } } });
  const nodes = [ep('me', 'GET', '/api/users/me'), ep('get', 'GET', '/api/users/{id}'), ep('del', 'DELETE', '/api/users/{id}')];
  const call = (url: string | null, method: string | null = 'GET', extra = {}) => ({ src: 'caller', file: 'a.ts', line: 1, client: 'fetch', method, url, ...extra });
  const r = linkHttp({ nodes }, [call('/api/users/me'), call('/api/users/{param}', 'DELETE'), call(null), call('/api/users/me', 'GET', { dynamicBase: true })]);
  assert.deepEqual(r.edges.map((e) => `${e.target}:${e.meta?.confidence}:${e.inferred}`).sort(), ['del:medium:true', 'me:high:true']);
  assert.equal(r.edges.find((e) => e.target === 'me')!.weight, 2, 'dynamic-base call is merged into the same edge');
  assert.equal(r.stats!['http.dynamicUrls'], 1);
  assert.ok(r.warnings.some((w) => w.code === 'http-dynamic-url'));
});
