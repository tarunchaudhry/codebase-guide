#!/usr/bin/env node
// Thin entry point: `node scripts/analyze.mjs [path] [options]` → codebase-guide analyze.
import { main } from '../dist/cli.mjs';
await main(['analyze', ...process.argv.slice(2)]);
