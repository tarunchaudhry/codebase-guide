#!/usr/bin/env node
// Thin entry point: `node scripts/extract.mjs [path] [options]` → codebase-guide extract.
import { main } from '../dist/cli.mjs';
await main(['extract', ...process.argv.slice(2)]);
