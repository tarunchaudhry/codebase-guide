import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const OUTPUT_DIR = '.codebase-guide';

/** Directory names never descended into. */
export const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', OUTPUT_DIR,
  '__mocks__', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
];
/** File patterns ignored by default (stories, mocks, minified bundles, declaration files are kept for types but not listed here). */
export const DEFAULT_IGNORE_FILES = [/\.stories\.[cm]?[jt]sx?$/, /\.mocks?\.[cm]?[jt]sx?$/, /\.min\.js$/];

/**
 * Files that must never be read: env files (except documented templates), keys, credentials.
 * Applied to every listing so no adapter can open them by accident.
 */
export function isSecretPath(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? '';
  if (/^\.env(\..+)?$/.test(base)) return !/^\.env\.(example|sample|template)$/.test(base);
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i.test(base)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(base)) return true;
  // credentials.json, secrets.yaml, .aws/credentials … but not source code such as auth/credentials.ts
  if (/(^|[._-])(credentials?|secrets?)([._-]|$)/i.test(base) && !/\.([cm]?[jt]sx?|py|md|rst)$/i.test(base)) return true;
  if (/^(\.npmrc|\.pypirc|\.netrc|\.htpasswd)$/.test(base)) return true;
  return false;
}

export const toPosix = (p: string) => p.split(sep).join('/');
export const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');

/** Simple glob → RegExp for include/exclude config: `**` any depth, `*` within a segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface ListOptions { include?: string[] | undefined; exclude?: string[] | undefined }

/**
 * All candidate files under root as sorted repo-relative POSIX paths.
 * Uses `git ls-files` (tracked + untracked, respecting .gitignore) when root is in a work tree,
 * otherwise walks the tree. Default ignores, config include/exclude and the secret guard always apply.
 */
export function listFiles(root: string, opts: ListOptions = {}): string[] {
  let files: string[] | undefined;
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    files = out.split('\0').filter(Boolean).filter((f) => existsSync(join(root, f)));
  } catch { /* not a git work tree */ }
  if (!files) {
    files = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { if (!DEFAULT_IGNORE_DIRS.includes(ent.name)) walk(rel); }
        else if (ent.isFile()) files!.push(rel);
      }
    };
    walk('');
  }
  const inc = opts.include?.map(globToRegExp);
  const exc = opts.exclude?.map(globToRegExp) ?? [];
  return files
    .map(toPosix)
    .filter((f) => !f.split('/').slice(0, -1).some((d) => DEFAULT_IGNORE_DIRS.includes(d)))
    .filter((f) => !DEFAULT_IGNORE_FILES.some((re) => re.test(f)))
    .filter((f) => !isSecretPath(f))
    .filter((f) => !inc || inc.some((re) => re.test(f)))
    .filter((f) => !exc.some((re) => re.test(f)))
    .sort();
}

export function gitHead(root: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
}

export function readJsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

export function writeFileEnsured(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export const fileSize = (path: string) => statSync(path).size;
export const relPosix = (from: string, to: string) => toPosix(relative(from, to));
