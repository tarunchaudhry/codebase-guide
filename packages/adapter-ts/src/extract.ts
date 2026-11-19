import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Node, Project, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import {
  EdgeSet, Warnings, OUTPUT_DIR, VERSION, readJsonFile, sha1, toPosix, writeFileEnsured,
  type Evidence, type GraphNode, type NodeKind, type PartialGraph, type Warning,
} from '@codebase-guide/core';
import { enrichFrameworks } from './frameworks/enrich.ts';
import { collectFacts, decoratorsMeta, hasDirective, inlineHandlerArgs, type FileFacts } from './frameworks/facts.ts';
import { detectTsProjects, isDts, isTestFile, TS_EXT, type TsProjectInfo, type WorkspaceInfo, type WorkspacePackage } from './detect.ts';

/** Bump when extraction output changes shape, so stale caches are discarded. */
export const EXTRACTOR_VERSION = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ASSET_EXT = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|html|txt|woff2?|ttf|otf|ya?ml|graphql|gql|wasm)(\?.*)?$/;
const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

interface FileFragment {
  hash: string;
  nodes: GraphNode[];
  edges: ReturnType<EdgeSet['values']>;
  warnings: Warning[];
  stats: Record<string, number>;
  /** Internal files this file imports (repo-relative), for dependent invalidation. */
  imports: string[];
  reexports: boolean;
  /** Had an internal-looking import that didn't resolve; re-extract when the file set changes. */
  unresolved: boolean;
  /** Framework facts (routes, mounts, decorators, directives…) for the AST-free framework pass. */
  facts?: FileFacts;
}

interface CacheFile { key: string; fileList: string; files: Record<string, FileFragment> }

export interface TsExtractResult {
  graph: PartialGraph;
  run: { parsed: string[]; cached: number; projects: number };
}

export interface SymbolDecl { id: string; kind: NodeKind; name: string; node: Node; body: Node; exported: boolean; role?: string }

// ---------- helpers ----------

const langOf = (rel: string): 'ts' | 'js' => (TS_EXT.test(rel) ? 'ts' : 'js');
const oneLine = (s: string, max = 240) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const isPascal = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s);
const nonBlankLines = (text: string) => text.split('\n').filter((l) => l.trim()).length;

function complexity(node: Node): number {
  let c = 1;
  node.forEachDescendant((d) => {
    switch (d.getKind()) {
      case SyntaxKind.IfStatement: case SyntaxKind.ConditionalExpression: case SyntaxKind.CaseClause:
      case SyntaxKind.ForStatement: case SyntaxKind.ForInStatement: case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement: case SyntaxKind.DoStatement: case SyntaxKind.CatchClause:
        c++; break;
      case SyntaxKind.BinaryExpression: {
        const op = (d.compilerNode as ts.BinaryExpression).operatorToken.kind;
        if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) c++;
      }
    }
  });
  return c;
}

function jsDocOf(node: Node): string | undefined {
  let target: Node | undefined = node;
  if (Node.isVariableDeclaration(node)) target = node.getVariableStatement();
  else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const p = node.getParent();
    target = Node.isBinaryExpression(p) ? p.getParent() : p; // exports.x = function () {}
  }
  if (target && Node.isExpressionStatement(target)) {
    const docs = (target.compilerNode as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
    const text = docs?.map((d) => (typeof d.comment === 'string' ? d.comment : '')).join('\n').trim();
    return text ? oneLine(text, 500) : undefined;
  }
  if (!target || !Node.isJSDocable(target)) return undefined;
  const text = target.getJsDocs().map((d) => d.getDescription().trim()).filter(Boolean).join('\n');
  return text ? oneLine(text, 500) : undefined;
}

function signatureOf(name: string, fn: Node): string | undefined {
  if (!(Node.isFunctionLikeDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) return undefined;
  const params = fn.getParameters().map((p) => oneLine(p.getText(), 120)).join(', ');
  const ret = fn.getReturnTypeNode();
  const asyncKw = Node.isAsyncable(fn) && fn.isAsync() ? 'async ' : '';
  return oneLine(`${asyncKw}${name}(${params})${ret ? `: ${ret.getText()}` : ''}`, 300);
}

function hasJsx(n: Node): boolean {
  return n.getFirstDescendant((d) => Node.isJsxElement(d) || Node.isJsxSelfClosingElement(d) || Node.isJsxFragment(d)) !== undefined;
}

/** `memo(() => …)`, `asyncHandler(async (req, res) => …)`: the wrapped function is the body. */
function unwrapFn(init: Node | undefined): Node | undefined {
  if (!init) return undefined;
  let e: Node = init;
  while (Node.isParenthesizedExpression(e) || Node.isAsExpression(e) || Node.isSatisfiesExpression(e)) e = e.getExpression();
  if (Node.isArrowFunction(e) || Node.isFunctionExpression(e)) return e;
  if (Node.isCallExpression(e)) return e.getArguments().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
  return undefined;
}

const isProcessEnv = (n: Node) => { const t = n.getText(); return t === 'process.env' || t === 'import.meta.env'; };

// ---------- workspace path mapping ----------

const CONDITIONS = ['source', 'types', 'import', 'module', 'require', 'node', 'default'];
function pickExport(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const r = pickExport(x); if (r) return r; } return undefined; }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const c of CONDITIONS) if (c in o) { const r = pickExport(o[c]); if (r) return r; }
  }
  return undefined;
}

/** Map a package export target (often dist/*.js or *.d.ts) back to a source file we parsed. */
function exportTargetToSource(pkg: WorkspacePackage, target: string | undefined, fileSet: Set<string>): string | undefined {
  const base = (p: string) => posix.normalize(pkg.dir === '.' ? p : `${pkg.dir}/${p}`).replace(/^\.\//, '');
  const cands: string[] = [];
  if (target) {
    const t = base(target);
    const stem = t.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, '');
    for (const s of [stem, stem.replace(/(^|\/)(dist|build|lib|out|esm|cjs)\//, '$1src/')]) {
      cands.push(t, ...CODE_EXTS.map((e) => s + e));
    }
  }
  for (const s of ['src/index', 'index']) cands.push(...CODE_EXTS.map((e) => base(s + e)));
  return cands.find((c) => fileSet.has(c) && !isDts(c));
}

function workspacePaths(root: string, ws: WorkspaceInfo, fileSet: Set<string>): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of ws.packages) {
    const exp = pkg.pkg.exports;
    const subs = exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
      ? Object.keys(exp as object).filter((k) => !k.includes('*')) : ['.'];
    for (const sub of subs.sort()) {
      const target = sub === '.' && !(exp && typeof exp === 'object' && '.' in (exp as object))
        ? pickExport(exp) ?? pkg.pkg.types ?? pkg.pkg.typings ?? pkg.pkg.module ?? pkg.pkg.main
        : pickExport((exp as Record<string, unknown>)[sub]);
      const src = exportTargetToSource(pkg, target, fileSet);
      if (src) paths[sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`] = [join(root, src)];
    }
    paths[`${pkg.name}/*`] = [join(root, pkg.dir, 'src', '*'), join(root, pkg.dir, '*')];
  }
  return paths;
}

// ---------- extractor ----------

export async function extractTs(root: string, allFiles: string[], opts: { useCache?: boolean; apiClients?: string[] | undefined } = {}): Promise<TsExtractResult> {
  root = realpathSync(root);
  const { projects, workspace } = detectTsProjects(root, allFiles);
  const fileSet = new Set(allFiles);
  const wsPaths = workspacePaths(root, workspace, fileSet);
  const cachePath = join(root, OUTPUT_DIR, 'cache', 'ts-extract.json');
  const tsconfigText = projects.map((p) => (p.tsconfig ? p.tsconfig + '\n' + readFileSync(join(root, p.tsconfig), 'utf8') : '')).join('\n');
  const key = sha1(JSON.stringify([VERSION, EXTRACTOR_VERSION, tsconfigText, wsPaths, projects.map((p) => p.root), opts.apiClients ?? []]));
  const sourceFiles = projects.flatMap((p) => p.files.filter((f) => !isDts(f)));
  const fileListHash = sha1(sourceFiles.join('\n'));
  const prev = opts.useCache === false ? undefined : readJsonFile<CacheFile>(cachePath);
  const prevFiles = prev?.key === key ? prev.files : {};

  // Content hashes and dirty set (changed + dependents through imports/re-exports).
  const hashes = new Map<string, string>();
  for (const f of sourceFiles) hashes.set(f, sha1(readFileSync(join(root, f))));
  const dirty = new Set<string>(sourceFiles.filter((f) => prevFiles[f]?.hash !== hashes.get(f)));
  const deleted = Object.keys(prevFiles).filter((f) => !hashes.has(f));
  const fileSetChanged = prev?.fileList !== fileListHash;
  const importers = new Map<string, string[]>();
  for (const [f, frag] of Object.entries(prevFiles)) for (const t of frag.imports) (importers.get(t) ?? importers.set(t, []).get(t)!).push(f);
  const work = [...dirty, ...deleted];
  const seen = new Set(work);
  while (work.length) {
    const f = work.pop()!;
    for (const imp of importers.get(f) ?? []) {
      if (!hashes.has(imp)) continue;
      dirty.add(imp);
      if (prevFiles[imp]?.reexports && !seen.has(imp)) { seen.add(imp); work.push(imp); }
    }
  }
  if (fileSetChanged) for (const f of sourceFiles) if (prevFiles[f]?.unresolved) dirty.add(f);

  const fragments: Record<string, FileFragment> = {};
  for (const f of sourceFiles) if (!dirty.has(f)) fragments[f] = prevFiles[f]!;
  const globalWarnings = new Warnings();

  for (const proj of projects) {
    const todo = proj.files.filter((f) => dirty.has(f));
    if (!todo.length) continue;
    const project = createProject(root, proj, wsPaths, globalWarnings);
    for (const f of proj.files) {
      const abs = join(root, f);
      if (readFileSync(abs).length > MAX_FILE_BYTES) {
        globalWarnings.add('ts-file-too-large', `Skipped files larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, f);
        continue;
      }
      project.addSourceFileAtPath(abs);
    }
    const ctx = new FileContext(root, project, fileSet, opts.apiClients ?? []);
    for (const f of todo) {
      const sf = project.getSourceFile(join(root, f));
      if (!sf) continue;
      try {
        fragments[f] = { hash: hashes.get(f)!, ...ctx.extractFile(sf, f, proj) };
      } catch (err) {
        globalWarnings.add('ts-file-failed', 'Files that failed to extract (skipped)', f);
        void err;
      }
    }
  }

  writeFileEnsured(cachePath, JSON.stringify({ key, fileList: fileListHash, files: fragments } satisfies CacheFile));

  // Structural nodes: workspace → project → module-group(s) → module.
  const nodes: GraphNode[] = [];
  const edges = new EdgeSet();
  const warnings = new Warnings();
  warnings.addAll(globalWarnings.values());
  const stats: Record<string, number> = {};
  const wsId = workspace.tool ? 'config:workspace:.' : null;
  if (wsId) nodes.push({ id: wsId, kind: 'workspace', label: readJsonFile<{ name?: string }>(join(root, 'package.json'))?.name ?? posix.basename(root), parent: null, level: 0, lang: 'config', path: '.', meta: { framework: workspace.tool + (workspace.turbo ? '+turbo' : '') } });
  for (const proj of projects) {
    const pid = `${proj.lang}:project:${proj.root}`;
    nodes.push({ id: pid, kind: 'project', label: proj.name, parent: wsId, level: 0, lang: proj.lang, path: proj.root, meta: {} });
    const groups = new Set<string>();
    for (const f of proj.files) {
      if (isDts(f)) continue;
      let d = posix.dirname(f);
      if (d === '' ) d = '.';
      while (!groups.has(d)) {
        groups.add(d);
        if (d === proj.root) break;
        const up = posix.dirname(d);
        d = up === '' ? '.' : up;
      }
    }
    for (const g of groups) {
      const parentDir = g === proj.root ? null : (posix.dirname(g) === '' ? '.' : posix.dirname(g));
      nodes.push({
        id: `${proj.lang}:module-group:${g}`, kind: 'module-group', label: g === proj.root ? proj.name : posix.basename(g),
        parent: parentDir === null ? pid : `${proj.lang}:module-group:${parentDir}`, level: 1, lang: proj.lang, path: g, meta: {},
      });
    }
  }
  // package.json scripts → script nodes (run-locally facts with a source line), for every package.json incl. the root.
  const projectIdOfDir = (d: string) => {
    const p = projects.find((x) => x.root === d);
    return p ? `${p.lang}:project:${p.root}` : null;
  };
  for (const pkgRel of allFiles.filter((f) => f === 'package.json' || f.endsWith('/package.json'))) {
    const dir = posix.dirname(pkgRel) === '' ? '.' : posix.dirname(pkgRel);
    const text = readFileSync(join(root, pkgRel), 'utf8');
    let scripts: Record<string, string> | undefined;
    try { scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts; } catch {
      warnings.add('ts-package-json-invalid', 'package.json files that are not valid JSON', pkgRel);
    }
    const lines = text.split('\n');
    for (const [name, cmd] of Object.entries(scripts ?? {})) {
      if (typeof cmd !== 'string') continue;
      const idx = lines.findIndex((l) => l.includes(`${JSON.stringify(name)}:`));
      nodes.push({
        id: `config:script:${pkgRel}#${name}`, kind: 'script', label: name, parent: projectIdOfDir(dir) ?? wsId, level: 3, lang: 'config',
        path: pkgRel, ...(idx >= 0 ? { line: idx + 1 } : {}), meta: { signature: cmd, role: 'npm-script' },
      });
    }
  }
  const fw = enrichFrameworks(root, projects, allFiles, fragments);
  const patchNode = (n: GraphNode): GraphNode => { const m = fw.patches.get(n.id); return m ? { ...n, meta: { ...n.meta, ...m } } : n; };
  const parts: PartialGraph[] = [{ nodes: nodes.map(patchNode), edges: edges.values(), warnings: warnings.values(), stats }];
  for (const f of Object.keys(fragments).sort()) {
    const fr = fragments[f]!;
    parts.push({ nodes: fr.nodes.map(patchNode), edges: fr.edges, warnings: fr.warnings, stats: fr.stats });
  }
  parts.push({ nodes: fw.nodes, edges: fw.edges, warnings: fw.warnings, stats: fw.stats });
  const projectsOut = projects.map((p) => ({ id: `${p.lang}:project:${p.root}`, lang: p.lang, frameworks: fw.frameworks.get(p.root) ?? [], root: p.root }));
  const outbound = Object.keys(fragments).sort().flatMap((f) => (fragments[f]!.facts?.http ?? []).map((h) => ({ ...h, file: f })));
  const merged: PartialGraph = { projects: projectsOut, outbound, nodes: parts.flatMap((p) => p.nodes), edges: parts.flatMap((p) => p.edges), warnings: parts.flatMap((p) => p.warnings), stats: {} };
  for (const p of parts) for (const [k, v] of Object.entries(p.stats ?? {})) merged.stats![k] = (merged.stats![k] ?? 0) + v;
  return { graph: merged, run: { parsed: [...dirty].filter((f) => hashes.has(f)).sort(), cached: sourceFiles.length - dirty.size, projects: projects.length } };
}

function createProject(root: string, proj: TsProjectInfo, wsPaths: Record<string, string[]>, warnings: Warnings): Project {
  const synthetic: ts.CompilerOptions = {
    allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, esModuleInterop: true, resolveJsonModule: true, noEmit: true, skipLibCheck: true,
  };
  let project: Project | undefined;
  if (proj.tsconfig) {
    try {
      project = new Project({ tsConfigFilePath: join(root, proj.tsconfig), skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
    } catch {
      warnings.add('ts-tsconfig-unreadable', 'tsconfig could not be parsed; used a synthetic allowJs config', proj.tsconfig);
    }
  }
  project ??= new Project({ compilerOptions: synthetic, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  const opts = project.getCompilerOptions();
  project.compilerOptions.set({ allowJs: true, noEmit: true, skipLibCheck: true, paths: { ...wsPaths, ...(opts.paths ?? {}) } });
  return project;
}

export class FileContext {
  private decls = new Map<string, { list: SymbolDecl[]; byNode: Map<ts.Node, string> }>();
  private resolutionCache: ts.ModuleResolutionCache;
  private root: string;
  private project: Project;
  private fileSet: Set<string>;
  readonly apiClients: string[];
  constructor(root: string, project: Project, fileSet: Set<string>, apiClients: string[] = []) {
    this.root = root; this.project = project; this.fileSet = fileSet; this.apiClients = apiClients;
    this.resolutionCache = ts.createModuleResolutionCache(root, (s) => s, project.getCompilerOptions());
  }

  rel(abs: string): string | undefined {
    const r = toPosix(abs).startsWith(toPosix(this.root) + '/') ? toPosix(abs).slice(toPosix(this.root).length + 1) : undefined;
    return r && this.fileSet.has(r) && !isDts(r) ? r : undefined;
  }

  /** Symbol nodes of a file, with a lookup from declaration (compiler) nodes to node ids. */
  declsOf(sf: SourceFile): { list: SymbolDecl[]; byNode: Map<ts.Node, string> } | undefined {
    const rel = this.rel(sf.getFilePath());
    if (!rel) return undefined;
    const memo = this.decls.get(rel);
    if (memo) return memo;
    const lang = langOf(rel);
    const jsxFile = /\.[jt]sx$/.test(rel);
    const list: SymbolDecl[] = [];
    const byNode = new Map<ts.Node, string>();
    const used = new Map<string, number>();
    const exportedDecls = new Set<ts.Node>();
    try { for (const ds of sf.getExportedDeclarations().values()) for (const d of ds) exportedDecls.add(d.compilerNode); } catch { /* checker failure: fall back to keywords */ }
    const qual = (name: string) => { const n = (used.get(name) ?? 0) + 1; used.set(name, n); return n === 1 ? name : `${name}~${n}`; };
    const add = (kind: NodeKind, name: string, node: Node, body: Node, exported: boolean, aliases: Node[] = [], role?: string) => {
      const q = qual(name);
      const id = `${lang}:${kind}:${rel}#${q}`;
      list.push({ id, kind, name: q, node, body, exported: exported || exportedDecls.has(node.compilerNode), ...(role ? { role } : {}) });
      for (const n of [node, body, ...aliases]) byNode.set(n.compilerNode, id);
      return id;
    };
    const fnKind = (name: string, body: Node): NodeKind => (jsxFile && isPascal(name) && hasJsx(body) ? 'component' : 'function');
    const addClass = (cls: Node, name: string, exported: boolean) => {
      if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) return;
      const ext = cls.getExtends()?.getExpression().getText() ?? '';
      const isComp = /(^|\.)(Pure)?Component$/.test(ext);
      add(isComp ? 'component' : 'class', name, cls, cls, exported);
      for (const m of cls.getMembers()) {
        let mName: string | undefined;
        let body: Node | undefined;
        if (Node.isMethodDeclaration(m) || Node.isGetAccessorDeclaration(m) || Node.isSetAccessorDeclaration(m)) { mName = m.getName(); body = m; }
        else if (Node.isConstructorDeclaration(m)) { mName = 'constructor'; body = m; }
        else if (Node.isPropertyDeclaration(m)) { const fn = unwrapFn(m.getInitializer()); if (fn) { mName = m.getName(); body = fn; } }
        if (mName && body && !isComp) add('method', `${name}.${mName}`, m, body, exported);
      }
    };
    for (const st of sf.getStatements()) {
      if (Node.isFunctionDeclaration(st)) {
        const name = st.getName() ?? 'default';
        add(fnKind(name, st), name, st, st, st.isExported());
      } else if (Node.isVariableStatement(st)) {
        for (const d of st.getDeclarations()) {
          const fn = unwrapFn(d.getInitializer());
          const nameNode = d.getNameNode();
          if (fn && Node.isIdentifier(nameNode)) add(fnKind(d.getName(), fn), d.getName(), d, fn, st.isExported());
          else if (Node.isClassExpression(d.getInitializer())) addClass(d.getInitializer()!, d.getName(), st.isExported());
        }
      } else if (Node.isClassDeclaration(st)) {
        addClass(st, st.getName() ?? 'default', st.isExported());
      } else if (Node.isExportAssignment(st)) {
        const e = st.getExpression();
        const fn = unwrapFn(e);
        if (fn) add(fnKind('default', fn), Node.isFunctionExpression(fn) && fn.getName() ? fn.getName()! : 'default', fn, fn, true, [st]);
        else if (Node.isClassExpression(e)) addClass(e, e.getName() ?? 'default', true);
      } else if (Node.isExpressionStatement(st)) {
        // CommonJS: exports.x = fn, module.exports.x = fn, module.exports = fn | { a: fn, b() {} }
        const e = st.getExpression();
        if (!Node.isBinaryExpression(e) || e.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        const left = e.getLeft().getText();
        const right = e.getRight();
        const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
        const fn = unwrapFn(right);
        if (m && fn) add(fnKind(m[1]!, fn), m[1]!, e, fn, true, [e.getLeft()]);
        else if (left === 'module.exports' && fn) add(fnKind('default', fn), Node.isFunctionExpression(fn) && fn.getName() ? fn.getName()! : 'default', e, fn, true, [e.getLeft()]);
        else if (left === 'module.exports' && Node.isClassExpression(right)) addClass(right, right.getName() ?? 'default', true);
        else if (left === 'module.exports' && Node.isObjectLiteralExpression(right)) {
          for (const p of right.getProperties()) {
            if (Node.isPropertyAssignment(p)) { const f = unwrapFn(p.getInitializer()); if (f) add(fnKind(p.getName(), f), p.getName(), p, f, true); }
            else if (Node.isMethodDeclaration(p)) add('function', p.getName(), p, p, true);
          }
        }
      }
    }
    // module.exports = { foo, bar } shorthand marks top-level functions as exported.
    for (const st of sf.getStatements()) {
      if (!Node.isExpressionStatement(st)) continue;
      const e = st.getExpression();
      if (Node.isBinaryExpression(e) && e.getLeft().getText() === 'module.exports' && Node.isObjectLiteralExpression(e.getRight())) {
        for (const p of e.getRight().asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties()) {
          if (!Node.isShorthandPropertyAssignment(p)) continue;
          const d = list.find((x) => x.name === p.getName());
          if (d) { d.exported = true; byNode.set(p.compilerNode, d.id); }
        }
      }
    }
    // Inline route handlers / middleware / plugins and nested 'use server' actions become anonymous symbol nodes,
    // so calls inside them are attributed to them rather than to the module.
    sf.forEachDescendant((n) => {
      if (Node.isCallExpression(n)) {
        for (const a of inlineHandlerArgs(n)) if (!byNode.has(a.fn.compilerNode)) add('function', a.name, a.fn, a.fn, false, [], a.role);
      } else if ((Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n)) && !byNode.has(n.compilerNode) && hasDirective(n, 'use server')) {
        const name = Node.isFunctionDeclaration(n) || Node.isFunctionExpression(n) ? n.getName() : undefined;
        const v = n.getParent();
        add('function', name ?? (Node.isVariableDeclaration(v) ? v.getName() : 'action'), n, n, false, [], 'server-action');
      }
    });
    const res = { list, byNode };
    this.decls.set(rel, res);
    return res;
  }

  /** Map a declaration to our node id: 'external' outside the repo, undefined if internal but not a symbol node. */
  idOfDecl(decl: Node): string | 'external' | undefined {
    const sf = decl.getSourceFile();
    const d = this.declsOf(sf);
    if (!d) return 'external';
    for (const n of [decl, decl.getParent()]) {
      const id = n && d.byNode.get(n.compilerNode);
      if (id) return id;
    }
    return undefined;
  }

  resolveCallee(expr: Node): string | 'external' | 'unresolved' | 'non-symbol' {
    const target = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
    let sym = target.getSymbol();
    if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    let sawInternal = false;
    for (const decl of sym?.getDeclarations() ?? []) {
      let dn: Node = decl;
      if (Node.isShorthandPropertyAssignment(dn)) {
        const vs = dn.getValueSymbol();
        const vd = (vs?.isAlias() ? vs.getAliasedSymbol() : vs)?.getDeclarations()[0];
        if (vd) dn = vd;
      }
      const id = this.idOfDecl(dn);
      if (id && id !== 'external') return id;
      if (id === undefined) sawInternal = true;
    }
    if (sym && !sawInternal && sym.getDeclarations().length) return 'external';
    // Fallback: the callee's type symbol (covers destructured require, re-assigned functions).
    const tsym = expr.getType().getSymbol();
    for (const decl of tsym?.getDeclarations() ?? []) {
      const id = this.idOfDecl(decl);
      if (id && id !== 'external') return id;
      if (id === undefined) sawInternal = true;
    }
    if (sawInternal) return 'non-symbol';
    if (sym || tsym) return 'external';
    return this.rootIsExternalImport(expr) ? 'external' : 'unresolved';
  }

  /** `React.forwardRef`, `z.string`, `toast.error`: the leftmost identifier is imported from a package (types may be missing). */
  private rootIsExternalImport(expr: Node): boolean {
    let e: Node = expr;
    while (Node.isPropertyAccessExpression(e) || Node.isCallExpression(e) || Node.isNonNullExpression(e) || Node.isParenthesizedExpression(e)) e = e.getExpression();
    if (!Node.isIdentifier(e)) return false;
    const decl = e.getSymbol()?.getDeclarations()[0];
    const imp = decl?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (imp) return this.resolveSpecifier(imp.getModuleSpecifierValue(), imp.getSourceFile().getFilePath()) === 'external';
    // const x = require('pkg')
    const v = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
    if (v && Node.isCallExpression(v) && v.getExpression().getText() === 'require') {
      const a = v.getArguments()[0];
      if (a && Node.isStringLiteral(a)) return this.resolveSpecifier(a.getLiteralText(), v.getSourceFile().getFilePath()) === 'external';
    }
    return false;
  }

  resolveSpecifier(spec: string, fromAbs: string): string | 'external' | 'asset' | 'unresolved' {
    if (ASSET_EXT.test(spec)) return 'asset';
    const opts = this.project.getCompilerOptions();
    const r = ts.resolveModuleName(spec, fromAbs, opts, ts.sys, this.resolutionCache).resolvedModule;
    if (r) {
      let p = r.resolvedFileName;
      try { p = realpathSync(p); } catch { /* keep */ }
      const rel = this.rel(p);
      if (rel) return rel;
      if (!CODE_EXTS.some((e) => p.endsWith(e))) return 'asset';
    }
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = toPosix(spec.startsWith('/') ? join(this.root, spec) : join(posix.dirname(toPosix(fromAbs)), spec));
      const stem = base.replace(/\.[cm]?jsx?$/, '');
      for (const c of [base, ...CODE_EXTS.map((e) => stem + e), ...CODE_EXTS.map((e) => `${base}/index${e}`)]) {
        const rel = this.rel(c);
        if (rel) return rel;
      }
      return 'unresolved';
    }
    if (r && !r.isExternalLibraryImport) return 'unresolved';
    // Aliases like @/x, ~/x, #x that didn't resolve are internal and unresolved; bare names are packages.
    if (/^(@\/|~\/|#)/.test(spec)) return 'unresolved';
    return 'external';
  }

  extractFile(sf: SourceFile, rel: string, proj: TsProjectInfo): Omit<FileFragment, 'hash'> {
    const lang = langOf(rel);
    const modId = `${lang}:module:${rel}`;
    const nodes: GraphNode[] = [];
    const edges = new EdgeSet();
    const warnings = new Warnings();
    const stats: Record<string, number> = {};
    const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
    const imports = new Set<string>();
    let reexports = false;
    let unresolved = false;
    const test = isTestFile(rel);
    const decls = this.declsOf(sf)!;
    const dir = posix.dirname(rel) === '' ? '.' : posix.dirname(rel);
    const text = sf.getFullText();
    const exportCount = decls.list.filter((d) => d.exported && d.kind !== 'method').length;
    let esmExports = 0;
    try { esmExports = sf.getExportedDeclarations().size; } catch { /* ignore */ }
    nodes.push({
      id: modId, kind: 'module', label: posix.basename(rel), parent: `${proj.lang}:module-group:${dir}`, level: 2, lang,
      path: rel, line: 1, endLine: sf.getEndLineNumber(),
      meta: { loc: nonBlankLines(text), exportsCount: Math.max(exportCount, esmExports), ...(test ? { role: 'test' } : {}) },
    });
    for (const d of decls.list) {
      const parent = d.kind === 'method' ? decls.list.find((c) => d.name.startsWith(c.name + '.') && (c.kind === 'class'))?.id ?? modId : modId;
      const sig = signatureOf(d.name.split('.').pop()!, d.body);
      const doc = jsDocOf(d.node);
      nodes.push({
        id: d.id, kind: d.kind, label: d.name, parent, level: 3, lang, path: rel,
        line: d.node.getStartLineNumber(), endLine: d.node.getEndLineNumber(),
        meta: {
          ...(sig ? { signature: sig } : {}), ...(doc ? { doc } : {}),
          loc: d.node.getEndLineNumber() - d.node.getStartLineNumber() + 1,
          ...(d.kind === 'class' ? {} : { complexity: complexity(d.body) }),
          ...(d.exported ? { exported: true } : {}),
          ...(test ? { role: 'test' } : d.role ? { role: d.role } : {}),
          ...decoratorsMeta(d.node),
        },
      });
    }

    const ev = (n: Node): Evidence => ({ path: rel, line: n.getStartLineNumber() });
    const enclosing = (n: Node): string => {
      for (let p: Node | undefined = n.getParent(); p; p = p.getParent()) {
        const id = decls.byNode.get(p.compilerNode);
        if (id && (Node.isFunctionLikeDeclaration(p) || Node.isArrowFunction(p) || Node.isFunctionExpression(p) || Node.isClassDeclaration(p) || Node.isClassExpression(p) || Node.isMethodDeclaration(p))) return id;
      }
      return modId;
    };
    const addImport = (spec: string, n: Node, kind: 'imports' | 'dynamic-imports') => {
      const r = this.resolveSpecifier(spec, sf.getFilePath());
      if (r === 'external') { bump('ts.externalImports'); return; }
      if (r === 'asset') { bump('ts.assetImports'); return; }
      if (r === 'unresolved') {
        unresolved = true;
        warnings.add('ts-unresolved-import', 'Internal-looking imports that could not be resolved', rel);
        return;
      }
      imports.add(r);
      edges.add(kind, modId, `${langOf(r)}:module:${r}`, ev(n));
      if (test && !isTestFile(r)) edges.add('tests', modId, `${langOf(r)}:module:${r}`, ev(n));
    };
    const envRead = (name: string, n: Node) => {
      const id = `config:env-var:${name}`;
      if (!nodes.some((x) => x.id === id)) nodes.push({ id, kind: 'env-var', label: name, parent: null, level: 3, lang: 'config', meta: {} });
      edges.add('reads-env', enclosing(n), id, ev(n));
    };
    const literal = (n: Node | undefined) => (n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n.getLiteralText() : undefined);

    sf.forEachDescendant((n) => {
      if (Node.isImportDeclaration(n)) {
        if (n.isTypeOnly()) { bump('ts.typeOnlyImports'); return; }
        addImport(n.getModuleSpecifierValue(), n, 'imports');
      } else if (Node.isExportDeclaration(n)) {
        const spec = n.getModuleSpecifierValue();
        if (!spec) return;
        if (n.isTypeOnly()) { bump('ts.typeOnlyImports'); return; }
        reexports = true;
        addImport(spec, n, 'imports');
      } else if (Node.isImportEqualsDeclaration(n)) {
        const ref = n.getModuleReference();
        if (Node.isExternalModuleReference(ref)) { const s = literal(ref.getExpression()); if (s) addImport(s, n, 'imports'); }
      } else if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
        const callee = n.getExpression();
        if (Node.isCallExpression(n) && callee.getKind() === SyntaxKind.ImportKeyword) {
          const s = literal(n.getArguments()[0]);
          if (s) addImport(s, n, 'dynamic-imports'); else { bump('ts.dynamicImportsNonLiteral'); warnings.add('ts-dynamic-import', 'import() with a non-literal specifier (not linked)', rel); }
          return;
        }
        if (Node.isCallExpression(n) && Node.isIdentifier(callee) && callee.getText() === 'require') {
          const s = literal(n.getArguments()[0]);
          if (s) addImport(s, n, 'imports'); else warnings.add('ts-dynamic-require', 'require() with a non-literal specifier (not linked)', rel);
          return;
        }
        if (callee.getKind() === SyntaxKind.SuperKeyword) return;
        const r = this.resolveCallee(callee);
        if (r === 'external') { bump('ts.callsExternal'); return; }
        if (r === 'unresolved') { bump('ts.callsUnresolved'); warnings.add('ts-unresolved-call', 'Calls dropped: callee type unknown (untyped JS, or dependencies/types not installed)', rel); return; }
        if (r === 'non-symbol') { bump('ts.callsToNonSymbol'); return; }
        const src = enclosing(n);
        if (src === r) return;
        const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
        edges.add(/^use[A-Z0-9]/.test(name) ? 'uses-hook' : 'calls', src, r, ev(n));
        bump('ts.callsResolved');
      } else if (Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n)) {
        const tag = n.getTagNameNode();
        if (Node.isIdentifier(tag) && /^[a-z]/.test(tag.getText())) return;
        const r = this.resolveCallee(tag);
        if (r !== 'external' && r !== 'unresolved' && r !== 'non-symbol') { const src = enclosing(n); if (src !== r) edges.add('renders', src, r, ev(n)); }
      } else if (Node.isPropertyAccessExpression(n) && isProcessEnv(n.getExpression())) {
        envRead(n.getName(), n);
      } else if (Node.isElementAccessExpression(n) && isProcessEnv(n.getExpression())) {
        const s = literal(n.getArgumentExpression());
        if (s) envRead(s, n); else warnings.add('ts-dynamic-env', 'process.env[...] with a non-literal key (name unknown)', rel);
      } else if (Node.isVariableDeclaration(n) && n.getInitializer() && isProcessEnv(n.getInitializer()!)) {
        const nameNode = n.getNameNode();
        if (Node.isObjectBindingPattern(nameNode)) {
          for (const el of nameNode.getElements()) envRead(el.getPropertyNameNode()?.getText() ?? el.getName(), el);
        }
      }
    });
    const facts = collectFacts(this, sf, rel, decls);
    return {
      nodes, edges: edges.values(), warnings: warnings.values(), stats,
      imports: [...imports].sort(), reexports, unresolved, ...(facts ? { facts } : {}),
    };
  }
}
