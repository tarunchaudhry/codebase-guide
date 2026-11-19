/**
 * Per-file framework facts, collected from the AST during extraction and cached with the file's fragment.
 * The framework pass (enrich.ts) turns them into endpoints, mounts, chains, roles — without the AST.
 */
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { FileContext, SymbolDecl } from '../extract.ts';

export const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;
const VERB_SET = new Set<string>(HTTP_VERBS);
export const FASTIFY_ROUTE_HOOKS = ['onRequest', 'preParsing', 'preValidation', 'preHandler'] as const;
const PRISMA_READ = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const PRISMA_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);
const NEST_VERBS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Options: 'OPTIONS', Head: 'HEAD', All: 'ALL' };

/** A reference to something a route/mount/hook points at, resolved as far as the file allows. */
export type Ref =
  | { kind: 'group'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'module'; file: string }
  | { kind: 'param'; fnId: string }
  | { kind: 'external'; text: string }
  | { kind: 'unknown'; text: string };

export interface GroupFact { id: string; framework: 'express' | 'fastify'; role: 'app' | 'router'; line: number; label: string }
export interface RouteFact { receiver: Ref; methods: string[]; path: string | null; handlers: Ref[]; hooks: Ref[]; line: number; pos: number }
export interface UseFact { receiver: Ref; path: string | null; args: Ref[]; line: number; pos: number }
export interface RegisterFact { receiver: Ref; prefix: string | null; plugin: Ref; line: number; pos: number }
export interface HookFact { receiver: Ref; hook: string; ref: Ref; line: number; pos: number }
export interface NestRoute { methodId: string; verb: string; path: string; guards: Ref[]; interceptors: Ref[]; pipes: Ref[]; line: number }
export interface NestClass {
  classId: string; line: number;
  controller?: { prefix: string; routes: NestRoute[]; guards: Ref[]; interceptors: Ref[]; pipes: Ref[] };
  module?: { imports: Ref[]; controllers: Ref[]; providers: Ref[] };
  injectable?: boolean;
  injects: { ref: Ref; token?: string; line: number }[];
}
export interface HttpFact { src: string; client: string; method: string | null; url: string | null; dynamicBase?: boolean; line: number }
export interface PrismaUse { src: string; delegate: string; op: string; write: boolean; confident: boolean; line: number }

export interface FileFacts {
  directives?: string[];
  runtime?: string;
  matcher?: string[] | 'dynamic';
  defaultExport?: Ref;
  jsxActions?: { src: string; target: string; line: number }[];
  httpMethods?: string[];
  groups?: GroupFact[];
  routes?: RouteFact[];
  uses?: UseFact[];
  registers?: RegisterFact[];
  hooks?: HookFact[];
  nest?: NestClass[];
  nestGlobal?: { prefix?: string; guards: Ref[]; interceptors: Ref[]; pipes: Ref[]; line: number }[];
  prisma?: PrismaUse[];
  http?: HttpFact[];
}

// ---------------------------------------------------------------- small AST helpers (also used by extract.ts)

const literal = (n: Node | undefined) => (n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n.getLiteralText() : undefined);
const isFn = (n: Node | undefined): boolean => !!n && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));

function unwrapExpr(n: Node): Node {
  let e = n;
  while (Node.isParenthesizedExpression(e) || Node.isAsExpression(e) || Node.isNonNullExpression(e) || Node.isSatisfiesExpression(e)) e = e.getExpression();
  return e;
}

export function hasDirective(fn: Node, directive: string): boolean {
  const body = Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) ? fn.getBody() : undefined;
  if (!body || !Node.isBlock(body)) return false;
  const first = body.getStatements()[0];
  return !!first && Node.isExpressionStatement(first) && literal(first.getExpression()) === directive;
}

/** Function-like args of route-registration-shaped calls: `x.get('/p', fn)`, `x.use(fn)`, `x.route({handler})`, `x.addHook('h', fn)`, `x.register(fn)`. */
export function inlineHandlerArgs(call: CallExpression): { fn: Node; name: string; role: string }[] {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return [];
  const verb = callee.getName();
  const args = call.getArguments();
  const flat = args.flatMap((a) => (Node.isArrayLiteralExpression(a) ? a.getElements() : [a]));
  const out: { fn: Node; name: string; role: string }[] = [];
  const p = literal(args[0]);
  if (VERB_SET.has(verb) && p !== undefined && /^[/*]/.test(p)) {
    const fns = flat.filter(isFn);
    fns.forEach((fn, i) => out.push({ fn, name: `${verb.toUpperCase()} ${p}${i < fns.length - 1 ? ` [${i + 1}]` : ''}`, role: i < fns.length - 1 ? 'middleware' : 'route-handler' }));
    for (const a of args) if (Node.isObjectLiteralExpression(a)) out.push(...objectHookFns(a, `${verb.toUpperCase()} ${p}`));
  } else if (verb === 'use') {
    for (const fn of flat.filter(isFn)) out.push({ fn, name: p !== undefined ? `use ${p}` : 'use', role: 'middleware' });
  } else if (verb === 'route' && args[0] && Node.isObjectLiteralExpression(args[0])) {
    const o = args[0];
    const url = literal(o.getProperty('url')?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer());
    const methodInit = o.getProperty('method')?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
    const m = literal(methodInit) ?? 'ROUTE';
    const label = `${m.toUpperCase()} ${url ?? '?'}`;
    const h = o.getProperty('handler');
    const hf = h && Node.isPropertyAssignment(h) ? h.getInitializer() : h && Node.isMethodDeclaration(h) ? h : undefined;
    if (hf && (isFn(hf) || Node.isMethodDeclaration(hf))) out.push({ fn: hf, name: label, role: 'route-handler' });
    out.push(...objectHookFns(o, label));
  } else if (verb === 'addHook' && literal(args[0])) {
    for (const fn of flat.filter(isFn)) out.push({ fn, name: `hook ${literal(args[0])}`, role: 'middleware' });
  } else if (verb === 'register') {
    const a0 = args[0];
    if (a0 && isFn(a0)) out.push({ fn: a0, name: 'plugin', role: 'plugin' });
  }
  return out;
}

function objectHookFns(o: Node, label: string): { fn: Node; name: string; role: string }[] {
  if (!Node.isObjectLiteralExpression(o)) return [];
  const out: { fn: Node; name: string; role: string }[] = [];
  for (const h of FASTIFY_ROUTE_HOOKS) {
    const init = o.getProperty(h)?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
    const fns = init ? (Node.isArrayLiteralExpression(init) ? init.getElements() : [init]).filter(isFn) : [];
    for (const fn of fns) out.push({ fn, name: `${label} ${h}`, role: 'middleware' });
  }
  return out;
}

/** Module a local identifier was imported/required from ('express', './x'), if any. */
export function importSourceOf(id: Node): { source: string; imported: string } | undefined {
  if (!Node.isIdentifier(id)) return undefined;
  const decl = id.getSymbol()?.getDeclarations()[0];
  if (!decl) return undefined;
  if (Node.isImportSpecifier(decl)) return { source: decl.getImportDeclaration().getModuleSpecifierValue(), imported: decl.getName() };
  if (Node.isImportClause(decl)) return { source: decl.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration).getModuleSpecifierValue(), imported: 'default' };
  if (Node.isNamespaceImport(decl)) return { source: decl.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration).getModuleSpecifierValue(), imported: '*' };
  if (Node.isImportEqualsDeclaration(decl)) {
    const r = decl.getModuleReference();
    const s = Node.isExternalModuleReference(r) ? literal(r.getExpression()) : undefined;
    return s ? { source: s, imported: '*' } : undefined;
  }
  const requireOf = (init: Node | undefined) => {
    const e = init && unwrapExpr(init);
    return e && Node.isCallExpression(e) && e.getExpression().getText() === 'require' ? literal(e.getArguments()[0]) : undefined;
  };
  if (Node.isVariableDeclaration(decl)) { const s = requireOf(decl.getInitializer()); return s ? { source: s, imported: '*' } : undefined; }
  if (Node.isBindingElement(decl)) {
    const vd = decl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const s = requireOf(vd?.getInitializer());
    return s ? { source: s, imported: decl.getPropertyNameNode()?.getText() ?? decl.getName() } : undefined;
  }
  return undefined;
}

/** `meta.decorators` for TS classes/methods: `@nestjs/common.Get` when imported, else the name as written. */
export function decoratorsMeta(node: Node): { decorators?: string[] } {
  if (!(Node.isClassDeclaration(node) || Node.isMethodDeclaration(node) || Node.isPropertyDeclaration(node))) return {};
  const ds = node.getDecorators().map((d) => {
    const call = d.getCallExpression();
    const e = call ? call.getExpression() : d.getExpression();
    const root = Node.isPropertyAccessExpression(e) ? e.getExpression() : e;
    const src = importSourceOf(root);
    return src ? `${src.source}.${e.getText()}` : e.getText();
  });
  return ds.length ? { decorators: ds } : {};
}

// ---------------------------------------------------------------- collector

const EXPRESS = 'express';
const FASTIFY = 'fastify';

export function collectFacts(ctx: FileContext, sf: SourceFile, rel: string, decls: { list: SymbolDecl[]; byNode: Map<import('ts-morph').ts.Node, string> }): FileFacts | undefined {
  const f: FileFacts = {};
  const push = <K extends keyof FileFacts>(k: K, v: NonNullable<FileFacts[K]> extends (infer T)[] ? T : never) => {
    ((f[k] ??= [] as never) as unknown[]).push(v);
  };
  const enclosing = (n: Node): string => {
    for (let p: Node | undefined = n.getParent(); p; p = p.getParent()) {
      const id = decls.byNode.get(p.compilerNode);
      if (id && (Node.isFunctionLikeDeclaration(p) || Node.isArrowFunction(p) || Node.isFunctionExpression(p) || Node.isMethodDeclaration(p) || Node.isClassDeclaration(p))) return id;
    }
    return `${rel.match(/\.[cm]?tsx?$/) ? 'ts' : 'js'}:module:${rel}`;
  };

  // --- groups: const app = express() / express.Router() / Router() / Fastify()
  const factoryOf = (init: Node | undefined): { framework: 'express' | 'fastify'; role: 'app' | 'router' } | undefined => {
    const e = init && unwrapExpr(init);
    if (!e || !Node.isCallExpression(e)) return undefined;
    const callee = e.getExpression();
    if (Node.isIdentifier(callee)) {
      const src = importSourceOf(callee);
      if (src?.source === EXPRESS) return { framework: 'express', role: src.imported === 'Router' ? 'router' : 'app' };
      if (src?.source === FASTIFY) return { framework: 'fastify', role: 'app' };
    } else if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'Router') {
      if (importSourceOf(callee.getExpression())?.source === EXPRESS) return { framework: 'express', role: 'router' };
    }
    return undefined;
  };
  const groupIdOf = (decl: Node, depth = 0): string | undefined => {
    if (depth > 4) return undefined;
    if (Node.isVariableDeclaration(decl) && factoryOf(decl.getInitializer())) {
      const file = ctx.rel(decl.getSourceFile().getFilePath());
      return file ? `ts:route-group:${file}#${decl.getName()}` : undefined;
    }
    if (Node.isExportAssignment(decl)) return groupOfExpr(decl.getExpression(), depth + 1);
    if (Node.isShorthandPropertyAssignment(decl)) { const v = decl.getValueSymbol()?.getDeclarations()[0]; return v ? groupIdOf(v, depth + 1) : undefined; }
    if (Node.isPropertyAssignment(decl)) { const i = decl.getInitializer(); return i ? groupOfExpr(i, depth + 1) : undefined; }
    if (Node.isBinaryExpression(decl)) return groupOfExpr(decl.getRight(), depth + 1);
    return undefined;
  };
  const groupOfExpr = (expr: Node, depth = 0): string | undefined => {
    const e = unwrapExpr(expr);
    const target = Node.isPropertyAccessExpression(e) ? e.getNameNode() : e;
    if (!Node.isIdentifier(target)) return undefined;
    let sym = target.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    for (const d of sym?.getDeclarations() ?? []) { const g = groupIdOf(d, depth); if (g) return g; }
    return undefined;
  };

  const refOf = (expr: Node): Ref => {
    const e = unwrapExpr(expr);
    if (isFn(e) || Node.isMethodDeclaration(e)) {
      const id = decls.byNode.get(e.compilerNode);
      return id ? { kind: 'node', id } : { kind: 'unknown', text: 'inline function' };
    }
    if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
      const g = groupOfExpr(e);
      if (g) return { kind: 'group', id: g };
      const r = ctx.resolveCallee(e);
      if (r !== 'external' && r !== 'unresolved' && r !== 'non-symbol') return { kind: 'node', id: r };
      // default import of a module whose default export isn't a symbol node (resolved in the framework pass)
      const src = Node.isIdentifier(e) ? importSourceOf(e) : undefined;
      if (src && (src.imported === 'default' || src.imported === '*')) {
        const file = ctx.resolveSpecifier(src.source, sf.getFilePath());
        if (file !== 'external' && file !== 'asset' && file !== 'unresolved') return { kind: 'module', file };
      }
      return r === 'external' ? { kind: 'external', text: e.getText() } : { kind: 'unknown', text: e.getText() };
    }
    if (Node.isCallExpression(e)) {
      const callee = e.getExpression();
      if (callee.getText() === 'require' || callee.getKind() === SyntaxKind.ImportKeyword) {
        const s = literal(e.getArguments()[0]);
        const file = s ? ctx.resolveSpecifier(s, sf.getFilePath()) : 'unresolved';
        if (file !== 'external' && file !== 'asset' && file !== 'unresolved') return { kind: 'module', file };
        return { kind: 'external', text: e.getText().slice(0, 80) };
      }
      // wrapper(handler) → the wrapped handler; factory('arg') → the factory
      const inner = e.getArguments().find((a) => isFn(a) || Node.isIdentifier(a) || Node.isPropertyAccessExpression(a));
      if (inner) { const r = refOf(inner); if (r.kind === 'node' || r.kind === 'group') return r; }
      const r = refOf(callee);
      return r.kind === 'node' || r.kind === 'external' ? r : { kind: 'unknown', text: e.getText().slice(0, 80) };
    }
    if (Node.isNewExpression(e)) return refOf(e.getExpression());
    return { kind: 'unknown', text: e.getText().slice(0, 80) };
  };
  const refsOf = (args: Node[]): Ref[] => args.flatMap((a) => (Node.isArrayLiteralExpression(a) ? a.getElements() : [a])).map(refOf);

  const receiverOf = (obj: Node): Ref | undefined => {
    const e = unwrapExpr(obj);
    const g = groupOfExpr(e);
    if (g) return { kind: 'group', id: g };
    if (Node.isIdentifier(e)) {
      const d = e.getSymbol()?.getDeclarations()[0];
      if (d && Node.isParameterDeclaration(d)) {
        const fn = d.getParent();
        const fnId = fn && decls.byNode.get(fn.compilerNode);
        const isFirst = fn && (Node.isFunctionLikeDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) && fn.getParameters()[0] === d;
        if (fnId && isFirst) return { kind: 'param', fnId };
      }
    }
    return undefined;
  };

  // --- file-level directives, runtime, middleware matcher, default export
  const dirs: string[] = [];
  for (const st of sf.getStatements()) {
    const s = Node.isExpressionStatement(st) ? literal(st.getExpression()) : undefined;
    if (s === undefined) break;
    if (s === 'use client' || s === 'use server') dirs.push(s);
  }
  if (dirs.length) f.directives = dirs;
  for (const st of sf.getVariableStatements()) {
    if (!st.isExported()) continue;
    for (const d of st.getDeclarations()) {
      if (d.getName() === 'runtime' && literal(d.getInitializer())) f.runtime = literal(d.getInitializer())!;
      if (d.getName() === 'config' && Node.isObjectLiteralExpression(d.getInitializer())) {
        const m = d.getInitializerOrThrow().asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperty('matcher');
        const v = m && Node.isPropertyAssignment(m) ? m.getInitializer() : undefined;
        if (v) {
          const items = Node.isArrayLiteralExpression(v) ? v.getElements() : [v];
          const strs = items.map((i) => literal(i) ?? (Node.isObjectLiteralExpression(i) ? literal(i.getProperty('source')?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()) : undefined));
          f.matcher = strs.every((x) => x !== undefined) ? (strs as string[]) : 'dynamic';
        }
      }
    }
  }
  const defaultExport = (): Ref | undefined => {
    const sym = sf.getDefaultExportSymbol();
    const s = sym?.isAlias() ? sym.getAliasedSymbol() ?? sym : sym;
    for (const d of s?.getDeclarations() ?? []) {
      if (Node.isExportAssignment(d)) return refOf(d.getExpression());
      const id = ctx.idOfDecl(d);
      if (id && id !== 'external') return { kind: 'node', id };
      const g = groupIdOf(d);
      if (g) return { kind: 'group', id: g };
    }
    for (const st of sf.getStatements()) {
      if (!Node.isExpressionStatement(st)) continue;
      const e = st.getExpression();
      if (Node.isBinaryExpression(e) && e.getLeft().getText() === 'module.exports') return refOf(e.getRight());
    }
    return undefined;
  };
  const de = defaultExport();
  if (de && de.kind !== 'unknown') f.defaultExport = de;

  // --- outbound HTTP: fetch / axios / ky / useSWR / configured apiClients
  const constString = (id: Node, depth: number): Node | undefined => {
    let sym = id.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    const d = sym?.getDeclarations()[0];
    if (d && Node.isVariableDeclaration(d) && d.getVariableStatement()?.getDeclarationKind() === 'const' && depth < 4) return d.getInitializer();
    return undefined;
  };
  /** URL expression → template with {param} holes; a leading non-literal before '/' becomes a dynamic base. */
  const urlOf = (expr: Node | undefined, depth = 0): { url: string; dynamicBase: boolean } | null => {
    if (!expr || depth > 4) return null;
    const e = unwrapExpr(expr);
    const lit = literal(e);
    if (lit !== undefined) return { url: lit, dynamicBase: false };
    const parts: (string | null)[] = [];
    if (Node.isTemplateExpression(e)) {
      parts.push(e.getHead().getLiteralText());
      for (const sp of e.getTemplateSpans()) {
        const inner = urlOf(sp.getExpression(), depth + 1);
        parts.push(inner && !inner.dynamicBase ? inner.url : null, sp.getLiteral().getLiteralText());
      }
    } else if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const flat: Node[] = [];
      const walk = (x: Node) => { const u = unwrapExpr(x); if (Node.isBinaryExpression(u) && u.getOperatorToken().getKind() === SyntaxKind.PlusToken) { walk(u.getLeft()); walk(u.getRight()); } else flat.push(u); };
      walk(e);
      for (const x of flat) { const r = urlOf(x, depth + 1); parts.push(r && !r.dynamicBase ? r.url : null); }
    } else if (Node.isIdentifier(e)) {
      const init = constString(e, depth);
      return init ? urlOf(init, depth + 1) : null;
    } else if (Node.isNewExpression(e) && e.getExpression().getText() === 'URL') {
      return urlOf(e.getArguments()[0], depth + 1);
    } else return null;
    // a leading hole followed by a path is a base URL (`${API}/users`); other holes are params
    let dynamicBase = false;
    while (parts.length && (parts[0] === null || parts[0] === '')) {
      if (parts[0] === null) dynamicBase = true;
      parts.shift();
    }
    const url = parts.map((p) => (p === null ? '{param}' : p)).join('');
    if (!url || url === '{param}' || (dynamicBase && !url.startsWith('/'))) return null;
    return { url, dynamicBase };
  };
  const methodOf = (opts: Node | undefined, dflt: string | null): string | null => {
    const o = opts && unwrapExpr(opts);
    if (!o || !Node.isObjectLiteralExpression(o)) return dflt;
    const pr = o.getProperty('method');
    if (!pr) return dflt;
    const v = Node.isPropertyAssignment(pr) ? literal(pr.getInitializer()) : undefined;
    return v ? v.toUpperCase() : null;
  };
  const instanceBase = (obj: Node): { client: string; base: { url: string; dynamicBase: boolean } | null } | undefined => {
    const e = unwrapExpr(obj);
    if (!Node.isIdentifier(e) && !Node.isPropertyAccessExpression(e)) return undefined;
    const target = Node.isPropertyAccessExpression(e) ? e.getNameNode() : e;
    let sym = target.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    const d = sym?.getDeclarations()[0];
    const init = d && (Node.isVariableDeclaration(d) || Node.isPropertyDeclaration(d)) ? d.getInitializer() : undefined;
    const call = init && unwrapExpr(init);
    if (!call || !Node.isCallExpression(call)) return undefined;
    const f = call.getExpression();
    if (!Node.isPropertyAccessExpression(f) || !/^(create|extend)$/.test(f.getName())) return undefined;
    const lib = importSourceOf(f.getExpression())?.source;
    if (lib !== 'axios' && lib !== 'ky') return undefined;
    const cfg = call.getArguments()[0];
    const key = lib === 'axios' ? 'baseURL' : 'prefixUrl';
    const pv = cfg && Node.isObjectLiteralExpression(cfg) ? cfg.getProperty(key) : undefined;
    const bv = pv && Node.isPropertyAssignment(pv) ? pv.getInitializer() : undefined;
    return { client: `${lib} instance`, base: bv ? urlOf(bv) ?? { url: '', dynamicBase: true } : null };
  };
  const apiClients = new Set(ctx.apiClients);
  const httpCall = (n: CallExpression) => {
    const callee = n.getExpression();
    const args = n.getArguments();
    const out = (client: string, urlNode: Node | undefined, method: string | null, base?: { url: string; dynamicBase: boolean } | null) => {
      let u = urlOf(urlNode);
      if (u && base) u = { url: base.url.replace(/\/$/, '') + (u.url.startsWith('/') || !base.url ? '' : '/') + u.url, dynamicBase: base.dynamicBase || u.dynamicBase };
      push('http', { src: enclosing(n), client, method, url: u?.url ?? null, ...(u?.dynamicBase ? { dynamicBase: true } : {}), line: n.getStartLineNumber() });
    };
    const text = callee.getText();
    if (Node.isIdentifier(callee)) {
      const src = importSourceOf(callee);
      if (text === 'fetch' && !src) {
        const r = ctx.resolveCallee(callee); // a repo-local function named fetch is not the global
        if (r === 'external' || r === 'unresolved') return out('fetch', args[0], methodOf(args[1], 'GET'));
        return;
      }
      if (src?.source === 'axios' && src.imported === 'default') {
        const a0 = args[0] && unwrapExpr(args[0]);
        if (a0 && Node.isObjectLiteralExpression(a0)) { const u = a0.getProperty('url'); return out('axios', u && Node.isPropertyAssignment(u) ? u.getInitializer() : undefined, methodOf(a0, 'GET')); }
        return out('axios', args[0], methodOf(args[1], 'GET'));
      }
      if (src?.source === 'ky' && src.imported === 'default') return out('ky', args[0], methodOf(args[1], 'GET'));
      if (src?.source === 'swr' && (src.imported === 'default' || src.imported === 'useSWR')) return out('swr', args[0], 'GET');
      if (apiClients.has(text)) return out(text, args[0], methodOf(args[1], null));
      return;
    }
    if (!Node.isPropertyAccessExpression(callee)) return;
    const verb = callee.getName();
    const obj = callee.getExpression();
    if (verb === 'fetch' && /^(window|globalThis|self)$/.test(obj.getText())) return out('fetch', args[0], methodOf(args[1], 'GET'));
    const isVerb = VERB_SET.has(verb) && verb !== 'all';
    const lib = Node.isIdentifier(obj) ? importSourceOf(obj) : undefined;
    if ((lib?.source === 'axios' || lib?.source === 'ky') && (isVerb || verb === 'request')) {
      if (verb === 'request') { const c = args[0] && unwrapExpr(args[0]); const u = c && Node.isObjectLiteralExpression(c) ? c.getProperty('url') : undefined; return out(lib.source, u && Node.isPropertyAssignment(u) ? u.getInitializer() : undefined, methodOf(c, 'GET')); }
      return out(lib.source, args[0], verb.toUpperCase());
    }
    if (isVerb && apiClients.has(obj.getText())) return out(obj.getText(), args[0], verb.toUpperCase());
    if (isVerb) {
      const inst = instanceBase(obj);
      if (inst) return out(inst.client, args[0], verb.toUpperCase(), inst.base);
    }
  };

  // --- walk
  sf.forEachDescendant((n) => {
    if (Node.isCallExpression(n)) httpCall(n);
    if (Node.isVariableDeclaration(n)) {
      const fac = factoryOf(n.getInitializer());
      if (fac) push('groups', { id: `ts:route-group:${rel}#${n.getName()}`, ...fac, line: n.getStartLineNumber(), label: n.getName() });
      return;
    }
    if (Node.isJsxAttribute(n)) {
      const name = n.getNameNode().getText();
      if (name !== 'action' && name !== 'formAction') return;
      const init = n.getInitializer();
      const expr = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
      if (expr) { const r = refOf(expr); if (r.kind === 'node') push('jsxActions', { src: enclosing(n), target: r.id, line: n.getStartLineNumber() }); }
      return;
    }
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsEqualsEqualsToken) {
      // pages/api: if (req.method === 'POST')
      const [l, r] = [n.getLeft(), n.getRight()];
      const m = /\.method$/.test(l.getText()) ? literal(r) : /\.method$/.test(r.getText()) ? literal(l) : undefined;
      if (m && /^[A-Z]+$/.test(m)) f.httpMethods = [...new Set([...(f.httpMethods ?? []), m])].sort();
      return;
    }
    if (Node.isSwitchStatement(n) && /\.method$/.test(n.getExpression().getText())) {
      for (const c of n.getClauses()) {
        const m = Node.isCaseClause(c) ? literal(c.getExpression()) : undefined;
        if (m && /^[A-Z]+$/.test(m)) f.httpMethods = [...new Set([...(f.httpMethods ?? []), m])].sort();
      }
      return;
    }
    if (!Node.isCallExpression(n)) return;
    const callee = n.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const name = callee.getName();
    const args = n.getArguments();
    const line = n.getStartLineNumber();
    const pos = n.getStart();

    // prisma.<delegate>.<op>(…)
    if (PRISMA_READ.has(name) || PRISMA_WRITE.has(name)) {
      const del = callee.getExpression();
      if (Node.isPropertyAccessExpression(del) && !del.getName().startsWith('$')) {
        const client = del.getExpression();
        push('prisma', { src: enclosing(n), delegate: del.getName(), op: name, write: PRISMA_WRITE.has(name), confident: isPrismaClient(client), line });
        return;
      }
    }

    // Nest global setup: app.setGlobalPrefix('api'), app.useGlobalGuards(new X())
    if (/^(setGlobalPrefix|useGlobalGuards|useGlobalInterceptors|useGlobalPipes)$/.test(name)) {
      const g = { guards: [] as Ref[], interceptors: [] as Ref[], pipes: [] as Ref[], line } as NonNullable<FileFacts['nestGlobal']>[number];
      if (name === 'setGlobalPrefix') { const p = literal(args[0]); if (p !== undefined) g.prefix = p; }
      else (g[name === 'useGlobalGuards' ? 'guards' : name === 'useGlobalInterceptors' ? 'interceptors' : 'pipes']).push(...refsOf(args));
      push('nestGlobal', g);
      return;
    }

    // express chained: router.route('/p').get(h).post(h2)
    if (VERB_SET.has(name)) {
      let base: Node = callee.getExpression();
      while (Node.isCallExpression(base) && Node.isPropertyAccessExpression(base.getExpression()) && VERB_SET.has((base.getExpression() as import('ts-morph').PropertyAccessExpression).getName())) {
        base = (base.getExpression() as import('ts-morph').PropertyAccessExpression).getExpression();
      }
      if (Node.isCallExpression(base) && Node.isPropertyAccessExpression(base.getExpression()) && (base.getExpression() as import('ts-morph').PropertyAccessExpression).getName() === 'route') {
        const routeCall = base;
        const recv = receiverOf((routeCall.getExpression() as import('ts-morph').PropertyAccessExpression).getExpression());
        const p = literal(routeCall.getArguments()[0]);
        if (recv && p !== undefined) push('routes', { receiver: recv, methods: [name.toUpperCase()], path: p, handlers: refsOf(args), hooks: [], line, pos });
        return;
      }
    }

    const recv = receiverOf(callee.getExpression());
    if (!recv) return;
    if (VERB_SET.has(name)) {
      const first = args[0];
      const p = literal(first);
      const isPath = p !== undefined && /^[/*]/.test(p);
      const dynamicPath = first && Node.isTemplateExpression(first);
      if (!isPath && !dynamicPath) return;
      const rest = args.slice(1);
      const opts = rest.find((a) => Node.isObjectLiteralExpression(a));
      const handlers = refsOf(rest.filter((a) => !Node.isObjectLiteralExpression(a)));
      const hooks = opts ? hookRefs(opts) : [];
      push('routes', { receiver: recv, methods: [name.toUpperCase()], path: isPath ? p! : null, handlers, hooks, line, pos });
    } else if (name === 'route' && args[0] && Node.isObjectLiteralExpression(args[0])) {
      const o = args[0];
      const prop = (k: string) => { const pr = o.getProperty(k); return pr && Node.isPropertyAssignment(pr) ? pr.getInitializer() : pr && Node.isMethodDeclaration(pr) ? pr : undefined; };
      const mInit = prop('method');
      const methods = mInit ? (Node.isArrayLiteralExpression(mInit) ? mInit.getElements().map(literal) : [literal(mInit)]).filter((x): x is string => !!x).map((x) => x.toUpperCase()) : [];
      const url = literal(prop('url'));
      const h = prop('handler');
      push('routes', { receiver: recv, methods: methods.length ? methods : ['?'], path: url ?? null, handlers: h ? [refOf(h)] : [], hooks: hookRefs(o), line, pos });
    } else if (name === 'use') {
      const p = literal(args[0]);
      const rest = p !== undefined ? args.slice(1) : args;
      push('uses', { receiver: recv, path: p ?? null, args: refsOf(rest), line, pos });
    } else if (name === 'register' && args[0]) {
      const opts = args[1];
      let prefix: string | null = null;
      if (opts && Node.isObjectLiteralExpression(opts)) {
        const pr = opts.getProperty('prefix');
        prefix = pr && Node.isPropertyAssignment(pr) ? literal(pr.getInitializer()) ?? null : null;
      }
      push('registers', { receiver: recv, prefix, plugin: refOf(args[0]), line, pos });
    } else if (name === 'addHook') {
      const h = literal(args[0]);
      if (h) for (const r of refsOf(args.slice(1))) push('hooks', { receiver: recv, hook: h, ref: r, line, pos });
    }
  });

  // --- NestJS classes
  for (const d of decls.list) {
    if (d.kind !== 'class' || !Node.isClassDeclaration(d.node)) continue;
    const cls = d.node;
    const nestDeco = (node: { getDecorators(): import('ts-morph').Decorator[] }, names: string[]) =>
      node.getDecorators().filter((dec) => {
        const call = dec.getCallExpression();
        const e = call ? call.getExpression() : dec.getExpression();
        const src = importSourceOf(e);
        return src?.source.startsWith('@nestjs/') && names.includes(src.imported);
      });
    const decoArgs = (node: { getDecorators(): import('ts-morph').Decorator[] }, name: string) => nestDeco(node, [name]).flatMap((x) => x.getArguments());
    const nc: NestClass = { classId: d.id, line: cls.getStartLineNumber(), injects: [] };
    const ctl = nestDeco(cls, ['Controller'])[0];
    if (ctl) {
      const a = ctl.getArguments()[0];
      let prefix = '';
      if (a && literal(a) !== undefined) prefix = literal(a)!;
      else if (a && Node.isObjectLiteralExpression(a)) prefix = literal(a.getProperty('path')?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()) ?? '';
      const routes: NestRoute[] = [];
      for (const m of cls.getMethods()) {
        const verbDeco = nestDeco(m, Object.keys(NEST_VERBS))[0];
        if (!verbDeco) continue;
        const mid = decls.byNode.get(m.compilerNode);
        if (!mid) continue;
        const vName = importSourceOf((verbDeco.getCallExpression()?.getExpression() ?? verbDeco.getExpression()))!.imported;
        const pa = verbDeco.getArguments()[0];
        routes.push({
          methodId: mid, verb: NEST_VERBS[vName]!, path: (pa && literal(pa)) ?? '', line: m.getStartLineNumber(),
          guards: refsOf(decoArgs(m, 'UseGuards')), interceptors: refsOf(decoArgs(m, 'UseInterceptors')), pipes: refsOf(decoArgs(m, 'UsePipes')),
        });
      }
      nc.controller = { prefix, routes, guards: refsOf(decoArgs(cls, 'UseGuards')), interceptors: refsOf(decoArgs(cls, 'UseInterceptors')), pipes: refsOf(decoArgs(cls, 'UsePipes')) };
    }
    const mod = nestDeco(cls, ['Module'])[0];
    if (mod) {
      const o = mod.getArguments()[0];
      const list = (k: string) => {
        const v = o && Node.isObjectLiteralExpression(o) ? o.getProperty(k)?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer() : undefined;
        return v && Node.isArrayLiteralExpression(v) ? refsOf(v.getElements()) : [];
      };
      nc.module = { imports: list('imports'), controllers: list('controllers'), providers: list('providers') };
    }
    if (nestDeco(cls, ['Injectable']).length) nc.injectable = true;
    for (const ctor of cls.getConstructors()) {
      for (const p of ctor.getParameters()) {
        const tokenDeco = nestDeco(p, ['Inject'])[0];
        const token = tokenDeco ? literal(tokenDeco.getArguments()[0]) : undefined;
        const tn = p.getTypeNode();
        const typeName = tn && Node.isTypeReference(tn) ? tn.getTypeName() : undefined;
        if (token !== undefined) nc.injects.push({ ref: { kind: 'unknown', text: token }, token, line: p.getStartLineNumber() });
        else if (typeName) nc.injects.push({ ref: refOf(typeName), line: p.getStartLineNumber() });
      }
    }
    if (nc.controller || nc.module || nc.injectable || nc.injects.length) push('nest', nc);
  }

  return Object.keys(f).length ? f : undefined;

  function hookRefs(o: Node): Ref[] {
    if (!Node.isObjectLiteralExpression(o)) return [];
    const out: Ref[] = [];
    for (const h of FASTIFY_ROUTE_HOOKS) {
      const init = o.getProperty(h)?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
      if (init) out.push(...refsOf([init]));
    }
    return out;
  }

  function isPrismaClient(client: Node): boolean {
    const e = unwrapExpr(client);
    const target = Node.isPropertyAccessExpression(e) ? e.getNameNode() : e;
    let sym = target.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    for (const d of sym?.getDeclarations() ?? []) {
      const init = Node.isVariableDeclaration(d) || Node.isPropertyDeclaration(d) ? d.getInitializer() : undefined;
      if (init && Node.isNewExpression(unwrapExpr(init)) && /PrismaClient$/.test((unwrapExpr(init) as import('ts-morph').NewExpression).getExpression().getText())) return true;
      const tn = Node.isPropertyDeclaration(d) || Node.isParameterDeclaration(d) || Node.isVariableDeclaration(d) ? d.getTypeNode()?.getText() : undefined;
      if (tn && /Prisma(Client|Service)\b/.test(tn)) return true;
    }
    return false;
  }
}
