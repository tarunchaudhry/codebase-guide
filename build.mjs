// Builds everything users run, so installs need no build step:
//   dist/cli.mjs              one esbuild bundle (ts-morph + TypeScript included, zero runtime deps)
//   dist/report-template.html the single-file React report (Vite + singlefile), data injected at render time
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: { cli: 'packages/cli/src/main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  // CJS deps (ts-morph, typescript) use require(), __filename and __dirname.
  banner: {
    js: [
      "import { createRequire as __cgRequire } from 'node:module';",
      "import { fileURLToPath as __cgPath } from 'node:url';",
      'const require = __cgRequire(import.meta.url);',
      'const __filename = __cgPath(import.meta.url);',
      "const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));",
    ].join('\n'),
  },
});
execFileSync('pnpm', ['--filter', '@codebase-guide/report', 'run', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
copyFileSync('packages/report/dist/index.html', 'dist/report-template.html');
