import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Evidence, RepoGraph } from './schema.ts';
import { isSecretPath } from './files.ts';

export type RunKind = 'install' | 'dev' | 'start' | 'test' | 'build' | 'migrate' | 'lint' | 'setup' | 'service' | 'other';
export type RunOrigin = 'package.json' | 'Makefile' | 'docker-compose' | 'Procfile' | 'pyproject' | 'manage.py' | 'README' | 'lockfile';

/** One command a developer can run, always with the file+line it came from. */
export interface RunFact {
  kind: RunKind; origin: RunOrigin; label: string; command: string; cwd: string; source: Evidence;
  /** What the command expands to (npm script body, make recipe, compose image/build). */
  script?: string; ports?: string[]; section?: string;
}
export interface StackItem { name: string; kind: 'language' | 'framework' | 'library' | 'tool'; version?: string; declared?: string; source: Evidence }
export interface RepoFacts {
  run: RunFact[];
  stack: StackItem[];
  envExample: { name: string; path: string; line: number }[];
  configFiles: { path: string; controls: string }[];
  packageEntries: { file: string; field: string; source: Evidence }[];
  featureFlags: string[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p: string) => posix.dirname(p);

export function classifyRun(name: string, command: string): RunKind {
  const s = `${name} ${command}`.toLowerCase();
  const n = name.toLowerCase();
  if (/migrat|alembic|prisma (migrate|db push)|db:push|db:migrate|makemigrations|^release$/.test(s)) return 'migrate';
  if (/^(test|tests|e2e|cypress|playwright|coverage)|(^|[\s:])(test|pytest|jest|vitest|mocha|playwright|cypress)\b/.test(n) || /(^|\s)(pytest|jest|vitest|mocha)\b|manage\.py test|(npm|pnpm|yarn|bun) (run )?test/.test(command.toLowerCase())) return 'test';
  if (/lint|eslint|ruff|flake8|prettier|format|typecheck|mypy|tsc --noemit/.test(s)) return 'lint';
  if (/^(install|ci|bootstrap|setup|deps)$/.test(n) || /\b(npm|pnpm|yarn|bun) (install|ci)\b|pip install|poetry install|uv sync|pipenv install|pdm install/.test(s)) return 'install';
  if (/^(build|compile|bundle|dist)|:build$/.test(n) || /\b(next|vite|tsc|webpack|rollup|esbuild|turbo run) build\b|\btsc\b(?!.*noemit)/.test(s)) return 'build';
  if (/^(dev|develop|watch|serve)|:dev$/.test(n) || /\b(next|vite|nuxt|astro|turbo( run)?) dev\b|runserver|--reload|nodemon|tsx watch|ts-node-dev|flask run|--watch/.test(s)) return 'dev';
  if (/^(start|web|serve|prod|up|run)$|:start$/.test(n) || /\b(uvicorn|gunicorn|hypercorn|node|next start|docker compose up|docker-compose up)\b/.test(s)) return 'start';
  if (/^(clean|seed|setup|init|prepare|postinstall)$/.test(n)) return 'setup';
  return 'other';
}

const read = (root: string, rel: string) => {
  if (isSecretPath(rel)) return '';
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
};
const lineOf = (text: string, needle: RegExp | string, from = 0) => {
  const lines = text.split('\n');
  for (let i = from; i < lines.length; i++) if (typeof needle === 'string' ? lines[i]!.includes(needle) : needle.test(lines[i]!)) return i + 1;
  return 1;
};

const LOCKS: { file: string; pm: string; install: string }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm', install: 'pnpm install' },
  { file: 'pnpm-workspace.yaml', pm: 'pnpm', install: 'pnpm install' },
  { file: 'package-lock.json', pm: 'npm', install: 'npm install' },
  { file: 'yarn.lock', pm: 'yarn', install: 'yarn install' },
  { file: 'bun.lock', pm: 'bun', install: 'bun install' },
  { file: 'bun.lockb', pm: 'bun', install: 'bun install' },
  { file: 'poetry.lock', pm: 'poetry', install: 'poetry install' },
  { file: 'uv.lock', pm: 'uv', install: 'uv sync' },
  { file: 'Pipfile.lock', pm: 'pipenv', install: 'pipenv install' },
  { file: 'pdm.lock', pm: 'pdm', install: 'pdm install' },
];
const JS_PMS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

const KNOWN_JS: Record<string, StackItem['kind']> = {
  typescript: 'language', next: 'framework', react: 'framework', vue: 'framework', svelte: 'framework', nuxt: 'framework', express: 'framework', fastify: 'framework',
  '@nestjs/core': 'framework', koa: 'framework', hono: 'framework', prisma: 'tool', '@prisma/client': 'library', 'drizzle-orm': 'library', typeorm: 'library',
  sequelize: 'library', mongoose: 'library', knex: 'library', vite: 'tool', webpack: 'tool', turbo: 'tool', jest: 'tool', vitest: 'tool', '@playwright/test': 'tool',
  cypress: 'tool', tailwindcss: 'library', '@reduxjs/toolkit': 'library', redux: 'library', zustand: 'library', '@tanstack/react-query': 'library', swr: 'library',
  axios: 'library', ky: 'library', zod: 'library', graphql: 'library', '@trpc/server': 'library', 'socket.io': 'library', bullmq: 'library', ioredis: 'library',
  pg: 'library', mysql2: 'library', eslint: 'tool', prettier: 'tool', storybook: 'tool',
};
const KNOWN_PY: Record<string, StackItem['kind']> = {
  django: 'framework', djangorestframework: 'framework', fastapi: 'framework', flask: 'framework', starlette: 'framework', sqlalchemy: 'library',
  'flask-sqlalchemy': 'library', pydantic: 'library', 'pydantic-settings': 'library', celery: 'library', alembic: 'tool', uvicorn: 'tool', gunicorn: 'tool',
  pytest: 'tool', requests: 'library', httpx: 'library', redis: 'library', psycopg2: 'library', 'psycopg2-binary': 'library', psycopg: 'library',
  boto3: 'library', marshmallow: 'library', 'django-environ': 'library', 'python-dotenv': 'library', mypy: 'tool', ruff: 'tool', pandas: 'library', numpy: 'library',
};

export function repoFacts(root: string, files: string[], graph: Pick<RepoGraph, 'nodes'>): RepoFacts {
  const fileSet = new Set(files);
  const run: RunFact[] = [];
  const lockIn = (dir: string) => {
    for (let d = dir; ; d = dirOf(d)) {
      for (const l of LOCKS) if (JS_PMS.has(l.pm) && fileSet.has(d === '.' ? l.file : `${d}/${l.file}`)) return l.pm;
      if (d === '.' || d === '') return undefined;
    }
  };

  // Installs from lockfiles / requirements.
  for (const f of files) {
    const base = posix.basename(f);
    const lock = LOCKS.find((l) => l.file === base);
    if (lock) run.push({ kind: 'install', origin: 'lockfile', label: lock.install, command: lock.install, cwd: dirOf(f), source: { path: f, line: 1 } });
    if (/^requirements([-_.][\w-]+)?\.txt$/.test(base) && !/(^|\/)(docs?)\//.test(f)) run.push({ kind: 'install', origin: 'lockfile', label: `pip install -r ${base}`, command: `pip install -r ${base}`, cwd: dirOf(f), source: { path: f, line: 1 } });
  }
  // No JS lockfile at all: npm is the default, once per top-most package.json.
  if (!files.some((f) => LOCKS.some((l) => JS_PMS.has(l.pm) && posix.basename(f) === l.file))) {
    const pkgs = files.filter((f) => posix.basename(f) === 'package.json');
    for (const f of pkgs) {
      if (pkgs.some((o) => o !== f && (dirOf(o) === '.' || f.startsWith(`${dirOf(o)}/`)))) continue;
      run.push({ kind: 'install', origin: 'package.json', label: 'npm install', command: 'npm install', cwd: dirOf(f), source: { path: f, line: 1 } });
    }
  }

  // package.json + pyproject scripts come from the graph's script nodes.
  for (const n of graph.nodes) {
    if (n.kind !== 'script' || !n.path) continue;
    const cwd = dirOf(n.path);
    if (n.meta.role === 'npm-script') {
      const pm = lockIn(cwd) ?? 'npm';
      run.push({ kind: classifyRun(n.label, n.meta.signature ?? ''), origin: 'package.json', label: n.label, command: `${pm} run ${n.label}`, cwd, script: n.meta.signature ?? '', source: { path: n.path, line: n.line ?? 1 } });
    } else if (n.meta.role === 'pyproject-script') {
      run.push({ kind: classifyRun(n.label, n.meta.signature ?? ''), origin: 'pyproject', label: n.label, command: n.label, cwd, script: n.meta.signature ?? '', source: { path: n.path, line: n.line ?? 1 } });
    }
  }

  for (const f of files) {
    const base = posix.basename(f);
    const cwd = dirOf(f);
    if (/^(GNU)?[Mm]akefile$/.test(base)) {
      const lines = read(root, f).split('\n');
      lines.forEach((l, i) => {
        const m = /^([A-Za-z0-9][\w.-]*)\s*:(?![=:])/.exec(l);
        if (!m || m[1]!.startsWith('.')) return;
        const recipe = lines[i + 1]?.startsWith('\t') ? lines[i + 1]!.trim().replace(/^@/, '') : undefined;
        run.push({ kind: classifyRun(m[1]!, recipe ?? ''), origin: 'Makefile', label: m[1]!, command: `make ${m[1]}`, cwd, ...(recipe ? { script: recipe } : {}), source: { path: f, line: i + 1 } });
      });
    } else if (/^(docker-)?compose([.-][\w-]+)?\.ya?ml$/.test(base)) {
      const text = read(root, f);
      const services = composeServices(text);
      const flag = /^(docker-)?compose\.ya?ml$/.test(base) ? '' : ` -f ${base}`;
      if (services.length) run.push({ kind: 'start', origin: 'docker-compose', label: 'compose up', command: `docker compose${flag} up`, cwd, source: { path: f, line: lineOf(text, /^services:/) } });
      for (const s of services) run.push({ kind: 'service', origin: 'docker-compose', label: s.name, command: `docker compose${flag} up ${s.name}`, cwd, ...(s.image ? { script: s.image } : {}), ...(s.ports.length ? { ports: s.ports } : {}), source: { path: f, line: s.line } });
    } else if (base === 'Procfile') {
      read(root, f).split('\n').forEach((l, i) => {
        const m = /^([\w-]+):\s*(.+)$/.exec(l);
        if (m) run.push({ kind: m[1] === 'web' ? 'start' : m[1] === 'release' ? 'migrate' : classifyRun(m[1]!, m[2]!), origin: 'Procfile', label: m[1]!, command: m[2]!.trim(), cwd, source: { path: f, line: i + 1 } });
      });
    } else if (base === 'manage.py') {
      for (const [label, kind] of [['runserver', 'dev'], ['migrate', 'migrate'], ['test', 'test']] as const) {
        run.push({ kind, origin: 'manage.py', label, command: `python manage.py ${label}`, cwd, script: 'Django built-in command', source: { path: f, line: 1 } });
      }
    } else if (/^(readme|contributing|development|setup|getting[-_]started)(\.[\w-]+)?\.md$/i.test(base) && f.split('/').length <= 3) {
      run.push(...readmeCommands(read(root, f), f));
    }
  }
  for (const n of graph.nodes) {
    if (n.meta.role !== 'management-command' || !n.path) continue;
    const name = posix.basename(n.path, '.py');
    const manage = files.find((f) => posix.basename(f) === 'manage.py' && (n.path!.startsWith(`${dirOf(f)}/`) || dirOf(f) === '.'));
    if (manage) run.push({ kind: classifyRun(name, ''), origin: 'manage.py', label: name, command: `python manage.py ${name}`, cwd: dirOf(manage), script: 'custom management command', source: { path: n.path, line: n.line ?? 1 } });
  }

  // Env names declared in example files (names only; values are never read into the report).
  const envExample: RepoFacts['envExample'] = [];
  for (const f of files) {
    if (!/(^|\/)\.env\.(example|sample|template)$/.test(f)) continue;
    read(root, f).split('\n').forEach((l, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
      if (m) envExample.push({ name: m[1]!, path: f, line: i + 1 });
    });
  }

  const featureFlags = graph.nodes.filter((n) => n.kind === 'env-var' && /FEATURE|FLAG|(^|_)ENABLE(D)?(_|$)|(^|_)DISABLE(D)?(_|$)|^USE_/.test(n.label)).map((n) => n.id).sort(cmp);

  return {
    run: dedupeRun(run),
    stack: stackOf(root, files),
    envExample: envExample.sort((a, b) => cmp(a.path, b.path) || a.line - b.line),
    configFiles: configFiles(files),
    packageEntries: packageEntries(root, files),
    featureFlags,
  };
}

const ORIGIN_RANK: Record<RunOrigin, number> = { 'package.json': 0, pyproject: 0, Makefile: 1, Procfile: 1, 'docker-compose': 1, 'manage.py': 2, lockfile: 2, README: 3 };

/** Same command in the same dir once; a structured source beats a README mention. */
function dedupeRun(xs: RunFact[]): RunFact[] {
  const seen = new Map<string, RunFact>();
  for (const r of [...xs].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin])) {
    const k = `${r.cwd}|${r.command}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => cmp(a.source.path, b.source.path) || a.source.line - b.source.line || cmp(a.command, b.command));
}

/** Minimal docker-compose reader: top-level `services:` children, their image and ports. */
export function composeServices(text: string): { name: string; line: number; image?: string; ports: string[] }[] {
  const lines = text.split('\n');
  const out: { name: string; line: number; image?: string; ports: string[] }[] = [];
  let inServices = false, svcIndent = -1, inPorts = false;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\s+#.*$/, '');
    if (!l.trim()) return;
    const indent = l.length - l.trimStart().length;
    if (indent === 0) { inServices = /^services:\s*$/.test(l); svcIndent = -1; return; }
    if (!inServices) return;
    if (svcIndent === -1) svcIndent = indent;
    const t = l.trim();
    if (indent === svcIndent && /^[\w.-]+:\s*$/.test(t)) { out.push({ name: t.slice(0, -1), line: i + 1, ports: [] }); inPorts = false; return; }
    const cur = out[out.length - 1];
    if (!cur) return;
    if (/^image:\s*/.test(t)) cur.image = t.replace(/^image:\s*/, '').replace(/["']/g, '');
    else if (/^ports:\s*$/.test(t)) inPorts = true;
    else if (/^ports:\s*\[/.test(t)) cur.ports.push(...t.replace(/^ports:\s*\[|\]$/g, '').split(',').map((p) => p.trim().replace(/["']/g, '')).filter(Boolean));
    else if (inPorts && t.startsWith('- ')) cur.ports.push(t.slice(2).trim().replace(/["']/g, ''));
    else if (!t.startsWith('- ')) inPorts = false;
  });
  return out;
}

const CMD_START = /^(npm|pnpm|yarn|bun|npx|pnpx|bunx|node|deno|python3?|pip3?|poetry|uv|pipenv|pdm|make|docker|docker-compose|cp|mv|export|source|cd|git|alembic|flask|uvicorn|gunicorn|django-admin|pytest|tox|nox|corepack|nvm|brew|createdb|psql|redis-server|turbo|prisma|\.\/)\b/;

/** Shell commands from fenced blocks in README-like docs, with the nearest heading as context. */
export function readmeCommands(text: string, path: string): RunFact[] {
  const out: RunFact[] = [];
  let section = '';
  let fence: string | null = null;
  text.split('\n').forEach((raw, i) => {
    const l = raw.trimEnd();
    const f = /^\s*(```|~~~)\s*([\w-]*)/.exec(l);
    if (f) { fence = fence === null ? (f[2] ?? '').toLowerCase() : null; return; }
    if (fence === null) { const h = /^#{1,4}\s+(.+)$/.exec(l); if (h) section = h[1]!.trim(); return; }
    if (!['', 'bash', 'sh', 'shell', 'console', 'zsh', 'shell-session', 'terminal'].includes(fence)) return;
    const cmd = l.trim().replace(/^[$>]\s+/, '');
    if (!cmd || cmd.startsWith('#') || !CMD_START.test(cmd)) return;
    out.push({ kind: classifyRun('', cmd), origin: 'README', label: cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd, command: cmd, cwd: dirOf(path), ...(section ? { section } : {}), source: { path, line: i + 1 } });
  });
  return out;
}

function stackOf(root: string, files: string[]): StackItem[] {
  const out = new Map<string, StackItem>();
  const put = (s: StackItem) => { if (!out.has(s.name)) out.set(s.name, s); };
  const resolved = lockVersions(root, files);
  for (const f of files.filter((x) => posix.basename(x) === 'package.json').sort((a, b) => a.split('/').length - b.split('/').length || cmp(a, b))) {
    const text = read(root, f);
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } };
    try { pkg = JSON.parse(text); } catch { continue; }
    if (pkg.engines?.node) put({ name: 'Node.js', kind: 'language', declared: pkg.engines.node, source: { path: f, line: lineOf(text, '"node"') } });
    for (const [name, decl] of Object.entries({ ...pkg.devDependencies, ...pkg.dependencies })) {
      const kind = KNOWN_JS[name];
      if (!kind || out.has(name)) continue;
      const version = resolved.js.get(name);
      put({ name, kind, declared: decl, ...(version ? { version } : {}), source: { path: f, line: lineOf(text, `"${name}"`) } });
    }
  }
  for (const f of files.filter((x) => /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|Pipfile)$/.test(x)).sort(cmp)) {
    const text = read(root, f);
    const isToml = !/\.txt$/.test(f);
    text.split('\n').forEach((l, i) => {
      const rp = /^\s*requires-python\s*=\s*["']([^"']+)["']/.exec(l) ?? /^\s*python\s*=\s*["']([^"']+)["']/.exec(l);
      if (rp) { put({ name: 'Python', kind: 'language', declared: rp[1]!, source: { path: f, line: i + 1 } }); return; }
      // requirements: the whole line; TOML: every quoted PEP 508 string, or poetry-style `name = "^1.2"`.
      const specs = !isToml ? [l] : [...l.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
      const poetry = isToml ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*["']([^"']+)["']/.exec(l) : null;
      if (poetry) specs.push(`${poetry[1]}${/^[\d*]/.test(poetry[2]!) ? '==' : ''}${poetry[2]}`);
      for (const spec of specs) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:(==|>=|~=|<=|\^|>|<)\s*([^,;\s]+))?/.exec(spec);
        if (!m) continue;
        const name = m[1]!.toLowerCase().replace(/_/g, '-');
        const kind = KNOWN_PY[name];
        if (!kind || out.has(name)) continue;
        const version = resolved.py.get(name) ?? (m[2] === '==' ? m[3] : undefined);
        put({ name, kind, ...(m[3] ? { declared: `${m[2]}${m[3]}` } : {}), ...(version ? { version } : {}), source: { path: f, line: i + 1 } });
      }
    });
  }
  const order = { language: 0, framework: 1, library: 2, tool: 3 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind] || cmp(a.name, b.name));
}

/** Resolved versions from lockfiles (first occurrence wins). */
function lockVersions(root: string, files: string[]): { js: Map<string, string>; py: Map<string, string> } {
  const js = new Map<string, string>(), py = new Map<string, string>();
  for (const f of [...files].sort((a, b) => a.split('/').length - b.split('/').length || cmp(a, b))) {
    const base = posix.basename(f);
    if (base === 'package-lock.json') {
      try {
        const lock = JSON.parse(read(root, f)) as { packages?: Record<string, { version?: string }> };
        for (const [k, v] of Object.entries(lock.packages ?? {})) {
          const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
          if (m && v.version && !js.has(m[1]!) && !k.includes('/node_modules/', 13)) js.set(m[1]!, v.version);
        }
      } catch { /* malformed lock: fall back to declared ranges */ }
    } else if (base === 'pnpm-lock.yaml') {
      const lines = read(root, f).split('\n');
      let inImporters = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (/^\S/.test(l)) inImporters = /^importers:|^dependencies:|^devDependencies:/.test(l);
        if (!inImporters) continue;
        const key = /^\s+('?)(@?[^\s:']+)\1:\s*$/.exec(l);
        const next = lines[i + 1] ?? '', after = lines[i + 2] ?? '';
        const v = /^\s+version:\s*'?([^\s(']+)/.exec(/specifier:/.test(next) ? after : next);
        if (key && v && !js.has(key[2]!)) js.set(key[2]!, v[1]!);
        const inline = /^\s{2,}('?)(@?[^\s:']+)\1:\s*'?(\d[^\s(']*)/.exec(l);
        if (inline && !js.has(inline[2]!)) js.set(inline[2]!, inline[3]!);
      }
    } else if (base === 'yarn.lock') {
      const re = /^"?((?:@[^@/\s]+\/)?[^@\s"]+)@[^\n]*:\n\s+version:?\s+"?([^"\n]+)"?/gm;
      for (const m of read(root, f).matchAll(re)) if (!js.has(m[1]!)) js.set(m[1]!, m[2]!);
    } else if (base === 'poetry.lock' || base === 'uv.lock' || base === 'pdm.lock') {
      for (const m of read(root, f).matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) {
        const n = m[1]!.toLowerCase().replace(/_/g, '-');
        if (!py.has(n)) py.set(n, m[2]!);
      }
    }
  }
  return { js, py };
}

const CONFIG_FILES: [RegExp, string][] = [
  [/(^|\/)tsconfig[^/]*\.json$/, 'TypeScript compiler options and path aliases'],
  [/(^|\/)next\.config\.[cm]?[jt]s$/, 'Next.js build/runtime settings'],
  [/(^|\/)vite\.config\.[cm]?[jt]s$/, 'Vite dev server and build'],
  [/(^|\/)(jest|vitest|playwright)\.config\.[cm]?[jt]s$/, 'test runner'],
  [/(^|\/)tailwind\.config\.[cm]?[jt]s$/, 'Tailwind CSS theme'],
  [/(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s)$/, 'lint rules'],
  [/(^|\/)(\.prettierrc[^/]*|prettier\.config\.[cm]?[jt]s)$/, 'code formatting'],
  [/(^|\/)turbo\.json$/, 'Turborepo task pipeline'],
  [/(^|\/)pnpm-workspace\.yaml$/, 'pnpm workspace packages'],
  [/(^|\/)nest-cli\.json$/, 'NestJS CLI build'],
  [/(^|\/)schema\.prisma$/, 'Prisma data model and datasource'],
  [/(^|\/)pyproject\.toml$/, 'Python project metadata, dependencies and tool settings'],
  [/(^|\/)setup\.cfg$/, 'Python package/tool settings'],
  [/(^|\/)(pytest\.ini|tox\.ini|noxfile\.py)$/, 'Python test runner'],
  [/(^|\/)alembic\.ini$/, 'Alembic migrations'],
  [/(^|\/)settings[^/]*\.py$/, 'Django/app settings'],
  [/(^|\/)(Dockerfile[^/]*|\.dockerignore)$/, 'container image build'],
  [/(^|\/)(docker-)?compose[^/]*\.ya?ml$/, 'local services (docker compose)'],
  [/(^|\/)Procfile$/, 'process types for PaaS deploys'],
  [/(^|\/)(GNU)?[Mm]akefile$/, 'make targets'],
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'CI workflow'],
  [/(^|\/)\.env\.(example|sample|template)$/, 'example environment variable names'],
  [/(^|\/)(vercel|netlify|fly|render|app)\.(json|toml|ya?ml)$/, 'deployment platform settings'],
];

function configFiles(files: string[]): RepoFacts['configFiles'] {
  const out: RepoFacts['configFiles'] = [];
  for (const f of files) {
    const hit = CONFIG_FILES.find(([re]) => re.test(f));
    if (hit) out.push({ path: f, controls: hit[1] });
  }
  return out.sort((a, b) => cmp(a.path, b.path));
}

function packageEntries(root: string, files: string[]): RepoFacts['packageEntries'] {
  const fileSet = new Set(files);
  const out: RepoFacts['packageEntries'] = [];
  for (const f of files.filter((x) => posix.basename(x) === 'package.json')) {
    const text = read(root, f);
    let pkg: { main?: string; bin?: string | Record<string, string> };
    try { pkg = JSON.parse(text); } catch { continue; }
    const dir = dirOf(f);
    const targets: [string, string][] = [];
    if (typeof pkg.main === 'string') targets.push(['main', pkg.main]);
    if (typeof pkg.bin === 'string') targets.push(['bin', pkg.bin]);
    else if (pkg.bin && typeof pkg.bin === 'object') for (const [k, v] of Object.entries(pkg.bin)) targets.push([`bin.${k}`, v]);
    for (const [field, t] of targets) {
      const rel = posix.normalize(dir === '.' ? t : `${dir}/${t}`).replace(/^\.\//, '');
      const cands = [rel, rel.replace(/^(.*?)(dist|build|lib)\//, '$1src/').replace(/\.[cm]?js$/, '.ts'), rel.replace(/\.[cm]?js$/, '.ts')];
      const hit = cands.find((c) => fileSet.has(c));
      if (hit) out.push({ file: hit, field, source: { path: f, line: lineOf(text, `"${field.split('.')[0]}"`) } });
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || cmp(a.field, b.field));
}
