/**
 * AST-free framework pass over cached per-file facts: Express, Fastify, NestJS, Next.js, Prisma.
 * Produces endpoint/route/route-group/model nodes, framework edges, and meta patches for existing nodes.
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { EdgeSet, Warnings, type GraphEdge, type GraphNode, type NodeMeta } from '@codebase-guide/core';
import { isDts, isTestFile, TS_EXT, type TsProjectInfo } from '../detect.ts';
import type { FileFacts, Ref, RouteFact } from './facts.ts';
import { parsePrismaSchema } from './prisma-schema.ts';

export interface FragmentView { nodes: GraphNode[]; edges: GraphEdge[]; facts?: FileFacts }

export interface EnrichResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: ReturnType<Warnings['values']>;
  stats: Record<string, number>;
  patches: Map<string, NodeMeta>;
  frameworks: Map<string, string[]>;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const APP_FILES = ['page', 'layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'default', 'route'];
const langOf = (f: string) => (TS_EXT.test(f) ? 'ts' : 'js');
const modId = (f: string) => `${langOf(f)}:module:${f}`;
const fileOfId = (id: string) => id.split(':').slice(2).join(':').split('#')[0]!;
const suffixOf = (id: string) => id.split(':').slice(2).join(':');

export function joinPath(...parts: (string | null | undefined)[]): string {
  const segs = parts.filter((p): p is string => !!p).flatMap((p) => p.split('/')).filter(Boolean);
  return '/' + segs.join('/');
}

function underPath(full: string, scope: string | null): boolean {
  if (scope === null || scope === '/' || scope === '' || scope === '*') return true;
  const s = joinPath(scope);
  return full === s || full.startsWith(s + '/');
}

/** Next.js middleware matcher (path-to-regexp subset + raw regex groups) → RegExp. */
export function matcherToRegExp(m: string): RegExp | undefined {
  try {
    // `(?:` is a regex group, not a path param, so a ':' right after '?' is left alone
    const s = m
      .replace(/\/(?<!\?):(\w+)\*/g, '(?:/.*)?')
      .replace(/\/(?<!\?):(\w+)\+/g, '/.+')
      .replace(/\/(?<!\?):(\w+)\?/g, '(?:/[^/]+)?')
      .replace(/(?<!\?):(\w+)/g, '[^/]+');
    return new RegExp(`^${s}$`);
  } catch { return undefined; }
}

/** App Router directory segments → URL path, slot and interception flags. */
export function appRouteUrl(segments: string[]): { url: string; slot?: string; intercepting: boolean; private: boolean } {
  const url: string[] = [];
  let slot: string | undefined;
  let intercepting = false;
  for (const seg of segments) {
    if (seg.startsWith('_')) return { url: '', intercepting: false, private: true };
    if (/^\([^)]*\)$/.test(seg) && !/^\(\.{1,3}\)$/.test(seg)) continue; // route group
    if (seg.startsWith('@')) { slot = seg; continue; }
    const m = /^((?:\(\.{1,3}\))+)(.*)$/.exec(seg);
    if (m) {
      intercepting = true;
      for (const mk of m[1]!.match(/\(\.{1,3}\)/g)!) {
        if (mk === '(...)') url.length = 0;
        else if (mk === '(..)') url.pop();
      }
      if (m[2]) url.push(m[2]);
      continue;
    }
    url.push(seg);
  }
  return { url: '/' + url.join('/'), ...(slot ? { slot } : {}), intercepting, private: false };
}

export function enrichFrameworks(root: string, projects: TsProjectInfo[], allFiles: string[], fragments: Record<string, FragmentView>): EnrichResult {
  const nodes: GraphNode[] = [];
  const edges = new EdgeSet();
  const warnings = new Warnings();
  const stats: Record<string, number> = {};
  const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const patches = new Map<string, NodeMeta>();
  const patch = (id: string, m: NodeMeta) => patches.set(id, { ...(patches.get(id) ?? {}), ...m });
  const frameworks = new Map<string, string[]>();
  const nodeById = new Map<string, GraphNode>();
  for (const fr of Object.values(fragments)) for (const n of fr.nodes) nodeById.set(n.id, n);
  const factsOf = (f: string) => fragments[f]?.facts;
  const projectOf = (f: string) => projects.find((p) => p.files.includes(f));
  const deps = (p: TsProjectInfo) => ({ ...(p.pkg?.dependencies ?? {}), ...(p.pkg?.devDependencies ?? {}) });
  const rootDeps = { ...(projects.find((p) => p.root === '.')?.pkg?.dependencies ?? {}) };
  const has = (p: TsProjectInfo, ...names: string[]) => names.some((n) => n in deps(p) || n in rootDeps);

  for (const p of projects) {
    const fw: string[] = [];
    if (has(p, 'next')) fw.push('next');
    if (has(p, 'express')) fw.push('express');
    if (has(p, 'fastify')) fw.push('fastify');
    if (has(p, '@nestjs/core', '@nestjs/common')) fw.push('nest');
    if (has(p, 'prisma', '@prisma/client')) fw.push('prisma');
    frameworks.set(p.root, fw);
  }
  const files = Object.keys(fragments).sort();

  // ================================================================ Express + Fastify
  interface Group { id: string; framework: 'express' | 'fastify'; role: 'app' | 'router' | 'plugin'; file: string; line: number; label: string }
  const groups = new Map<string, Group>();
  for (const f of files) for (const g of factsOf(f)?.groups ?? []) if (!groups.has(g.id)) groups.set(g.id, { ...g, file: f });
  const pluginGroupId = (fnId: string) => `ts:route-group:${suffixOf(fnId)}`;
  const nodeRefToPlugin = (ref: Ref): string | undefined => {
    if (ref.kind === 'node') return pluginGroupId(ref.id);
    if (ref.kind === 'module') { const d = factsOf(ref.file)?.defaultExport; return d ? nodeRefToPlugin(d) ?? (d.kind === 'group' ? d.id : undefined) : undefined; }
    if (ref.kind === 'group') return ref.id;
    return undefined;
  };
  // Fastify plugins: any function registered via .register() becomes a candidate group.
  for (const f of files) for (const r of factsOf(f)?.registers ?? []) {
    const gid = nodeRefToPlugin(r.plugin);
    if (!gid || groups.has(gid)) continue;
    const fnId = r.plugin.kind === 'node' ? r.plugin.id : r.plugin.kind === 'module' && factsOf(r.plugin.file)?.defaultExport?.kind === 'node' ? (factsOf(r.plugin.file)!.defaultExport as { id: string }).id : undefined;
    const fn = fnId ? nodeById.get(fnId) : undefined;
    if (fn?.path) groups.set(gid, { id: gid, framework: 'fastify', role: 'plugin', file: fn.path, line: fn.line ?? 1, label: fn.label });
  }
  const receiverGroup = (r: Ref): string | undefined => (r.kind === 'group' ? r.id : r.kind === 'param' ? pluginGroupId(r.fnId) : undefined);
  const groupOfRef = (r: Ref): string | undefined => {
    if (r.kind === 'group') return r.id;
    if (r.kind === 'module') { const d = factsOf(r.file)?.defaultExport; return d?.kind === 'group' ? d.id : undefined; }
    return undefined;
  };

  interface Entry { pos: number; file: string; line: number }
  interface Mount extends Entry { child: string; prefix: string | null }
  interface Mw extends Entry { path: string | null; ref: Ref }
  interface Hook extends Entry { hook: string; ref: Ref }
  const mounts = new Map<string, Mount[]>();
  const mws = new Map<string, Mw[]>();
  const hooks = new Map<string, Hook[]>();
  const routes = new Map<string, (RouteFact & { file: string })[]>();
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const f of files) {
    const ff = factsOf(f);
    if (!ff) continue;
    for (const u of ff.uses ?? []) {
      const g = receiverGroup(u.receiver);
      if (!g || !groups.has(g)) continue;
      for (const a of u.args) {
        const child = groupOfRef(a);
        if (child && groups.has(child)) add(mounts, g, { child, prefix: u.path, pos: u.pos, file: f, line: u.line });
        else add(mws, g, { path: u.path, ref: a, pos: u.pos, file: f, line: u.line });
      }
    }
    for (const r of ff.registers ?? []) {
      const g = receiverGroup(r.receiver);
      const child = nodeRefToPlugin(r.plugin);
      if (!g || !groups.has(g)) continue;
      if (child && groups.has(child)) add(mounts, g, { child, prefix: r.prefix, pos: r.pos, file: f, line: r.line });
      else { bump('fastify.unresolvedPlugins'); warnings.add('fastify-unresolved-plugin', 'fastify.register() targets that could not be resolved to a plugin function', f); }
    }
    for (const h of ff.hooks ?? []) { const g = receiverGroup(h.receiver); if (g && groups.has(g)) add(hooks, g, { hook: h.hook, ref: h.ref, pos: h.pos, file: f, line: h.line }); }
    for (const r of ff.routes ?? []) { const g = receiverGroup(r.receiver); if (g && groups.has(g)) add(routes, g, { ...r, file: f }); }
  }
  for (const list of [...mounts.values(), ...mws.values(), ...hooks.values()]) list.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pos - b.pos));

  // Contexts: every way a group is reached from a root app, with accumulated prefix and inherited chain.
  interface Ctx { prefix: string; chain: { ref: Ref; file: string; line: number }[] }
  const contexts = new Map<string, Ctx[]>();
  const HOOK_ORDER = ['onRequest', 'preParsing', 'preValidation', 'preHandler'];
  const groupHooks = (g: string) => (hooks.get(g) ?? []).filter((h) => HOOK_ORDER.includes(h.hook)).sort((a, b) => HOOK_ORDER.indexOf(a.hook) - HOOK_ORDER.indexOf(b.hook) || a.pos - b.pos);
  const visit = (g: string, ctx: Ctx, stack: string[]) => {
    if (stack.includes(g) || stack.length > 20) { warnings.add('http-mount-cycle', 'Router/plugin mount cycle (ignored)', groups.get(g)?.file); return; }
    (contexts.get(g) ?? contexts.set(g, []).get(g)!).push(ctx);
    const grp = groups.get(g)!;
    for (const m of mounts.get(g) ?? []) {
      const before = grp.framework === 'express'
        ? (mws.get(g) ?? []).filter((w) => w.pos < m.pos && w.file === m.file && underPath(joinPath(m.prefix), w.path)).map((w) => ({ ref: w.ref, file: w.file, line: w.line }))
        : groupHooks(g).map((h) => ({ ref: h.ref, file: h.file, line: h.line }));
      visit(m.child, { prefix: joinPath(ctx.prefix, m.prefix), chain: [...ctx.chain, ...before] }, [...stack, g]);
    }
  };
  for (const g of [...groups.values()].filter((x) => x.role === 'app').map((x) => x.id).sort()) visit(g, { prefix: '', chain: [] }, []);

  const usedGroups = new Set<string>([...routes.keys(), ...mounts.keys(), ...[...mounts.values()].flat().map((m) => m.child)]);
  for (const gid of [...usedGroups].sort()) {
    const g = groups.get(gid);
    if (!g) continue;
    if (g.role === 'plugin' && !contexts.has(gid)) continue; // registered on something that isn't a fastify app
    nodes.push({
      id: gid, kind: 'route-group', label: `${g.label} (${g.role === 'plugin' ? 'fastify plugin' : `${g.framework} ${g.role}`}, ${posix.basename(g.file)})`,
      parent: modId(g.file), level: 3, lang: langOf(g.file), path: g.file, line: g.line, meta: { framework: g.framework, role: g.role },
    });
    for (const m of mounts.get(gid) ?? []) {
      if (groups.get(m.child)?.role === 'plugin' && !contexts.has(m.child)) continue;
      edges.add('mounts', gid, m.child, { path: m.file, line: m.line }, m.prefix ? { meta: { prefix: m.prefix } } : {});
    }
  }

  const endpointIds = new Map<string, number>();
  const emitEndpoint = (opts: {
    id: string; file: string; line: number; parent: string; framework: string; methods: string[]; pathTemplate: string; fullPath?: string | undefined;
    handler?: Ref | undefined; chain: { ref: Ref; file: string; line: number }[]; label?: string; role?: string; inferredChain?: boolean;
  }) => {
    let id = opts.id;
    const n = (endpointIds.get(id) ?? 0) + 1;
    endpointIds.set(id, n);
    if (n > 1) id = `${id}~${n}`;
    nodes.push({
      id, kind: opts.role === 'page' ? 'route' : 'endpoint', label: opts.label ?? `${opts.methods.join('|')} ${opts.fullPath ?? opts.pathTemplate}`,
      parent: opts.parent, level: 3, lang: langOf(opts.file), path: opts.file, line: opts.line,
      meta: {
        framework: opts.framework, ...(opts.role ? { role: opts.role } : {}),
        http: { methods: opts.methods, pathTemplate: opts.pathTemplate, ...(opts.fullPath !== undefined ? { fullPath: opts.fullPath } : {}) },
      },
    });
    bump(opts.role === 'page' ? `${opts.framework}.pages` : `${opts.framework}.endpoints`);
    if (opts.handler?.kind === 'node') edges.add('handles', id, opts.handler.id, { path: opts.file, line: opts.line });
    else if (opts.handler) { bump('http.unresolvedHandlers'); warnings.add('http-unresolved-handler', 'Route handlers that could not be resolved to a function', opts.file); }
    let order = 0;
    for (const c of opts.chain) {
      if (c.ref.kind === 'node') edges.add('middleware-chain', id, c.ref.id, { path: c.file, line: c.line }, { meta: { order: order++ }, ...(opts.inferredChain ? { inferred: true } : {}) });
      else { order++; bump(c.ref.kind === 'external' ? 'http.externalMiddleware' : 'http.unresolvedMiddleware'); }
    }
    return id;
  };

  for (const gid of [...routes.keys()].sort()) {
    const g = groups.get(gid)!;
    if (g.role === 'plugin' && !contexts.has(gid)) continue;
    const ctxs = contexts.get(gid) ?? [];
    if (ctxs.length !== 1) warnings.add(ctxs.length ? 'http-multi-mount' : 'http-unmounted-router',
      ctxs.length ? 'Routers mounted at more than one prefix (fullPath left unset)' : 'Routers never mounted on an app (fullPath unknown)', g.file);
    for (const r of routes.get(gid)!.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pos - b.pos))) {
      if (r.path === null) { bump('http.dynamicPaths'); warnings.add('http-dynamic-path', 'Routes with a non-literal path (not listed)', r.file); continue; }
      const ctx = ctxs.length === 1 ? ctxs[0]! : undefined;
      const own = g.framework === 'express'
        ? (mws.get(gid) ?? []).filter((w) => w.pos < r.pos && w.file === r.file && underPath(joinPath(r.path), w.path)).map((w) => ({ ref: w.ref, file: w.file, line: w.line }))
        : groupHooks(gid).map((h) => ({ ref: h.ref, file: h.file, line: h.line }));
      const handlers = r.handlers;
      const chain = [...(ctx?.chain ?? []), ...own, ...r.hooks.map((ref) => ({ ref, file: r.file, line: r.line })), ...handlers.slice(0, -1).map((ref) => ({ ref, file: r.file, line: r.line }))];
      emitEndpoint({
        id: `${langOf(r.file)}:endpoint:${r.file}#${r.methods.join('|')} ${r.path}`, file: r.file, line: r.line, parent: gid, framework: g.framework,
        methods: r.methods, pathTemplate: r.path, fullPath: ctx ? joinPath(ctx.prefix, r.path) : undefined, handler: handlers[handlers.length - 1], chain,
      });
    }
  }

  // ================================================================ NestJS
  for (const p of projects.filter((x) => frameworks.get(x.root)!.includes('nest'))) {
    const pf = p.files.filter((f) => factsOf(f));
    const globals = pf.flatMap((f) => (factsOf(f)!.nestGlobal ?? []).map((g) => ({ ...g, file: f })));
    const prefixes = [...new Set(globals.map((g) => g.prefix).filter((x): x is string => x !== undefined))];
    if (prefixes.length > 1) warnings.add('nest-multiple-global-prefix', 'More than one setGlobalPrefix() literal; global prefix ignored', globals[0]!.file);
    const gPrefix = prefixes.length === 1 ? prefixes[0]! : '';
    const gChain = (k: 'guards' | 'interceptors' | 'pipes') => globals.flatMap((g) => g[k].map((ref) => ({ ref, file: g.file, line: g.line })));
    for (const f of pf) {
      for (const c of factsOf(f)!.nest ?? []) {
        const at = (refs: Ref[], line: number) => refs.map((ref) => ({ ref, file: f, line }));
        if (c.controller) {
          patch(c.classId, { framework: 'nest', role: 'controller' });
          for (const r of c.controller.routes) {
            emitEndpoint({
              id: `${langOf(f)}:endpoint:${suffixOf(r.methodId)}`, file: f, line: r.line, parent: c.classId, framework: 'nest',
              methods: [r.verb], pathTemplate: joinPath(c.controller.prefix, r.path), fullPath: joinPath(gPrefix, c.controller.prefix, r.path),
              handler: { kind: 'node', id: r.methodId },
              chain: [
                ...gChain('guards'), ...at(c.controller.guards, c.line), ...at(r.guards, r.line),
                ...gChain('interceptors'), ...at(c.controller.interceptors, c.line), ...at(r.interceptors, r.line),
                ...gChain('pipes'), ...at(c.controller.pipes, c.line), ...at(r.pipes, r.line),
              ],
            });
          }
        }
        if (c.module) {
          patch(c.classId, { framework: 'nest', role: 'nest-module' });
          for (const ref of [...c.module.imports, ...c.module.controllers, ...c.module.providers]) {
            if (ref.kind === 'node') edges.add('mounts', c.classId, ref.id, { path: f, line: c.line });
            else bump('nest.unresolvedModuleRefs');
          }
        }
        if (c.injectable && !c.controller) patch(c.classId, { framework: 'nest', role: 'provider' });
        for (const inj of c.injects) {
          if (inj.ref.kind === 'node') edges.add('injects', c.classId, inj.ref.id, { path: f, line: inj.line });
          else if (inj.token !== undefined) { bump('nest.tokenInjections'); warnings.add('nest-token-injection', 'Constructor injections by string token (target unknown statically)', f); }
          else bump('nest.externalInjections');
        }
      }
    }
  }

  // ================================================================ Next.js
  for (const p of projects.filter((x) => frameworks.get(x.root)!.includes('next'))) {
    const base = p.root === '.' ? '' : `${p.root}/`;
    const routable = (f: string) => /\.(jsx?|tsx?)$/.test(f) && !isDts(f) && !isTestFile(f) && fragments[f];
    const dirWith = (cands: string[]) => cands.find((d) => p.files.some((f) => f.startsWith(d + '/')));
    const appDir = dirWith([`${base}app`, `${base}src/app`]);
    const pagesDir = dirWith([`${base}pages`, `${base}src/pages`]);
    const pid = `${p.lang}:project:${p.root}`;
    const routeNodes: { id: string; url: string }[] = [];
    const serverSeeds: string[] = [];
    const bothSeeds: string[] = [];
    const exportsOf = (f: string) => fragments[f]!.nodes.filter((n) => n.meta.exported && n.level === 3);
    const defaultOf = (f: string): Ref | undefined => factsOf(f)?.defaultExport;

    if (appDir) {
      const gid = `${p.lang}:route-group:${appDir}`;
      nodes.push({ id: gid, kind: 'route-group', label: 'App Router', parent: pid, level: 1, lang: p.lang, path: appDir, meta: { framework: 'next', role: 'app-router' } });
      const layouts = new Map<string, string>();
      const appFiles: { f: string; dir: string; role: string; url: ReturnType<typeof appRouteUrl> }[] = [];
      for (const f of p.files.filter((x) => x.startsWith(appDir + '/') && routable(x)).sort()) {
        const role = posix.basename(f).replace(/\.(jsx?|tsx?)$/, '');
        if (!APP_FILES.includes(role)) continue;
        const dir = posix.dirname(f);
        const url = appRouteUrl(dir === appDir ? [] : dir.slice(appDir.length + 1).split('/'));
        if (url.private) continue;
        appFiles.push({ f, dir, role, url });
        patch(modId(f), { framework: 'next', role });
        if (role === 'layout') layouts.set(dir, modId(f));
      }
      for (const { f, dir, role, url } of appFiles) {
        // layout tree: nearest layout in this dir (for non-layouts) or any ancestor dir; route handlers don't render in layouts
        let d = role === 'layout' ? posix.dirname(dir) : dir;
        while (role !== 'route' && d.length >= appDir.length) {
          const l = layouts.get(d);
          if (l && l !== modId(f)) { edges.add('route-child', l, modId(f), { path: f, line: 1 }); break; }
          if (d === appDir) break;
          d = posix.dirname(d);
        }
        const label = `${url.url}${url.slot ? ` (${url.slot})` : ''}${url.intercepting ? ' (intercepting)' : ''}`;
        if (role === 'page') {
          const id = emitEndpoint({ id: `${langOf(f)}:route:${f}`, file: f, line: 1, parent: gid, framework: 'next', role: 'page', label, methods: ['GET'], pathTemplate: url.url, fullPath: url.url, handler: defaultOf(f), chain: [] });
          routeNodes.push({ id, url: url.url });
        } else if (role === 'route') {
          for (const n of exportsOf(f).filter((x) => HTTP_METHODS.includes(x.label))) {
            const id = emitEndpoint({ id: `${langOf(f)}:endpoint:${f}#${n.label}`, file: f, line: n.line ?? 1, parent: gid, framework: 'next', methods: [n.label], pathTemplate: url.url, fullPath: url.url, handler: { kind: 'node', id: n.id }, chain: [] });
            routeNodes.push({ id, url: url.url });
          }
        }
        if (!factsOf(f)?.directives?.includes('use client')) serverSeeds.push(f);
      }
    }
    if (pagesDir) {
      const gid = `${p.lang}:route-group:${pagesDir}`;
      nodes.push({ id: gid, kind: 'route-group', label: 'Pages Router', parent: pid, level: 1, lang: p.lang, path: pagesDir, meta: { framework: 'next', role: 'pages-router' } });
      for (const f of p.files.filter((x) => x.startsWith(pagesDir + '/') && routable(x)).sort()) {
        const relp = f.slice(pagesDir.length + 1).replace(/\.(jsx?|tsx?)$/, '');
        const special = { _app: 'app', _document: 'document', _error: 'error' }[relp];
        if (special) { patch(modId(f), { framework: 'next', role: special }); (special === 'document' ? serverSeeds : bothSeeds).push(f); continue; }
        const segs = relp.split('/');
        if (segs[segs.length - 1] === 'index') segs.pop();
        const url = '/' + segs.join('/');
        if (segs[0] === 'api') {
          patch(modId(f), { framework: 'next', role: 'route' });
          const methods = factsOf(f)?.httpMethods ?? ['*'];
          const id = emitEndpoint({ id: `${langOf(f)}:endpoint:${f}#default`, file: f, line: 1, parent: gid, framework: 'next', methods, pathTemplate: url, fullPath: url, handler: defaultOf(f), chain: [] });
          routeNodes.push({ id, url });
          serverSeeds.push(f);
        } else {
          patch(modId(f), { framework: 'next', role: 'page' });
          const id = emitEndpoint({ id: `${langOf(f)}:route:${f}`, file: f, line: 1, parent: gid, framework: 'next', role: 'page', label: url, methods: ['GET'], pathTemplate: url, fullPath: url, handler: defaultOf(f), chain: [] });
          routeNodes.push({ id, url });
          bothSeeds.push(f);
        }
      }
    }
    // middleware.ts (proxy.ts since Next 16) at the project root or src/
    const mwFile = ['middleware', 'proxy'].flatMap((n) => ['', 'src/'].flatMap((s) => ['ts', 'js'].map((e) => `${base}${s}${n}.${e}`))).find((f) => fragments[f]);
    if (mwFile) {
      patch(modId(mwFile), { framework: 'next', role: 'middleware', runtime: factsOf(mwFile)?.runtime === 'nodejs' ? 'server' : 'edge' });
      const fn = exportsOf(mwFile).find((n) => n.label === 'middleware' || n.label === 'proxy') ?? (defaultOf(mwFile)?.kind === 'node' ? nodeById.get((defaultOf(mwFile) as { id: string }).id) : undefined);
      const matcher = factsOf(mwFile)?.matcher;
      if (matcher === 'dynamic') warnings.add('next-middleware-matcher-dynamic', 'Middleware matcher is not a literal; applied to all routes (inferred)', mwFile);
      const regs = Array.isArray(matcher) ? matcher.map((m) => [m, matcherToRegExp(m)] as const) : [];
      for (const [m, re] of regs) if (!re) warnings.add('next-middleware-matcher-unparsed', `Middleware matcher "${m}" could not be converted (ignored)`, mwFile);
      if (fn) {
        for (const r of routeNodes) {
          const applies = !Array.isArray(matcher) || regs.some(([, re]) => re?.test(r.url));
          if (applies) edges.add('middleware-chain', r.id, fn.id, { path: mwFile, line: fn.line ?? 1 }, { meta: { order: 0 }, ...(matcher ? { inferred: true } : {}) });
        }
      }
    }

    // runtime propagation over imports (client boundary at 'use client', server-action boundary at 'use server')
    const out = new Map<string, string[]>();
    for (const f of p.files) for (const e of fragments[f]?.edges ?? []) if (e.kind === 'imports' || e.kind === 'dynamic-imports') (out.get(f) ?? out.set(f, []).get(f)!).push(fileOfId(e.target));
    const dir = (f: string) => factsOf(f)?.directives ?? [];
    const bfs = (seeds: string[], stop: (f: string) => boolean) => {
      const seen = new Set<string>();
      const q = [...seeds];
      while (q.length) {
        const f = q.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        for (const t of out.get(f) ?? []) if (!seen.has(t) && !stop(t)) q.push(t);
      }
      return seen;
    };
    const clientSeeds = p.files.filter((f) => dir(f).includes('use client'));
    const client = bfs([...clientSeeds, ...bothSeeds], (f) => dir(f).includes('use server'));
    const server = bfs([...serverSeeds, ...bothSeeds, ...(mwFile ? [mwFile] : [])], (f) => dir(f).includes('use client'));
    for (const f of p.files) {
      if (!fragments[f] || f === mwFile) continue;
      const rt = factsOf(f)?.runtime === 'edge' ? 'edge' : dir(f).includes('use server') ? 'server' : client.has(f) && server.has(f) ? 'shared' : client.has(f) ? 'client' : server.has(f) ? 'server' : undefined;
      if (rt) patch(modId(f), { runtime: rt });
    }
    // server actions
    const actions = new Set<string>();
    for (const f of p.files) {
      if (!fragments[f]) continue;
      for (const n of fragments[f]!.nodes) if (n.meta.role === 'server-action') actions.add(n.id);
      if (dir(f).includes('use server')) for (const n of exportsOf(f).filter((x) => x.kind === 'function')) { actions.add(n.id); patch(n.id, { role: 'server-action' }); }
    }
    const runtimeOf = (f: string) => patches.get(modId(f))?.runtime;
    for (const f of p.files) {
      for (const a of factsOf(f)?.jsxActions ?? []) if (actions.has(a.target)) edges.add('invokes-server-action', a.src, a.target, { path: f, line: a.line });
      if (runtimeOf(f) !== 'client' && runtimeOf(f) !== 'shared') continue;
      for (const e of fragments[f]?.edges ?? []) if ((e.kind === 'calls' || e.kind === 'uses-hook') && actions.has(e.target)) edges.add('invokes-server-action', e.source, e.target, e.evidence?.[0]);
    }
  }

  // ================================================================ Prisma
  const delegates = new Map<string, { id: string; file: string }[]>();
  for (const f of allFiles.filter((x) => x.endsWith('.prisma')).sort()) {
    let text: string;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const models = parsePrismaSchema(text);
    for (const m of models) {
      const id = `config:model:${f}#${m.name}`;
      nodes.push({
        id, kind: 'model', label: m.name, parent: null, level: 3, lang: 'config', path: f, line: m.line, endLine: m.endLine,
        meta: { framework: 'prisma', role: 'model', fields: m.fields.map((x) => ({ name: x.name, type: x.type, ...(x.relation ? { relation: x.relation } : {}) })), ...(m.doc ? { doc: m.doc } : {}) },
      });
      for (const fld of m.fields) if (fld.target) edges.add('model-relation', id, `config:model:${f}#${fld.target}`, { path: f, line: fld.line });
      const k = m.name.charAt(0).toLowerCase() + m.name.slice(1);
      (delegates.get(k) ?? delegates.set(k, []).get(k)!).push({ id, file: f });
    }
    bump('prisma.models', models.length);
  }
  if (delegates.size) {
    for (const f of files) {
      for (const u of factsOf(f)?.prisma ?? []) {
        const cands = delegates.get(u.delegate);
        if (!cands) continue;
        const proj = projectOf(f);
        const pick = cands.length === 1 ? cands[0]! : cands.find((c) => proj && (proj.root === '.' || c.file.startsWith(proj.root + '/'))) ?? cands[0]!;
        if (cands.length > 1) warnings.add('prisma-ambiguous-model', 'Prisma delegate matches models in several schemas (picked the closest)', f);
        edges.add(u.write ? 'writes-model' : 'reads-model', u.src, pick.id, { path: f, line: u.line }, u.confident ? {} : { inferred: true });
        bump(u.confident ? 'prisma.uses' : 'prisma.usesInferred');
      }
    }
  }
  // A framework is listed only with code evidence, not just because package.json declares it.
  const evidence = new Map<string, Set<string>>();
  const saw = (f: string | undefined, fw: string) => { const r = f ? projectOf(f)?.root : undefined; if (r !== undefined) (evidence.get(r) ?? evidence.set(r, new Set()).get(r)!).add(fw); };
  for (const g of groups.values()) if (g.role !== 'plugin' || contexts.has(g.id)) saw(g.file, g.framework);
  for (const n of nodes) if (n.meta.framework === 'next' || n.meta.framework === 'nest') saw(n.path, n.meta.framework);
  for (const [id, m] of patches) if (m.framework) saw(fileOfId(id), m.framework);
  for (const f of files) if (factsOf(f)?.prisma?.some((u) => delegates.has(u.delegate))) saw(f, 'prisma');
  for (const n of nodes) if (n.kind === 'model' && n.path) { const r = projects.find((p) => p.root === '.' || n.path!.startsWith(p.root + '/')); if (r) (evidence.get(r.root) ?? evidence.set(r.root, new Set()).get(r.root)!).add('prisma'); }
  for (const [r, fw] of frameworks) {
    const ev = evidence.get(r) ?? new Set();
    const declaredOnly = fw.filter((x) => !ev.has(x));
    if (declaredOnly.length) bump('frameworks.declaredButUnused', declaredOnly.length);
    frameworks.set(r, fw.filter((x) => ev.has(x)));
  }
  return { nodes, edges: edges.values(), warnings: warnings.values(), stats, patches, frameworks };
}
