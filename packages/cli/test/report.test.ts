import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from '@codebase-guide/core';
import { runAnalyze } from '../src/analyze.ts';
import { renderReport } from '../src/render.ts';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');
const SMOKE = join(import.meta.dirname, '../../report/test/smoke.mjs');
const copy = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cg-')), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true, filter: (src) => !src.includes('.codebase-guide') });
  return dir;
};
const opts = { deterministic: true, split: false, snippets: true, open: false, editorScheme: 'vscode' as const, depth: 'standard' };

test('redaction: token prefixes, credential URLs, secret assignments, high-entropy literals', () => {
  const r = redact([
    "const key = 'AKIAIOSFODNN7EXAMPLE';",
    `gh = "ghp_${'a1B2'.repeat(9)}"`,
    'url = "postgres://admin:hunter2@db:5432/app"',
    'password: "s3cr3t-pass"',
    'jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"',
    'const label = "user-profile-settings-page";',
    "type='password'",
  ].join('\n'));
  const lines = r.text.split('\n');
  assert.equal(lines[0], "const key = '«redacted»';");
  assert.equal(lines[1], 'gh = "«redacted»"');
  assert.equal(lines[2], 'url = "postgres://«redacted»@db:5432/app"');
  assert.equal(lines[3], 'password: "«redacted»"');
  assert.equal(lines[4], 'jwt = "«redacted»"');
  assert.equal(lines[5], 'const label = "user-profile-settings-page";', 'ordinary strings survive');
  assert.equal(lines[6], "type='password'");
  assert.ok(r.count >= 5);
});

test('render: secrets never reach the report; snippets are redacted', async () => {
  const dir = copy('10-pnpm-workspace');
  writeFileSync(join(dir, 'apps/api/src/db.js'), `${readFileSync(join(dir, 'apps/api/src/db.js'), 'utf8')}\nconst STRIPE = 'sk_live_${'x9Y8'.repeat(6)}';\n`);
  await runAnalyze(dir);
  const r = renderReport(dir, opts);
  const html = readFileSync(r.path, 'utf8');
  assert.ok(!html.includes('do-not-read-me'), '.env values must never be embedded');
  assert.ok(!html.includes('sk_live_x9Y8'), 'snippet secret must be redacted');
  assert.ok(html.includes('«redacted»'));
  assert.ok(html.includes('contains source paths and snippets'), 'banner text is in the template');
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html) && !/<link[^>]+href=["']https?:/i.test(html), 'no CDN references');
  assert.ok(existsSync(join(dir, '.codebase-guide/report/meta.json')));
});

test('render --split writes index.html + assets/ + data/', async () => {
  const dir = copy('07-fastapi-sqla');
  await runAnalyze(dir);
  renderReport(dir, { ...opts, split: true });
  const out = join(dir, '.codebase-guide/report');
  assert.ok(existsSync(join(out, 'assets/app.css')) && existsSync(join(out, 'data/report-data.js')));
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('src="data/report-data.js"') && !html.includes('id="cg-data"'));
});

test('report smoke (Playwright): loads via file://, zero network, no console errors, all sections, search, flow step-through', async (t) => {
  let chromium: unknown;
  try { chromium = (await import('playwright')).chromium; execFileSync('node', ['-e', "require('fs').accessSync(require('playwright').chromium.executablePath())"]); } catch { t.skip('Playwright Chromium not installed (pnpm exec playwright install chromium)'); return; }
  void chromium;
  for (const [name, term] of [['09-polyglot', 'get_user'], ['07-fastapi-sqla', 'create_user'], ['06-django-drf', 'OrderViewSet']] as const) {
    const dir = copy(name);
    await runAnalyze(dir);
    const r = renderReport(dir, opts);
    let out: string;
    try { out = execFileSync('node', [SMOKE, r.path, '', term], { encoding: 'utf8', timeout: 120_000 }); } catch (e) { out = String((e as { stdout?: string }).stdout ?? e); }
    const res = JSON.parse(out.slice(out.indexOf('{')));
    assert.deepEqual({ consoleErrors: res.consoleErrors, networkRequests: res.networkRequests, failures: res.failures }, { consoleErrors: [], networkRequests: [], failures: [] }, name);
  }
});
