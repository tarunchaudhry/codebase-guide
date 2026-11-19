#!/usr/bin/env node
// PreToolUse hook (matcher: Write|Bash). Auto-approves exactly two things the /codebase-guide orchestration needs:
//   1. Write of an explain agent's JSON result to <project>/.codebase-guide/explain/out/<task-id>.json
//   2. Bash running this plugin's own CLI: node "<plugin>/scripts/codebase-guide.mjs" <prepare|validate|render|map|flow> [args]
//      with no shell metacharacters (so nothing can be chained onto it). That CLI never executes the target repo's code.
// Anything else gets no decision from this hook, so normal permission handling applies.
import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const real = (p) => { try { return realpathSync(p); } catch { try { return resolve(realpathSync(dirname(p)), p.split(sep).pop()); } catch { return resolve(p); } } };
const allow = (why) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: why } }) + '\n');

function writeOk(ev) {
  const file = ev.tool_input?.file_path;
  const project = process.env.CLAUDE_PROJECT_DIR || ev.cwd;
  if (typeof file !== 'string' || !project || file.includes('..')) return false;
  const target = real(resolve(project, file));
  const outDir = real(resolve(project, '.codebase-guide', 'explain', 'out'));
  return target.startsWith(outDir + sep) && /^[\w-]+\.json$/.test(target.slice(outDir.length + 1));
}

export function bashOk(command, scriptsDir = SCRIPTS) {
  if (typeof command !== 'string' || /[;&|`$<>\n\r\\]|\(|\)/.test(command)) return false;
  const m = /^node\s+("([^"]+)"|(\S+))\s+(prepare|validate|render|map|flow)(\s+[^]*)?$/.exec(command.trim());
  if (!m) return false;
  const script = m[2] ?? m[3];
  return real(script) === real(resolve(scriptsDir, 'codebase-guide.mjs'));
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const ev = JSON.parse(raw);
      if (ev.tool_name === 'Write' && writeOk(ev)) allow('codebase-guide explain output');
      else if (ev.tool_name === 'Bash' && bashOk(ev.tool_input?.command)) allow('codebase-guide CLI');
    } catch { /* no decision */ }
  });
}
