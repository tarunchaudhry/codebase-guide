import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPLAIN_DIR, OUTPUT_DIR, VERSION, gitHead, handlerIndex, isSecretPath, patternHints, readJsonFile, recipeCandidates, redact, writeFileEnsured,
  type Analysis, type Explanations, type RepoGraph,
} from '@codebase-guide/core';

export interface RenderOptions { deterministic: boolean; split: boolean; snippets: boolean; open: boolean; editorScheme: 'vscode' | 'cursor' | 'idea'; depth: string }

const SIZE_WARN = 15 * 1024 * 1024;
const SNIPPET_BUDGET = 6 * 1024 * 1024;
const SNIPPET_LINES = 15;

export const LIMITATIONS = [
  'Static analysis misses runtime-computed settings and URLconfs, routes registered in loops or from config, string-token dependency injection, metaprogramming, host/tenant dispatch, and queue/event hops unless configured. These show up only via customConventions and inferred items.',
  'Python call edges are shallower than TypeScript ones: there is no type inference, so calls through parameters, attributes and dynamic dispatch are dropped (and counted in the warnings).',
  'Cross-language HTTP links and SQLAlchemy read/write edges are heuristic and always marked inferred or given a confidence.',
  'Claude summaries can still be wrong even when they cite code. The grounding score measures citation, not correctness.',
  'The report goes stale as code changes. /codebase-guide --update is incremental but has to be re-run.',
  'Out of scope in v1: other languages, runtime tracing, cross-repo graphs, GraphQL/gRPC linking, architecture decision history.',
];

function templatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [join(here, 'report-template.html'), join(here, '../../report/dist/index.html'), join(here, '../dist/report-template.html')];
  const hit = cands.find((p) => existsSync(p));
  if (!hit) throw new Error(`report template not found (looked in ${cands.join(', ')}). Run pnpm build.`);
  return hit;
}

function git(root: string, args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return undefined; }
}

interface Snip { path: string; start: number; lines: string[]; redacted: number }

/** Snippets (≤ 15 lines, secret-scanned) for every location the report shows, highest priority first, within a byte budget. */
function collectSnippets(root: string, graph: RepoGraph, analysis: Analysis, ex: Explanations | null, hints: { recipes: { examples: { path: string; line: number }[] }[]; patterns: { examples: { path: string; line: number }[] }[] }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const wants: { path: string; line: number; end?: number }[] = [];
  const node = (id: string) => { const n = byId.get(id); if (n?.path && n.line) wants.push({ path: n.path, line: n.line, ...(n.endLine ? { end: n.endLine } : {}) }); };
  for (const f of ex?.flows ?? []) for (const s of f.steps) { for (const e of s.evidence) wants.push(e); node(s.nodeId); }
  for (const f of analysis.flowCandidates) {
    for (const id of f.nodes.slice(0, 20)) node(id);
    const set = new Set(f.nodes);
    for (const e of graph.edges) if (set.has(e.source) && set.has(e.target) && e.evidence?.[0]) wants.push(e.evidence[0]);
  }
  for (const r of ex?.guide?.recipes ?? []) for (const s of r.steps) if (s.evidence) wants.push(s.evidence);
  for (const c of ex?.guide?.conventions ?? []) if (c.examples[0]) wants.push(c.examples[0]);
  for (const r of hints.recipes) for (const e of r.examples) wants.push(e);
  const handles = handlerIndex(graph);
  for (const n of graph.nodes) if (n.kind === 'endpoint') node(handles.get(n.id) ?? n.id);
  const symbols = graph.nodes.filter((n) => ['function', 'method', 'class', 'component', 'model'].includes(n.kind))
    .sort((a, b) => (analysis.symbols[b.id]?.fanIn ?? 0) - (analysis.symbols[a.id]?.fanIn ?? 0) || (a.id < b.id ? -1 : 1));
  for (const r of analysis.readingOrder) wants.push({ path: byId.get(r.id)!.path!, line: 1 });
  for (const n of symbols) node(n.id);
  for (const n of graph.nodes) if (n.kind === 'module' && n.path) wants.push({ path: n.path, line: 1 });

  const files = new Map<string, string[] | null>();
  const out: Record<string, Snip> = {};
  let bytes = 0, redactions = 0, skipped = 0;
  for (const w of wants) {
    const key = `${w.path}:${w.line}`;
    if (out[key]) continue;
    if (!files.has(w.path)) {
      const abs = join(root, w.path);
      files.set(w.path, !isSecretPath(w.path) && existsSync(abs) && statSync(abs).isFile() && statSync(abs).size < 2_000_000 ? readFileSync(abs, 'utf8').split('\n') : null);
    }
    const lines = files.get(w.path);
    if (!lines) continue;
    const start = w.end && w.end - w.line < SNIPPET_LINES ? w.line : Math.max(1, w.line - (w.end ? 0 : 2));
    const raw = lines.slice(start - 1, start - 1 + SNIPPET_LINES).map((l) => (l.length > 240 ? `${l.slice(0, 237)}…` : l));
    const r = redact(raw.join('\n'));
    const size = r.text.length + 40;
    if (bytes + size > SNIPPET_BUDGET) { skipped++; continue; }
    bytes += size;
    redactions += r.count;
    out[key] = { path: w.path, start, lines: r.text.split('\n'), redacted: r.count };
  }
  return { snippets: out, bytes, redactions, skipped };
}

export function renderReport(root: string, opts: RenderOptions): { lines: string[]; path: string; bytes: number } {
  const graph = readJsonFile<RepoGraph>(join(root, OUTPUT_DIR, 'graph.json'));
  const analysis = readJsonFile<Analysis>(join(root, OUTPUT_DIR, 'analysis.json'));
  if (!graph || !analysis) throw new Error(`no ${OUTPUT_DIR}/graph.json or analysis.json: run prepare or /repo-map first`);
  const explanations = opts.deterministic ? null : readJsonFile<Explanations>(join(root, EXPLAIN_DIR, 'validated.json')) ?? null;
  const head = gitHead(root);
  const dirty = !!git(root, ['status', '--porcelain', '--untracked-files=no']);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hints = { patterns: patternHints(graph), recipes: recipeCandidates(graph, analysis, byId) };
  const sn = opts.snippets ? collectSnippets(root, graph, analysis, explanations, hints) : { snippets: {}, bytes: 0, redactions: 0, skipped: 0 };
  const meta = {
    repoName: readJsonFile<{ name?: string }>(join(root, 'package.json'))?.name ?? basename(root),
    repoRoot: root, ...(graph.commit ? { commit: graph.commit } : {}), ...(head ? { head } : {}), dirty,
    stale: !!(graph.commit && head && graph.commit !== head),
    generatedAt: new Date().toISOString(), version: VERSION, depth: explanations?.depth ?? opts.depth,
    mode: explanations ? 'full' : 'deterministic', editorScheme: opts.editorScheme, snippets: opts.snippets, limitations: LIMITATIONS,
  };
  const data = { meta, graph: { ...graph, edges: [] as never[], packedEdges: packEdges(graph) }, analysis, explanations, hints, snippets: sn.snippets };
  // `<` escaped so code like "</script>" inside the JSON can't end the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const template = readFileSync(templatePath(), 'utf8');
  if (!template.includes('<!--CG_DATA-->')) throw new Error('report template has no <!--CG_DATA--> placeholder');
  const outDir = join(root, OUTPUT_DIR, 'report');
  const indexPath = join(outDir, 'index.html');
  let bytes: number;
  rmSync(join(outDir, 'data'), { recursive: true, force: true });
  rmSync(join(outDir, 'assets'), { recursive: true, force: true });
  if (opts.split) {
    // file:// blocks fetch() and module <script src>, so data ships as a classic script and the app stays an inline module.
    const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(template);
    let html = template.replace('<!--CG_DATA-->', '<script src="data/report-data.js"></script>');
    if (css) { html = html.replace(css[0], '<link rel="stylesheet" href="assets/app.css">'); writeFileEnsured(join(outDir, 'assets', 'app.css'), css[1]!); }
    writeFileEnsured(join(outDir, 'data', 'report-data.js'), `window.__CG_DATA__=${json};\n`);
    writeFileEnsured(indexPath, html);
    bytes = Buffer.byteLength(html) + Buffer.byteLength(json) + (css ? css[1]!.length : 0);
  } else {
    const html = template.replace('<!--CG_DATA-->', () => `<script type="application/json" id="cg-data">${json}</script>`);
    writeFileEnsured(indexPath, html);
    bytes = Buffer.byteLength(html);
  }
  writeFileEnsured(join(outDir, 'meta.json'), JSON.stringify({ commit: graph.commit ?? null, generatedAt: meta.generatedAt, version: VERSION, mode: meta.mode, depth: meta.depth }, null, 1) + '\n');
  if (opts.open) openFile(indexPath);
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const lines = [`report: ${indexPath}${opts.split ? ' (split: data/ and assets/ beside it)' : ''} · ${mb(bytes)} · ${meta.mode}`];
  if (explanations) {
    const g = explanations.grounding.total;
    lines.push(`grounding: ${g.pct}% of ${g.claims} claims cite code · flow steps evidence-backed ${explanations.flowSteps.pct}% (${explanations.flowSteps.backed}/${explanations.flowSteps.total}) · inferred claims ${explanations.inferredClaims}`);
    const bad = explanations.tasks.filter((t) => t.status !== 'ok');
    if (bad.length) lines.push(`explain issues: ${bad.map((t) => `${t.id} ${t.status}`).join(', ')}`);
  } else if (!opts.deterministic) lines.push('no validated explanations found, so this is the deterministic report');
  if (opts.snippets) lines.push(`snippets: ${Object.keys(sn.snippets).length} embedded, ${sn.redactions} secret-looking value(s) redacted${sn.skipped ? `, ${sn.skipped} skipped (size budget)` : ''}`);
  const top = [...graph.warnings].sort((a, b) => (b.count ?? 1) - (a.count ?? 1)).slice(0, 3);
  if (top.length) lines.push(`top warnings: ${top.map((w) => `${w.code}×${w.count ?? 1}`).join(', ')}`);
  if (meta.stale) lines.push(`stale: graph is from ${graph.commit?.slice(0, 8)}, HEAD is ${head?.slice(0, 8)}`);
  if (!opts.split && bytes > SIZE_WARN) lines.push(`warning: report is ${mb(bytes)} (over 15 MB). Re-run with --split for a folder build.`);
  lines.push(`note: ${OUTPUT_DIR}/ is local output; gitignore it (or commit ${OUTPUT_DIR}/report/ on purpose for a shared copy). The report contains source paths and snippets.`);
  return { lines, path: indexPath, bytes };
}

/**
 * Edges dominate report size (ids repeat long node ids). Ship them as integer rows against the node list; the UI rebuilds them.
 * Row: [kindIdx, sourceIdx, targetIdx, weight, inferred 0|1, meta|0, [[pathIdx, line], …]|0] (evidence capped at 2).
 */
export function packEdges(graph: RepoGraph) {
  const nodeIdx = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const kinds: string[] = [], paths: string[] = [];
  const kindIdx = new Map<string, number>(), pathIdx = new Map<string, number>();
  const intern = (m: Map<string, number>, list: string[], v: string) => { let i = m.get(v); if (i === undefined) { i = list.length; list.push(v); m.set(v, i); } return i; };
  const rows = graph.edges.map((e) => [
    intern(kindIdx, kinds, e.kind), nodeIdx.get(e.source)!, nodeIdx.get(e.target)!, e.weight, e.inferred ? 1 : 0, e.meta ?? 0,
    e.evidence?.length ? e.evidence.slice(0, 2).map((v) => [intern(pathIdx, paths, v.path), v.line]) : 0,
  ]);
  return { kinds, paths, rows };
}

function openFile(p: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [p]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', p]] : ['xdg-open', [p]];
  try { spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
}
