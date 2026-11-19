---
name: using-codebase-guide
description: How to use and read codebase-guide reports, and how to answer follow-up questions about a repo from .codebase-guide/graph.json and the validated summaries instead of re-reading the code. Use when the user asks about a repo that has a .codebase-guide/ folder, or asks which codebase-guide command to run.
user-invocable: false
---

# Using codebase-guide

codebase-guide turns a Node.js / TypeScript / Next.js or Python (Django, FastAPI, Flask) repo into an offline, single-file HTML onboarding report. Everything lives in `<repo>/.codebase-guide/`.

## Which command, and what it costs

| Command | What it does | LLM cost |
|---|---|---|
| `/repo-map [path] [--open]` | Extract → link → analyze → render: structure, routes, models, env vars, hotspots, run-locally facts, graph-only flows, canvas. | None. Seconds on most repos. |
| `/codebase-guide [path] [--depth …] [--update] [--split] [--no-snippets] [--open]` | Adds Claude explanations: overview, architecture narrative, file/module summaries, traced flows, conventions, recipes, glossary. Each is checked against the graph. | Tokens. Prints an estimate first and asks when it's over the threshold. |
| `/repo-flow "<description>" [--entry <file or METHOD path>]` | Traces one flow you describe and adds it to the existing report. It's saved, so later runs keep it. | One flow-tracer agent. |

Depth modes for `/codebase-guide`:
- **`quick`:** folders grouped up to 40 files per summarizer, 2 symbols per file, ≤ 8 file reads per agent, 5 flows. Cheapest.
- **`standard`** (default): 20 files per summarizer, 4 symbols per file, ≤ 20 reads per agent, 8 flows.
- **`deep`:** 10 files per summarizer, 8 symbols per file, ≤ 40 reads per agent, 12 flows.

Re-runs are incremental by default (`--update` means the same thing). Summaries are cached by content hash in `.codebase-guide/cache/explain/`. Only changed files' units, the flows that pass through them, and the ancestors (architecture, guide) regenerate. `--no-cache` forces everything.

Suggest `/repo-map` first when someone just wants to look around or is worried about cost. Suggest `/codebase-guide --depth quick` on very large repos.

Nothing ever runs automatically. The SessionStart hook only prints a one-line notice when the report is missing or stale (opt out: `CODEBASE_GUIDE_NOTICE=0`).

## How to read the report

Open `.codebase-guide/report/index.html` (works from `file://`, no network). Left nav = 16 sections; `/` focuses search; every heading has a copy-link button; the URL hash deep-links sections and entities.

- **Start Here:** summary, tech stack with versions and source lines, counts, and the suggested reading order. The order is computed (entry-point-ness × PageRank/fan-in, with a penalty for long files); Claude only polishes the reasons.
- **Run It Locally:** only commands found in real files (package.json, Makefile, compose, Procfile, pyproject, manage.py, lockfiles, README), each linked to its line. An empty section means none were found. It never guesses.
- **Architecture:** layer lanes, the narrative (each paragraph cites nodes), and how the projects talk to each other.
- **Directory Map / Modules:** grey text is graph-derived; normal text is a Claude summary.
- **Key Flows:**
  - Step through with ← / → or Play. The step is highlighted in both the diagram and the sequence view.
  - "graph only" flows are deterministic DFS traces with no story.
- **Function Explorer:** callers ← → callees (expand to depth 3), a neighborhood graph and "show in full canvas".
- **API / Routes:** method, full path, handler, middleware/guards/deps chain, schemas, and frontend callers with linker confidence. Low-confidence links are hidden by default.
- **Data Models:** ER diagram; which endpoints read and write each model.
- **Config & Env:** env var names and where they're read. Values are never shown.
- **Conventions / How Do I…? / Glossary:**
  - A pattern seen in 3 or more places is a "convention"; fewer is "observed rarely".
  - Recipes exist only for tasks with ≥ 2 real examples.
- **Health:** fan-in hotspots, big files and functions, complexity, cycles, unused-export *candidates*, untested files.
- **Canvas:** semantic zoom L0 (projects) → L3 (symbols). Click clusters to expand; there's an 800-node budget; filters cover edge kind, language, framework, role family and HTTP confidence.
- **About:** commit, depth, coverage, grounding per section, warnings, limitations.

**Trust signals:**
- `inferred` pill or dashed outline: not proven by static analysis or a code citation. Hover it for the reason.
- Grounding meters show the % of claims that cite a node id or file:line. That measures citation, not correctness.
- Every `file:line` opens your editor (`editorScheme` in config).

## Tuning via `.codebase-guide/config.json`

All keys are optional. Unknown or invalid keys are ignored, with a warning in the output.

```json
{
  "audience": "frontend dev joining the payments team",
  "flows": ["how a refund is issued", "nightly invoice job"],
  "customConventions": "Tenants are resolved from the Host header in middleware/tenant.ts; queue hops go through jobs/publish.ts",
  "apiClients": ["apiClient", "http"],
  "baseUrls": ["https://api.example.com", "/api/v1"],
  "djangoSettings": "config.settings.dev",
  "pythonPath": ["src"],
  "python": "python3.12",
  "depth": "standard",
  "maxFlows": 10,
  "include": ["apps/**", "packages/**"],
  "exclude": ["**/generated/**"],
  "budget": { "maxFileReads": 15, "confirmAboveTokens": 200000 },
  "snippets": true,
  "editorScheme": "vscode"
}
```

- `audience`: shifts emphasis and ordering in every agent's output.
- `flows`: free-text flows that are always traced (in addition to the auto-picked ones).
- `customConventions`: things static analysis can't see (host-based multi-tenancy, runtime routing, DI by string tokens, queue hops). They show up as conventions marked inferred.
- `apiClients`: names of your HTTP wrapper functions/objects, so `apiClient.get('/users')` gets linked to endpoints.
- `baseUrls`: prefixes stripped before matching URLs to endpoints.
- `djangoSettings` / `pythonPath`: when settings or import roots can't be found statically.

## What static analysis misses, and how to compensate

| Blind spot | Symptom | Fix |
|---|---|---|
| Routes registered in loops / from config | Missing endpoints, or `(prefix unknown)` | Add the flow to `flows`; describe it in `customConventions` |
| Runtime-computed settings / URLconfs | Django warnings in About | Set `djangoSettings` |
| DI by string tokens, metaprogramming, decorators that register | Missing `injects`/`calls` edges | `customConventions`; `/repo-flow` with `--entry` |
| Host/tenant dispatch, queues, events | Flows stop at a publish call | `customConventions`; trace the consumer with `/repo-flow` |
| Custom HTTP wrapper | No frontend → backend links | `apiClients`, `baseUrls` |
| Python dynamic dispatch (no type inference) | Shallower Python call trees | Expected; check `py.callsDynamic` in the warnings |

Unused-export candidates can be false positives when code is used dynamically, by string name, or by external consumers.

## Answering follow-up questions in chat

Prefer the artifacts over re-reading the repo. They're deterministic and cheap to grep.

| File | Contents |
|---|---|
| `.codebase-guide/graph.json` | `nodes[]` (`id`, `kind`, `label`, `path`, `line`, `meta`) and `edges[]` (`kind`, `source`, `target`, `evidence`, `inferred`, `meta.confidence`/`order`/`prefix`) |
| `.codebase-guide/analysis.json` | metrics, entry points, reading order, hotspots, cycles, unused candidates, untested, flow candidates, run facts, stack, layers |
| `.codebase-guide/explain/validated.json` | ref-checked summaries: `modules`, `files`, `symbols`, `architecture`, `flows`, `guide`, `grounding` |

Node ids look like `ts:function:src/lib/db.ts#query`, `py:endpoint:app/routers/users.py#create_user`, `config:env-var:DATABASE_URL`.

Recipes for common questions (use Grep/Read on the JSON; `jq` if available):
- **"Where is X handled?"** Find the `endpoint` node whose `meta.http.fullPath` matches; follow its `handles` edge to the handler, and `middleware-chain` edges (sorted by `meta.order`) for guards.
- **"Who calls f?"** Look for edges with `target` = f's id and `kind` in `calls`/`renders`/`injects`/`handles`. For "what does f call?", look at edges with `source` = f's id.
- **"Where is auth enforced?"** Look at `middleware-chain` and `injects` edges to nodes named like auth/guard/permission/current_user, then the endpoints they attach to.
- **"How does an order get saved?"** Find `writes-model` edges to the Order model. Walk `calls`/`injects` backwards to an endpoint, or check `validated.json` `flows`.
- **"Which env vars matter?"** Look at `env-var` nodes and their incoming `reads-env` edges (evidence = file:line).
- **"How do I run it?"** Use `analysis.json` `facts.run` (each has `source.path`/`line`).

Answer with `file:line` citations from `evidence`/`path`/`line`. Say "inferred" when the edge is `inferred` or has `confidence` below high. If the graph has no edge for something, say so instead of guessing; then read the specific file. If HEAD has moved since the report (About shows "stale"), mention it and suggest `/codebase-guide --update` or `/repo-map`.

## Privacy

- **Never read:** `.env*` (except `.env.example`/`.env.sample`/`.env.template`), `*.pem`, `*.key` or credentials files.
- **Never run:** the target repo's code (no imports, no `django.setup()`, no installs).
- **Snippets:** each is ≤ 15 lines and secret-scanned (token prefixes, credential URLs, high-entropy strings) before embedding.
- **The report** carries an "Internal — contains source paths and snippets" banner.
- **Git:** gitignore `.codebase-guide/`, or commit `report/` only on purpose.
