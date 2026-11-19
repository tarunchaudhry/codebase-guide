# codebase-guide

A Claude Code plugin that turns a Node.js / TypeScript / Next.js or Python (Django, FastAPI, Flask) repo into an **interactive, offline, single-file HTML onboarding report**. It's written for a new joiner to read in an hour or two, and every explanation links to `file:line` evidence. Anything the plugin couldn't prove is visibly marked **inferred**.

```
/repo-map                      # free, deterministic: structure, routes, models, env, hotspots, canvas
/codebase-guide                # + Claude explanations (estimate first, asks when large)
/repo-flow "how an order is saved"
```

## Install

Requirements: Claude Code, **Node.js ≥ 22.18** (tested on 22.22 and 24.22 LTS), and `python3` ≥ 3.9 for Python repos (stdlib only). Without Python, Python files are skipped with a warning and the JS/TS side still works.

```sh
# from a clone (or use <owner>/<repo> once it's on GitHub)
claude plugin marketplace add /path/to/codebase-guide
claude plugin install codebase-guide@codebase-guide
```

There's no build or install step on the user side: `dist/` ships prebuilt, with zero runtime dependencies. Restart Claude Code (or run `/reload-plugins`), then open any repo and run a command.

For development: `claude --plugin-dir /path/to/codebase-guide`.

## Quick start

1. `cd your-repo && claude`
2. `/repo-map --open`. It takes seconds and makes no LLM calls.
3. `/codebase-guide --open`. It prints the estimated tokens and file reads, asks when that's over the threshold, then runs the explain agents.
4. Read `.codebase-guide/report/index.html`. Start with **Start Here → Suggested reading order**, then **Key Flows**.
5. Add `.codebase-guide/` to `.gitignore`, or commit `.codebase-guide/report/` on purpose if the team wants a shared copy.

## Pipeline

| Stage | What | LLM |
|---|---|---|
| Extract | ts-morph (TS/JS) + a stdlib-`ast` Python sidecar → `graph.json`: modules, symbols, calls, routes, models, env vars, scripts | no |
| Link | Frontend `fetch`/axios/ky/SWR/requests/httpx calls ↔ backend endpoints, as `http` edges (always inferred, with a confidence) | no |
| Analyze | PageRank/fan-in, entry points, reading order, hotspots, Tarjan cycles, unused-export candidates, test proximity, run-locally facts, flow candidates → `analysis.json` | no |
| Explain | Four subagents, bottom-up and cached: module summarizer → architecture writer, flow tracer, guide writer | yes |
| Validate | Rejects unknown node ids, missing paths and out-of-range lines. Forces `inferred` on unreferenced claims. Rejects any run command not found in a real file. Scores grounding per section | no |
| Render | One self-contained `index.html` (React, xyflow, ELK in a Web Worker, MiniSearch), or `--split` | no |

Extract, link and analyze output is **byte-identical across runs** (everything sorted, canonical JSON).

## Support matrix

| Language | Parser | Frameworks / ORMs understood |
|---|---|---|
| TypeScript / JavaScript (ESM + CJS) | ts-morph 28 (TS 6.0 API) with `allowJs` | Plain Node, Next.js (App + Pages Router, middleware, server actions, runtimes), Express, Fastify, NestJS, Prisma |
| Python 3.9+ | sidecar on stdlib `ast` | Plain Python, Django (+ DRF), FastAPI, Flask, SQLAlchemy declarative models, Pydantic |

Anything else falls back to the generic language-level graph. It never fails outright.

## Commands

| Command | Flags |
|---|---|
| `/codebase-guide [path]` | `--depth quick\|standard\|deep` (default `standard`), `--update` (incremental; the default behaviour), `--split`, `--no-snippets`, `--open` |
| `/repo-map [path]` | `--open`, `--split` |
| `/repo-flow "<description>"` | `--entry <file or "METHOD /path">` |

The same CLI works outside Claude Code: `node scripts/codebase-guide.mjs help` (`prepare`, `validate`, `render`, `map`, `flow`, `extract`, `analyze`).

## Config reference: `.codebase-guide/config.json` (all optional)

| Key | Type | Effect |
|---|---|---|
| `include` / `exclude` | glob[] | Limit or extend the files analyzed (defaults ignore `node_modules`, `.next`, `dist`, `build`, `coverage`, `.turbo`, venvs, stories, mocks) |
| `apiClients` | string[] | Your HTTP wrapper names, so their calls get linked to endpoints |
| `baseUrls` | string[] | URL prefixes stripped before matching |
| `djangoSettings` | string | Settings module when it can't be found statically |
| `pythonPath` | string[] | Extra Python import roots |
| `python` | string | Python executable (default `python3`) |
| `depth` | `quick`/`standard`/`deep` | Default depth |
| `maxFlows` | int | Override the number of auto-picked flows |
| `flows` | string[] | Flows to always trace, described in words |
| `audience` | string | Who's reading ("frontend dev joining payments"); tunes emphasis |
| `customConventions` | string | Things static analysis can't see (tenancy, runtime routing, DI tokens, queues) |
| `budget` | `{ maxFileReads, confirmAboveTokens }` | Per-agent read cap; confirmation threshold (default 300,000 tokens) |
| `snippets` | bool | Embed code snippets (default true) |
| `editorScheme` | `vscode`/`cursor`/`idea` | "Open in editor" links |

## Permissions

The plugin ships two hooks (`hooks/hooks.json`):
- **SessionStart:** a one-line notice when the repo has no report or it's stale. It never generates anything; opt out with `CODEBASE_GUIDE_NOTICE=0`.
- **PreToolUse (Write|Bash):** auto-approves exactly two things the orchestration needs:
  - explain agents writing their JSON to `<project>/.codebase-guide/explain/out/<id>.json`;
  - this plugin's own CLI (`node <plugin>/scripts/codebase-guide.mjs prepare|validate|render|map|flow …` with no shell metacharacters).

  Everything else gets no decision and goes through your normal permissions. Skill `allowed-tools` don't reach subagents, so without this you'd get a prompt per agent. The cost is a small node process on each Bash/Write call while the plugin is enabled.

## Privacy and secrets

- **Never executes the target repo:** no imports of user modules, no `django.setup()`, no app startup, no installs.
- **Never reads** `.env` or `.env.*` (except `.env.example`/`.env.sample`/`.env.template`), `*.pem`, `*.key`, `*.p12`, SSH keys, or credentials/secrets files. That's enforced in file listing, the validator and the snippet reader, and stated in every agent prompt.
- **Env vars:** the env section lists names and where they're read, never values. Example files contribute names only.
- **Snippets:** every snippet (≤ 15 lines) is scanned before embedding. The scan covers AWS/GitHub/GitLab/Slack/Stripe/Anthropic/OpenAI/Google/npm/SendGrid token shapes, JWTs, private keys, `scheme://user:pass@` URLs, secret-named assignments and high-entropy literals. Matches are replaced with `«redacted»`.
- **Banner:** the report says "Internal — contains source paths and snippets."
- **Offline output:** the report makes zero network requests when opened via `file://`; fonts and the layout engine are embedded.
- **Data flow:** the Explain stage sends source code to Claude through your Claude Code session, the same as asking Claude about the code yourself. `/repo-map` sends nothing.

## Cost model

- `/repo-map` costs no LLM tokens.
- `/codebase-guide` runs one module summarizer per folder unit (small folders are packed together up to 40 / 20 / 10 files for quick / standard / deep), one flow tracer per flow, and one architecture writer and one guide writer.
- Before anything runs it prints an estimate in two figures:
  - **input+output tokens** (including cache writes), which is what the confirmation threshold compares against;
  - the much larger total **including cache re-reads**, which agents incur as they loop and which is billed at a lower rate.
- The estimate is calibrated on measured fixture runs (×1.7 for input+output, ×10 including re-reads) and can be off by 2× either way.
  - Fixtures 06 and 09 at standard depth: ~200–270k input+output tokens, ~1–1.8M including re-reads, $2–3 on Opus.
- It asks for confirmation when the input+output estimate is over `budget.confirmAboveTokens` (default 300k). Declining renders the deterministic report.
- Every validated output is cached by a hash of its prompt version and inputs. A re-run regenerates only the units with changed files, the flows that pass through them, and the architecture and guide that depend on them.

## Known limitations

- Static analysis misses:
  - runtime-computed settings and URLconfs;
  - routes registered in loops or from config;
  - string-token DI and metaprogramming;
  - host/tenant dispatch;
  - queue/event hops unless configured.

  These appear only via `customConventions` and inferred items.
- Python call edges are shallower than TypeScript ones: there's no type inference, so dynamic dispatch is dropped and counted.
- Cross-language HTTP links and SQLAlchemy read/write edges are heuristic: always inferred or confidence-tagged.
- Claude summaries can still be wrong even when they cite code. The grounding score measures citation, not correctness.
- The report goes stale as code changes. The SessionStart hook says so, but `--update` has to be re-run.
- Django class-based views whose HTTP verbs all come from an in-repo base dispatcher are listed with method `*` (not statically known).
- Very large repos (thousands of files) produce single-file reports over 15 MB. The render step says so; use `--split`.
- Out of scope for v1: other languages, runtime tracing, cross-repo graphs, GraphQL/gRPC linking, architecture decision history.

## Development

```sh
pnpm install
pnpm build        # dist/cli.mjs + dist/report-template.html
pnpm test         # TS snapshots, determinism, routes/models, linker, analyzers, validator, Python sidecar, Playwright report smoke test
pnpm typecheck
pnpm validate     # claude plugin validate --strict
```

Layout: `packages/core` (schema, merge, linker, analyzers, explain planner, validator, redaction), `packages/adapter-ts`, `packages/adapter-py` (+ `sidecar/`), `packages/report` (React UI), `packages/cli`, `agents/`, `skills/`, `hooks/`, `fixtures/`. Notes: `docs/PLUGIN_FORMAT_NOTES.md`, `docs/DEVIATIONS.md`.

## License

MIT
