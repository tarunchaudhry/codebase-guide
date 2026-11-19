# Changelog

## 0.1.0 — 2026-10-12

First release.

- **Extract:**
  - TS/JS adapter (ts-morph): Next.js App and Pages routers, Express, Fastify, NestJS, Prisma.
  - Python sidecar (stdlib `ast`): Django + DRF, FastAPI, Flask, SQLAlchemy, Pydantic.
  - Per-file content-hash caches, so re-parsing covers changed files and their importers.
- **Link:** cross-language HTTP linker (fetch, axios, ky, SWR, requests, httpx, configured `apiClients`). Every link is inferred and carries a high/medium/low confidence.
- **Analyze:**
  - Centrality (PageRank and fan-in), entry points, reading order with reasons, hotspots.
  - Tarjan cycles, unused-export candidates, test proximity.
  - Run-locally facts with source lines, tech stack with versions, deterministic layers, flow candidates.
- **Explain:**
  - Four subagents (module summarizer, architecture writer, flow tracer, guide writer).
  - Cached by content hash; incremental re-runs; budget estimate with confirmation.
- **Validate:**
  - Checks node ids and `file:line`, forces `inferred`, and rejects invented run commands.
  - Recipes need ≥ 2 examples; conventions need ≥ 3 places.
  - Grounding scores per section; retry loop.
- **Render:**
  - Offline single-file React report covering all 16 sections.
  - Flow step-through with diagram and sequence views, call explorer, ER diagram, and a semantic-zoom canvas with an 800-node budget.
  - Search, light/dark, print stylesheet, secret-redacted snippets; `--split`.
- **Commands:** `/codebase-guide`, `/repo-map`, `/repo-flow`, plus a SessionStart notice for missing or stale reports.
