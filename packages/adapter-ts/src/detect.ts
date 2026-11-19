import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { globToRegExp, readJsonFile } from '@codebase-guide/core';

export const TS_EXT = /\.(ts|tsx|mts|cts)$/;
export const JS_EXT = /\.(js|jsx|mjs|cjs)$/;
export const isSource = (f: string) => TS_EXT.test(f) || JS_EXT.test(f);
export const isDts = (f: string) => /\.d\.[cm]?ts$/.test(f);
export const isTestFile = (f: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.split('/').includes('__tests__');

export interface PackageJson {
  name?: string;
  main?: string; module?: string; types?: string; typings?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface TsProjectInfo {
  /** Repo-relative POSIX root, '.' for the repo root. */
  root: string;
  name: string;
  lang: 'ts' | 'js';
  /** Repo-relative tsconfig/jsconfig path, if any. */
  tsconfig?: string;
  pkg?: PackageJson;
  /** Source files owned by this project (deepest project root wins), repo-relative. */
  files: string[];
}

export interface WorkspacePackage { name: string; dir: string; pkg: PackageJson }

export interface WorkspaceInfo {
  tool: 'pnpm' | 'npm/yarn' | null;
  turbo: boolean;
  packages: WorkspacePackage[];
}

/** Minimal reader for `packages:` in pnpm-workspace.yaml (a YAML list of quoted/unquoted globs). */
export function readPnpmWorkspaceGlobs(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const m = /^\s+-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (m) out.push(m[1]!);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
}

const dirOf = (f: string) => { const d = posix.dirname(f); return d === '' ? '.' : d; };

export function detectTsProjects(root: string, files: string[]): { projects: TsProjectInfo[]; workspace: WorkspaceInfo } {
  const rootPkg = readJsonFile<PackageJson>(join(root, 'package.json'));
  let globs: string[] = [];
  let tool: WorkspaceInfo['tool'] = null;
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    globs = readPnpmWorkspaceGlobs(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
    tool = 'pnpm';
  } else if (rootPkg?.workspaces) {
    globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages ?? [];
    tool = 'npm/yarn';
  }
  const pkgDirs = files.filter((f) => f === 'package.json' || f.endsWith('/package.json')).map(dirOf);
  const pos = globs.filter((g) => !g.startsWith('!')).map((g) => globToRegExp(g.replace(/\/$/, '')));
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1).replace(/\/$/, '')));
  const members = pkgDirs.filter((d) => d !== '.' && pos.some((r) => r.test(d)) && !neg.some((r) => r.test(d)));
  const workspace: WorkspaceInfo = {
    tool,
    turbo: existsSync(join(root, 'turbo.json')),
    packages: members
      .map((dir) => ({ dir, pkg: readJsonFile<PackageJson>(join(root, dir, 'package.json')) ?? {} }))
      .filter((p) => p.pkg.name)
      .map((p) => ({ name: p.pkg.name!, dir: p.dir, pkg: p.pkg })),
  };

  // Every package.json directory is a project root; the repo root is one too if it owns any source.
  const roots = [...new Set(['.', ...pkgDirs])].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const owned = new Map<string, string[]>();
  for (const f of files) {
    if (!isSource(f)) continue;
    const r = roots.find((r) => r === '.' || f.startsWith(r + '/')) ?? '.';
    (owned.get(r) ?? owned.set(r, []).get(r)!).push(f);
  }
  const projects: TsProjectInfo[] = [];
  for (const r of [...owned.keys()].sort()) {
    const own = owned.get(r)!;
    if (!own.some((f) => !isDts(f))) continue;
    const pkg = readJsonFile<PackageJson>(join(root, r, 'package.json'));
    const cfg = ['tsconfig.json', 'jsconfig.json'].map((c) => (r === '.' ? c : `${r}/${c}`)).find((c) => existsSync(join(root, c)));
    projects.push({
      root: r,
      name: pkg?.name ?? (r === '.' ? posix.basename(root) : posix.basename(r)),
      lang: own.some((f) => TS_EXT.test(f)) ? 'ts' : 'js',
      ...(cfg ? { tsconfig: cfg } : {}),
      ...(pkg ? { pkg } : {}),
      files: own,
    });
  }
  return { projects, workspace };
}
