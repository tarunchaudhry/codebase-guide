import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PartialGraph, Warning } from '@codebase-guide/core';

export interface PyExtractResult {
  graph: PartialGraph;
  run: { parsed: string[]; cached: number; pythonFiles: number; python?: string };
}

/** The sidecar ships as plain .py files next to this package (source) or under the plugin root (bundled dist/). */
export function sidecarDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [join(here, '../sidecar'), join(here, '../packages/adapter-py/sidecar')];
  const found = cands.find((d) => existsSync(join(d, 'codebase_guide_sidecar', '__main__.py')));
  if (!found) throw new Error(`codebase-guide: Python sidecar not found (looked in ${cands.join(', ')})`);
  return found;
}

const empty = (warnings: Warning[] = []): PyExtractResult => ({ graph: { nodes: [], edges: [], warnings }, run: { parsed: [], cached: 0, pythonFiles: 0 } });

/**
 * Runs `python3 -m codebase_guide_sidecar` (stdlib-only, never imports target code). The target repo is never on
 * sys.path: cwd and PYTHONPATH are the sidecar directory. Missing/old Python degrades to a warning.
 */
export async function extractPy(
  root: string,
  files: string[],
  opts: { python?: string | undefined; pythonPath?: string[] | undefined; djangoSettings?: string | undefined; apiClients?: string[] | undefined; useCache?: boolean } = {},
): Promise<PyExtractResult> {
  if (!files.some((f) => f.endsWith('.py'))) return empty();
  const python = opts.python ?? 'python3';
  const cwd = sidecarDir();
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: cwd, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONSTARTUP;
  delete env.PYTHONHOME;
  const req = JSON.stringify({ root, files, pythonPath: opts.pythonPath ?? [], useCache: opts.useCache !== false, ...(opts.djangoSettings ? { djangoSettings: opts.djangoSettings } : {}), ...(opts.apiClients?.length ? { apiClients: opts.apiClients } : {}) });

  const { code, stdout, stderr, spawnError } = await new Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }>((resolve) => {
    const child = spawn(python, ['-m', 'codebase_guide_sidecar'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: NodeJS.ErrnoException) => resolve({ code: null, stdout: '', stderr: '', spawnError: e }));
    child.on('close', (c) => resolve({ code: c, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => { /* child exited early; reported via close */ });
    child.stdin.end(req);
  });

  const pyCount = files.filter((f) => f.endsWith('.py')).length;
  if (spawnError) {
    return empty([{ code: 'py-python-missing', message: `"${python}" not found; ${pyCount} Python files were not analyzed. Install Python 3.9+ or set "python" in .codebase-guide/config.json.`, count: 1 }]);
  }
  if (code === 3) return empty([{ code: 'py-python-too-old', message: stderr.trim() || 'Python >= 3.9 required', count: 1 }]);
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    return empty([{ code: 'py-sidecar-failed', message: `Python sidecar exited with ${code}: ${tail}`, count: 1 }]);
  }
  const result = JSON.parse(stdout) as PartialGraph & { run: PyExtractResult['run'] };
  const warnings = [...result.warnings];
  const errLines = stderr.split('\n').filter((l) => l.trim());
  if (errLines.length) warnings.push({ code: 'py-sidecar-stderr', message: `Sidecar stderr: ${errLines[0]!.slice(0, 200)}`, count: errLines.length });
  const { run, ...graph } = result;
  return { graph: { ...graph, warnings }, run: { ...run, python } };
}
