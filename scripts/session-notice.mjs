#!/usr/bin/env node
// SessionStart hook: prints one notice line when the report is missing or stale vs HEAD. Never generates anything.
// Kept dependency-free (no dist/ import) so it starts fast. Opt out with CODEBASE_GUIDE_NOTICE=0.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function notice(dir) {
  if (process.env.CODEBASE_GUIDE_NOTICE === '0' || !existsSync(join(dir, '.git'))) return undefined;
  const metaPath = join(dir, '.codebase-guide', 'report', 'meta.json');
  if (existsSync(metaPath)) {
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { return undefined; }
    let head;
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim(); } catch { return undefined; }
    if (meta.commit && head && meta.commit !== head) return `codebase-guide: report is stale (built at ${meta.commit.slice(0, 8)}, HEAD is ${head.slice(0, 8)}). Run /codebase-guide --update or /repo-map.`;
    return undefined;
  }
  const names = readdirSync(dir);
  const isProject = names.some((f) => ['package.json', 'pyproject.toml', 'manage.py', 'setup.py'].includes(f) || /^requirements.*\.txt$/.test(f));
  return isProject ? 'codebase-guide: no onboarding report for this repo yet. Run /repo-map (free, no LLM) or /codebase-guide.' : undefined;
}

try {
  const msg = notice(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
} catch { /* a notice must never break session start */ }
