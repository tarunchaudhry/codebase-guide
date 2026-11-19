export type NodeKind =
  | 'workspace' | 'project'
  | 'module-group' | 'route-group' | 'route'
  | 'module'
  | 'function' | 'class' | 'method' | 'component' | 'endpoint'
  | 'model' | 'schema' | 'env-var' | 'script';

export type Lang = 'ts' | 'js' | 'py' | 'config';

export interface Field { name: string; type: string; relation?: string }

export interface NodeMeta {
  framework?: string;
  role?: string;
  runtime?: 'server' | 'client' | 'edge' | 'shared';
  http?: { methods: string[]; pathTemplate: string; fullPath?: string };
  signature?: string;
  doc?: string;
  fields?: Field[];
  loc?: number;
  complexity?: number;
  exportsCount?: number;
  /** Symbol is part of its module's public surface (ESM export, CJS exports, Python public name / __all__). */
  exported?: boolean;
  /** Decorators as fully-qualified dotted names where the import table resolves them (Python, TS). */
  decorators?: string[];
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  parent: string | null;
  level: 0 | 1 | 2 | 3;
  lang: Lang;
  path?: string;
  line?: number;
  endLine?: number;
  meta: NodeMeta;
}

export type EdgeKind =
  | 'imports' | 'dynamic-imports' | 'calls' | 'renders' | 'uses-hook'
  | 'invokes-server-action' | 'route-child' | 'mounts' | 'handles' | 'middleware-chain'
  | 'injects' | 'model-relation' | 'serializes' | 'validates' | 'reads-model' | 'writes-model'
  | 'reads-env' | 'fetches' | 'http' | 'tests';

export interface Evidence { path: string; line: number }

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  inferred?: boolean;
  meta?: { order?: number; prefix?: string; confidence?: 'high' | 'medium' | 'low' };
  evidence?: Evidence[];
}

export interface Warning { code: string; message: string; path?: string; count?: number }

export interface ProjectInfo { id: string; lang: string; frameworks: string[]; root: string }

export interface RepoGraph {
  version: 1;
  repoRoot: string;
  commit?: string;
  projects: ProjectInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
  warnings: Warning[];
}

/** An outbound HTTP call found by an adapter. `url` is a path/URL template with `{param}` holes; null = fully dynamic. */
export interface OutboundCall {
  src: string;
  file: string;
  line: number;
  client: string;
  /** Upper-case method, or null when it isn't statically known. */
  method: string | null;
  url: string | null;
  /** The URL starts with a non-literal base (`${API_URL}/users`), stripped before matching. */
  dynamicBase?: boolean;
}

export interface PartialGraph {
  projects?: ProjectInfo[];
  /** Outbound HTTP calls for the linker (not part of graph.json). */
  outbound?: OutboundCall[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: Warning[];
  stats?: Record<string, number>;
}

export const NODE_KINDS: readonly NodeKind[] = [
  'workspace', 'project', 'module-group', 'route-group', 'route', 'module',
  'function', 'class', 'method', 'component', 'endpoint', 'model', 'schema', 'env-var', 'script',
];

export const EDGE_KINDS: readonly EdgeKind[] = [
  'imports', 'dynamic-imports', 'calls', 'renders', 'uses-hook',
  'invokes-server-action', 'route-child', 'mounts', 'handles', 'middleware-chain',
  'injects', 'model-relation', 'serializes', 'validates', 'reads-model', 'writes-model',
  'reads-env', 'fetches', 'http', 'tests',
];

const evidence = {
  type: 'object', additionalProperties: false, required: ['path', 'line'],
  properties: { path: { type: 'string' }, line: { type: 'integer', minimum: 1 } },
} as const;

/** JSON Schema (draft 2020-12) for graph.json. Kept next to the types; a test validates fixtures against it. */
export const graphJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codebase-guide.local/graph.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'repoRoot', 'projects', 'nodes', 'edges', 'stats', 'warnings'],
  properties: {
    version: { const: 1 },
    repoRoot: { type: 'string' },
    commit: { type: 'string' },
    projects: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'lang', 'frameworks', 'root'],
        properties: {
          id: { type: 'string' }, lang: { type: 'string' }, root: { type: 'string' },
          frameworks: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'kind', 'label', 'parent', 'level', 'lang', 'meta'],
        properties: {
          id: { type: 'string' },
          kind: { enum: NODE_KINDS },
          label: { type: 'string' },
          parent: { type: ['string', 'null'] },
          level: { enum: [0, 1, 2, 3] },
          lang: { enum: ['ts', 'js', 'py', 'config'] },
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          meta: {
            type: 'object', additionalProperties: false,
            properties: {
              framework: { type: 'string' },
              role: { type: 'string' },
              runtime: { enum: ['server', 'client', 'edge', 'shared'] },
              http: {
                type: 'object', additionalProperties: false, required: ['methods', 'pathTemplate'],
                properties: {
                  methods: { type: 'array', items: { type: 'string' } },
                  pathTemplate: { type: 'string' }, fullPath: { type: 'string' },
                },
              },
              signature: { type: 'string' },
              doc: { type: 'string' },
              fields: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['name', 'type'],
                  properties: { name: { type: 'string' }, type: { type: 'string' }, relation: { type: 'string' } },
                },
              },
              loc: { type: 'integer', minimum: 0 },
              complexity: { type: 'integer', minimum: 1 },
              exportsCount: { type: 'integer', minimum: 0 },
              exported: { type: 'boolean' },
              decorators: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'source', 'target', 'kind', 'weight'],
        properties: {
          id: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' },
          kind: { enum: EDGE_KINDS },
          weight: { type: 'number', minimum: 0 },
          inferred: { type: 'boolean' },
          meta: {
            type: 'object', additionalProperties: false,
            properties: {
              order: { type: 'integer' }, prefix: { type: 'string' },
              confidence: { enum: ['high', 'medium', 'low'] },
            },
          },
          evidence: { type: 'array', items: evidence },
        },
      },
    },
    stats: { type: 'object', additionalProperties: { type: 'number' } },
    warnings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['code', 'message'],
        properties: {
          code: { type: 'string' }, message: { type: 'string' },
          path: { type: 'string' }, count: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const;
