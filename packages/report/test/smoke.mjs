// Playwright smoke check for a generated report. Usage: node smoke.mjs <report index.html> [screenshotDir] [searchTerm]
// Exits non-zero on: console errors, any non-file:// request, a section that doesn't render, search miss, flow step-through failure.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [file, shots, term] = process.argv.slice(2);
const SECTIONS = ['start', 'run', 'architecture', 'directory', 'flows', 'modules', 'explorer', 'api', 'models', 'config', 'conventions', 'recipes', 'glossary', 'health', 'canvas', 'about'];
const url = pathToFileURL(file).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], network = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) network.push(r.url()); });
const fail = [];
await page.goto(url);
await page.waitForSelector('.sec-head');
if (shots) mkdirSync(shots, { recursive: true });
for (const s of SECTIONS) {
  await page.evaluate((h) => { location.hash = h; }, `#/${s}`);
  try { await page.waitForSelector(`#sec-${s}`, { timeout: 5000 }); } catch { fail.push(`section ${s} did not render`); continue; }
  if (s === 'canvas' || s === 'flows' || s === 'models') await page.waitForTimeout(1500);
  if (shots) await page.screenshot({ path: `${shots}/${s}.png`, fullPage: s !== 'canvas' });
}
if (term) {
  await page.evaluate(() => { location.hash = '#/start'; });
  await page.fill('.search input', term);
  try { await page.waitForSelector('.results li[role=option]', { timeout: 3000 }); } catch { /* checked below */ }
  const hits = await page.$$eval('.results li', (ls) => ls.map((l) => l.textContent ?? ''));
  if (!hits.some((h) => h.includes(term))) fail.push(`search for "${term}" found: ${hits.slice(0, 3).join(' | ') || 'nothing'}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}
await page.evaluate(() => { location.hash = '#/flows'; });
await page.waitForSelector('#sec-flows');
if (await page.$('.player')) {
  const pos = async () => (await page.textContent('.player .pos'))?.trim();
  const before = await pos();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const after = await pos();
  if (before === after && !/of 1$/.test(before ?? '')) fail.push(`flow step-through did not advance (${before})`);
  if (!(await page.$('.steps li[aria-current=step]'))) fail.push('no active flow step');
}
await browser.close();
console.log(JSON.stringify({ url, consoleErrors: errors, networkRequests: network, failures: fail }, null, 1));
process.exitCode = errors.length || network.length || fail.length ? 1 : 0;
