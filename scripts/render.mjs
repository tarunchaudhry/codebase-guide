#!/usr/bin/env node
// Thin entry point: `node scripts/render.mjs [path] [options]` → codebase-guide render.
import { main } from '../dist/cli.mjs';
await main(['render', ...process.argv.slice(2)]);
