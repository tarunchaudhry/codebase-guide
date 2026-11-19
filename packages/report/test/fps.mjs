// Canvas pan benchmark. Usage: node fps.mjs <report index.html> [zoom level 0-3]. Prints rendered nodes and frames/sec while dragging.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const [file, level = '2'] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto(pathToFileURL(file).href + '#/canvas'); await p.waitForSelector('#sec-canvas');
await p.selectOption('.toolbar select', level); await p.waitForSelector('.react-flow__node', { timeout: 60000 }); await p.waitForTimeout(3000);
const nodes = await p.$$eval('.react-flow__node', (x) => x.length);
const box = await p.$eval('.canvas-wrap', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await p.evaluate(() => { window.__f = 0; const t = () => { window.__f++; requestAnimationFrame(t); }; requestAnimationFrame(t); });
const t0 = Date.now(); await p.mouse.move(box.x, box.y); await p.mouse.down();
for (let i = 0; i < 120; i++) { await p.mouse.move(box.x + Math.sin(i / 10) * 300, box.y + Math.cos(i / 10) * 200); }
await p.mouse.up(); const secs = (Date.now() - t0) / 1000; const f = await p.evaluate(() => window.__f);
console.log(JSON.stringify({ level, renderedNodes: nodes, fps: Math.round(f / secs), secs }));
await b.close();
