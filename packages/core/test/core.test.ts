import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, globToRegExp, isSecretPath, mergeGraphs, rollupEdges, type GraphNode, type PartialGraph } from '../src/index.ts';

test('isSecretPath blocks env/keys/credentials but allows templates and code', () => {
  for (const p of ['.env', 'apps/api/.env', '.env.local', '.env.production', 'certs/server.pem', 'id_rsa', 'deploy/server.key',
    'credentials.json', 'config/secrets.yaml', '.aws/credentials', '.npmrc']) assert.equal(isSecretPath(p), true, p);
  for (const p of ['.env.example', '.env.sample', '.env.template', 'src/auth/credentials.ts', 'src/secrets.py', 'docs/secrets.md', 'src/env.ts'])
    assert.equal(isSecretPath(p), false, p);
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('apps/*').test('apps/web'));
  assert.ok(!globToRegExp('apps/*').test('apps/web/x'));
  assert.ok(globToRegExp('**/*.gen.ts').test('src/a/b.gen.ts'));
  assert.ok(globToRegExp('**/*.gen.ts').test('b.gen.ts'));
});

test('canonicalJson sorts keys recursively and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[{"y":2,"z":1}]},"b":1}\n');
});

const node = (id: string, level: GraphNode['level'], parent: string | null): GraphNode =>
  ({ id, kind: level === 0 ? 'project' : level === 1 ? 'module-group' : level === 2 ? 'module' : 'function', label: id, parent, level, lang: 'ts', meta: {} });

test('mergeGraphs dedupes, sums weights, unions evidence, drops dangling edges, sorts', () => {
  const a: PartialGraph = {
    nodes: [node('m2', 2, null), node('m1', 2, null)],
    edges: [{ id: 'imports:m1->m2', source: 'm1', target: 'm2', kind: 'imports', weight: 1, evidence: [{ path: 'b', line: 2 }] }],
    warnings: [{ code: 'w', message: 'x', path: 'z', count: 1 }],
  };
  const b: PartialGraph = {
    nodes: [node('m1', 2, null)],
    edges: [
      { id: 'imports:m1->m2', source: 'm1', target: 'm2', kind: 'imports', weight: 2, evidence: [{ path: 'a', line: 9 }] },
      { id: 'calls:m1->gone', source: 'm1', target: 'gone', kind: 'calls', weight: 1 },
    ],
    warnings: [{ code: 'w', message: 'x', path: 'a', count: 2 }],
  };
  const g = mergeGraphs([a, b], { repoRoot: '/r' });
  assert.deepEqual(g.nodes.map((n) => n.id), ['m1', 'm2']);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0]!.weight, 3);
  assert.deepEqual(g.edges[0]!.evidence, [{ path: 'a', line: 9 }, { path: 'b', line: 2 }]);
  assert.deepEqual(g.warnings.find((w) => w.code === 'w'), { code: 'w', message: 'x', count: 3, path: 'a' });
  assert.ok(g.warnings.some((w) => w.code === 'graph-dangling-edge'));
  assert.equal(canonicalJson(g), canonicalJson(mergeGraphs([a, b], { repoRoot: '/r' })));
});

test('rollupEdges lifts edges to ancestors at a level', () => {
  const nodes = [node('p', 0, null), node('g1', 1, 'p'), node('g2', 1, 'p'), node('a', 2, 'g1'), node('b', 2, 'g2'), node('c', 2, 'g2'), node('f', 3, 'a')];
  const edges = [
    { id: '1', source: 'f', target: 'b', kind: 'calls' as const, weight: 2 },
    { id: '2', source: 'a', target: 'c', kind: 'calls' as const, weight: 1 },
    { id: '3', source: 'b', target: 'c', kind: 'calls' as const, weight: 5 },
  ];
  assert.deepEqual(rollupEdges({ nodes, edges }, 1), [{ source: 'g1', target: 'g2', kind: 'calls', weight: 3 }]);
});
