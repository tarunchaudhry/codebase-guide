#!/usr/bin/env node
// Thin entry point: `node scripts/validate.mjs [path] [options]` → codebase-guide validate.
import { main } from '../dist/cli.mjs';
await main(['validate', ...process.argv.slice(2)]);
