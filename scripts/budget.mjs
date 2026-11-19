#!/usr/bin/env node
// Thin entry point: `node scripts/budget.mjs [path] [options]` → codebase-guide prepare.
import { main } from '../dist/cli.mjs';
await main(['prepare', ...process.argv.slice(2)]);
