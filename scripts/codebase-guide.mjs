#!/usr/bin/env node
// Entry point used by the skills: `node scripts/codebase-guide.mjs <command> [path] [options]` (see `help`).
import { main } from '../dist/cli.mjs';
await main(process.argv.slice(2));
