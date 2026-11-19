# Deviations from the build spec

Plugin-format deviations are in [PLUGIN_FORMAT_NOTES.md](PLUGIN_FORMAT_NOTES.md). This file tracks the rest.

## Phase 2a
- **Cache location:** `.codebase-guide/cache/`, not `.repo-canvas/cache/`. The spec also says all output goes to `.codebase-guide/`, so one folder covers both.
- **Schema addition:** `meta.exported?: boolean`. Phase 3's unused-export analysis needs to know a symbol's public surface, and recomputing it from source would break "query the graph first".
- **Workspace and project nodes are level 0.** The spec allows `0 | 1 | 2 | 3`, and both are top-level containers. `module-group` = 1, `module` = 2. Symbols, env vars and scripts = 3.
- **Env-var and script node IDs** use the `config` language: `config:env-var:NAME`, `config:script:<package.json>#<name>`. Env vars have no single path.
- **Symbol granularity:** nodes are created for these:
  - top-level functions and arrow/function consts, including wrapped ones like `memo(() => …)`
  - classes and their methods/accessors/arrow properties
  - `export default` functions
  - CommonJS `exports.x = fn`, `module.exports = fn | { a: fn, b() {} }`

  Nested functions are not nodes. Calls inside them are attributed to the enclosing top-level symbol.
- **Same-name symbols in one file** get `#name~2`, `#name~3` in source order, instead of a line number, so IDs survive edits above them.
- **Type-only imports** (`import type`, `export type … from`) produce no `imports` edge. They are counted in `stats["ts.typeOnlyImports"]`. This keeps cycles and centrality about runtime structure.
- **Asset imports** (`.css`, `.svg`, `.json`, …) are counted (`ts.assetImports`), not linked and not warned about.
- **Call classification** (`stats`):
  - `ts.callsResolved` → edges
  - `ts.callsExternal` → outside the repo, including package-rooted callees whose types aren't installed
  - `ts.callsToNonSymbol` → internal but not a node, e.g. a local closure
  - `ts.callsUnresolved` → dropped and warned. The callee type is unknown, usually untyped JS or missing `node_modules`.
- **Evidence** is capped at 5 locations per edge, the first 5 by `(path, line)`. `weight` still counts every occurrence.
- **File listing** uses `git ls-files -co --exclude-standard` when inside a work tree, so `.gitignore` is respected; otherwise it walks the tree. The secret-path guard applies either way.
- **`graph.json` is compact JSON** (canonical, sorted keys). Snapshots are indented for review.
- **Dist bundle** is `dist/extract.mjs`, about 14 MB unminified because it includes the TypeScript compiler. Kept unminified so stack traces stay readable. Minify later if size matters.

## Phase 2b (Python sidecar)
- **No `tomllib`:** one minimal line-based TOML reader runs on every Python version, so output is byte-identical across 3.9 and 3.14 (verified on the fixture). It reads only `[project]`, `[tool.poetry]` and their `scripts` tables as simple `key = "value"` lines. Full dependency parsing for the tech stack happens in Node (Phase 3).
- **Determinism across Python versions:** guaranteed per interpreter version. Signatures come from `ast.unparse`, which can print rare constructs (some f-strings) differently between versions.
- **Schema addition:** `meta.decorators?: string[]`, qualified through the import table where the root is an import (`@login_required` becomes `django.contrib.auth.decorators.login_required`), otherwise as written (`@router.get`, where `router` is a module variable). Phase 2d needs it, and the report shows it.
- **Sidecar owns its cache:** `.codebase-guide/cache/py-extract.json`. Pass 1 *shapes* (defs, classes, bindings, vars, `__all__`, star imports) have no line numbers.
  - An edit that leaves a file's shape unchanged re-parses only that file.
  - A shape change re-parses importers transitively.
  - A changed file *set* re-runs pass 2 for every file, while pass-1 shapes stay cached.
- **Duplicate top-level names** (`if win32: class Lock … else: class Lock …`): the first definition gets `#Lock`, later ones get `#Lock~2`. Cross-module references resolve to the first. `self.x()` resolves within the exact definition.
- **Call classification** (`stats`):
  - `py.callsResolved` → edges
  - `py.callsExternal` → stdlib, third-party or builtins
  - `py.callsViaExternalStarImport` → a name missing from a module that does `from <external> import *`. No edge, no warning.
  - `py.callsDynamic` → method calls on locals, attributes of module-level variables, shadowed names. Dropped and counted per spec, *not* warned: they are the normal case in Python, and a warning for each would bury real problems.
  - `py.callsUnresolved` → the name is bound by nothing visible. Dropped and warned.
- **`os.environ.setdefault(...)` counts as an env reference** (it reads and sets). This matters for `DJANGO_SETTINGS_MODULE`.
- **Interpreter isolation:** cwd and `PYTHONPATH` are the sidecar directory, with `PYTHONNOUSERSITE=1` and `PYTHONSTARTUP`/`PYTHONHOME` removed. Nothing from the target repo is ever on `sys.path`.

## Phase 2c (JS/TS frameworks)
- **Architecture:** framework facts are collected per file from the AST and cached with the file. A global pass without AST builds the framework graph on every run. Warm runs never need ts-morph, and a re-parse of one file still updates cross-file results such as prefixes and chains.
- **Edge direction:**
  - `endpoint —handles→ handler`
  - `endpoint —middleware-chain→ middleware` (`meta.order` = execution order)
  - `parent —mounts→ child` (`meta.prefix` = literal prefix)

  Flows start at the endpoint and follow its outgoing edges.
- **Inline handlers** (`app.get('/x', (req, res) => …)`, `use(fn)`, `register(async (i) => …)`, `addHook`) become anonymous function nodes named after the registration (`GET /health`, `GET /:id [1]` for leading inline middleware, `plugin`, `hook onRequest`), with role `route-handler`/`middleware`/`plugin`. Nested `'use server'` functions become nodes with role `server-action`.
- **`fullPath` is set only when a router/plugin is reachable from an app through exactly one mount chain.** Otherwise it's left unset, with a warning (`http-multi-mount`, `http-unmounted-router`). We never pick one.
- **Express middleware order:** app/router `use()` calls registered *before* the route (or mount) in the same file, filtered by path scope (`app.use('/admin', mw)` applies only under `/admin`), then leading route handlers. External middleware (`express.json()`) can't be a node. It is counted in `stats["http.externalMiddleware"]` and still takes a slot in `order`.
- **Fastify:** `addHook` request-phase hooks (`onRequest` → `preParsing` → `preValidation` → `preHandler`) apply to the plugin and its children whatever order they were registered in; route-level hook options come after. `fastify-plugin`'s skipping of encapsulation is not modeled.
- **NestJS:**
  - `@Module` imports, controllers and providers are `mounts` edges.
  - Constructor injection by class type gives `injects`; `@Inject('TOKEN')` gives a `nest-token-injection` warning.
  - Chain order: global → class → method guards, then interceptors, then pipes. A single literal `setGlobalPrefix()` is applied; more than one is ignored with a warning.
- **Next.js:**
  - **Node types:** pages are `route` nodes (role `page`). App Router `route.ts` exports and `pages/api/*` are `endpoint` nodes. Module roles are `page | layout | template | loading | error | global-error | not-found | default | route | middleware | app | document | error`.
  - **Routing rules:**
    - `_private` folders are skipped.
    - Route groups are dropped from the URL.
    - `@slot` and interception show in the label: `/dashboard (@analytics)`, `/photo/[id] (intercepting)`.
    - `route-child` = nearest layout → child file; `route.ts` is excluded.
  - **`proxy.ts` (Next 16's rename of `middleware.ts`) is supported.**
  - **The matcher is tested against route *templates*,** so those `middleware-chain` edges are `inferred: true`. With no matcher the edges are not inferred.
  - **Pages API methods** come from `req.method === 'X'` / `switch (req.method)`, otherwise `*`.
  - **Runtime:**
    - `'use client'` and its imports → `client`.
    - Server entries and their imports up to a client boundary → `server`.
    - Reached from both sides → `shared`. `runtime = 'edge'` and middleware → `edge`.
    - `'use server'` modules are always `server`.
    - Pages Router pages are seeded on both sides (SSR + hydration), so their imports read `shared`, even code used only in `getServerSideProps`.
- **Prisma:**
  - **Models:** `config:model:<schema>#Name`, with fields, relations (`many`, `one (fk: x)`) and `///` docs; `model-relation` edges.
  - **`<client>.<delegate>.<op>()`** links to the model whose lower-camel name matches the delegate. It is `inferred` unless the client provably comes from `new PrismaClient()` or is typed `PrismaClient`/`PrismaService`.
- **`projects[].frameworks` needs code evidence,** not just a `package.json` dependency. Declared-but-unused frameworks are counted in `stats["frameworks.declaredButUnused"]`.
- **`routeTable()`** (core) produces the canonical `METHOD fullPath → handler [chain]` lines used by tests and, later, the report. A `?` suffix marks an inferred chain edge.

## Phase 2d (Python frameworks)
- **Models stay `class` nodes with a role.**
  - Roles: Django/SQLAlchemy `meta.role = "model"` (Django abstract bases: `"abstract-model"`), Pydantic `"schema"`, `BaseSettings` `"settings"`, DRF `"serializer"`/`"viewset"`, Django/DRF `"view"`.
  - Fields go in `meta.fields`.
  - Kind `model` is used only for Prisma, which has no class node. The report treats `kind == "model" || meta.role == "model"` as a model.
- **Django settings:**
  - **Evaluation:** literal-only, statically. Star imports are followed first (split `base.py` + `dev.py`), then `=` and `+=`. A non-literal value gives `django-settings-dynamic` and extraction continues.
  - **Lookup order:** `os.environ.setdefault("DJANGO_SETTINGS_MODULE", "…")` literal, then config `djangoSettings`, then a heuristic (shortest `*.settings` module), which warns `django-settings-guessed`.
- **Django URLs:**
  - **Walk:** `path`/`re_path`/`url` and `include("mod")`/`include(router.urls)`, with prefix accumulation. `re_path` keeps its regex with `^`/`$` stripped. `admin.site.urls` and other external includes are counted.
  - **Methods:** FBVs are `*` unless `@api_view([...])`, `@require_http_methods`, `@require_GET`/`POST`/`safe`. CBVs = handlers defined on the class or its internal bases, plus a table of Django/DRF generic views.
  - **Chain:** settings `MIDDLEWARE` in order (external entries take a slot but have no edge), then DRF `permission_classes`. `authentication_classes` and `REST_FRAMEWORK` defaults are not modeled.
- **DRF routers:** one endpoint per (path, method), e.g. `products/` and `products/<pk>/`, with `lookup_field` honored, plus `@action(detail, methods, url_path)`. The handler is the action method when the class defines it, otherwise the viewset class.
- **Other Django edges:** `serializer_class`/`Meta.model` give `serializes`, `queryset` gives `reads-model`, `@receiver(sender=Model)` gives an *inferred* `calls` edge from model to handler, and `management/commands/<name>.py` gives a script node `python manage.py <name>` that `handles` `Command.handle`.
- **FastAPI:**
  - **Middleware chain = execution order** (the last `add_middleware`/`@app.middleware` runs first).
  - **Injection:** `Depends`/`Security` in params (incl. `Annotated[…]`) gives `injects` from the function. Route/router/`include_router` `dependencies=[…]` gives `injects` from the endpoint.
  - **Validation:** `response_model` gives `validates` from the endpoint; Pydantic-typed params give `validates` from the handler.
- **Flask:** methods default to `GET`. The chain is app `before_request` → blueprint `before_request` → then `after_request` hooks, in registration order. Flask actually runs `after_request` in reverse; this ordering is a simplification. `register_blueprint(url_prefix=…)` *replaces* the blueprint's own `url_prefix`. Factory-local `app = Flask()` is supported.
- **SQLAlchemy:**
  - **Model detection:** subclasses of `DeclarativeBase`, `declarative_base()` vars, or flask-sqlalchemy `db.Model`, *and* having `__tablename__` or column fields. The default table name is snake_case of the class.
  - **Read/write edges:** `select/insert/update/delete(Model)` from `sqlalchemy` and `Model.query…` are confident. `session.query/get/scalars/add(Model(...))` are **inferred**, because the session object isn't provably a SQLAlchemy session.

## Phase 2e (HTTP linker)
- **Edge kind `http` (caller → endpoint),** always `inferred: true`, with `meta.confidence`. `fetches` is reserved and unused. Outbound calls are not stored in `graph.json`, only the resulting edges and `stats["http.*"]`.
- **Clients:**
  - **TS:** global `fetch`/`window.fetch` (not a repo-local `fetch`), axios (`axios()`, `.get…`, `.request`, `axios.create({baseURL})` instances resolved across files), ky (+ `create`/`extend` `prefixUrl`), `useSWR(key)`.
  - **Python:** `requests`/`httpx` module calls, `request(method, url)`, `Session()`/`Client()`/`AsyncClient(base_url=…)` from assignments or `with`.
  - **Config `apiClients`:** callee names `X` (fetch-like) or `X.<verb>`.
- **URL templates** come from literals, template literals and f-strings (holes → `{param}`), `+` chains, same-module/imported `const` strings, `new URL(x)`, `urljoin(base, x)`. A leading non-literal before `/` is a *dynamic base*. Anything else is fully dynamic: counted (`http-dynamic-url`), never linked.
- **Matching** is segment-wise, ignoring query, fragment and trailing slash. Every param style (`{id}`, `:id`, `[id]`, `<int:id>`, `(?P<pk>…)`) is one param; catch-alls match the rest.
  - `localhost`/`127.0.0.1` and configured `baseUrls` are stripped; other absolute hosts are **external** (counted, not linked).
  - **Confidence:** candidates are ranked by raw specificity (high > medium > low), *then* capped to `medium` when the base is dynamic or the method unknown. All endpoints at the best level get linked. More than 3 `low` ties are skipped (`http.ambiguousLow`).

## Phase 3 (analyzers)
- **Reading order formula:** `score = entryness × (0.15 + centrality) × locPenalty`.
  - `centrality = 0.6·PageRank_norm + 0.4·fanIn_norm`, with PageRank over imports+calls.
  - `entryness = 2` for entry points, else 1; ×1.3 when the file defines a model/router/app/middleware/settings/etc.
  - `locPenalty = 1/(1 + max(0, loc−200)/400)`.
  - The 0.15 floor stops a zero-fan-in entry (a page) scoring 0.
  - Two diversity caps (≤ 3 files per folder, ≤ 3 pages) keep a big page tree from filling the top 10.
- **Unused-export candidates:**
  - We have no symbol-level import table, so an exported symbol counts as "used" if any graph edge references it, *or* its name appears in a module that imports its module, *or* it appears more than once in its own module (base classes).
  - This is conservative: an aliased or re-exported-then-unused name slips through as used.
  - Decorated symbols and framework-role symbols (views, models, serializers, controllers, providers, server actions…) are never candidates.
- **Run-locally facts:**
  - Install steps come from lockfiles (`pnpm-lock.yaml`/`pnpm-workspace.yaml` → `pnpm install`, `package-lock.json` → `npm install`, `poetry.lock`, `uv.lock`, `requirements*.txt` …). Without any JS lockfile, top-level `package.json` files get `npm install`.
  - `manage.py` contributes Django's built-in `runserver`/`migrate`/`test`, sourced to `manage.py:1`.
  - Prisma/Alembic migrate commands are **not** synthesized unless a script/Makefile/README has them (the spec lists only those sources).
  - When the same command appears in several sources, a structured source (package.json, Makefile, compose) wins over the README.
- **Tech stack:** a curated list of known frameworks/libraries/tools (not every dependency), with versions resolved from package-lock/pnpm-lock/yarn.lock/poetry.lock/uv.lock and the declared range kept alongside.
- **Layers:** the analyzer also assigns deterministic layers (UI / API-routes / Services / Data) from roles and folder names, so the architecture diagram exists without the LLM. The architecture writer may refine it.
- **Flow candidates:**
  - BFS over the spec's edge kinds (plus renders/uses-hook/server actions for UI flows), depth ≤ 6, ≤ 60 nodes.
  - `score = reach + 1.5·depth + 3·writes + 2·auth + 2·http + 1·(endpoint|page)`.
  - One slot each is reserved for auth (an auth-named entry beats one that only passes auth middleware), the main write path and a background job; the rest go by score. Near-duplicates (Jaccard ≥ 0.85) are dropped.
  - Counts: quick 5, standard 8, deep 12 (`maxFlows` overrides).

## Phase 4 (explain + validate)
- **Cache location:** `.codebase-guide/cache/explain/<key>.json`. The spec says `.repo-canvas/cache/`, which looks like a leftover name; everything else lives in `.codebase-guide/`.
- **Units:** module-summarizer runs per *unit*, not per raw folder.
  - Units are folders whose subtree has ≤ N summarizable files (quick 40 / standard 20 / deep 10); bigger folders split by child folder, then by chunks.
  - Tests, `.d.ts` and empty files aren't summarized; the report shows a graph-derived one-liner for them.
- **Cache keys:**
  - Module units: prompt version + depth + audience + file paths and content hashes + the chosen symbol ids. Cross-unit metrics (fan-in) are deliberately excluded, so an edit elsewhere doesn't invalidate a unit.
  - Stage-2 tasks (architecture, guide) include the module units' keys, which is how "changed file → its unit → ancestors" propagates.
  - Flows key on their slice plus the hashes of the files they touch.
  - Requested flows (`config.flows`, `/repo-flow`) key on every module hash, because they aren't anchored to a slice up front.
- **Subagent writes:** the skill's `allowed-tools` does **not** cover subagents (verified: the summarizer's Write was denied in `claude -p`).
  - The plugin ships a narrowly scoped `PreToolUse` hook (`scripts/allow-explain-write.mjs`). It auto-approves only `Write` to `<project>/.codebase-guide/explain/out/<id>.json`, resolved through symlinks, and gives no decision for anything else.
  - Without it, users would get one permission prompt per agent.
- **Grounding rules:**
  - File and symbol one-liners are grounded by their own node id.
  - A module purpose is grounded when it cites ≥ 1 key file.
  - Flow stories aren't scored as claims; their steps are.
  - A step is backed by a graph edge from *any* earlier step (fan-out: middleware, then handler), or by its own evidence. Edge evidence is attached automatically.
- **Narrative length:** the 300–600 word range is enforced as 600 max and `min(300, 100 + 15 × modules)` minimum, so tiny repos aren't asked to pad (the spec warns against filler).
- **Retries:**
  - "Max 2 retries": a task gets 3 attempts in total, tracked in `explain/state.json`. After that (or with `--final`), the cleaned valid parts are kept and cached, and the errors are logged in About.
  - `customConventions` items may have zero examples (`"source": "config"`) and are shown as inferred.
- **Token measurement:** the plan prints a heuristic estimate. Actual usage is whatever Claude Code reports for the session (e.g. `--output-format json` in headless runs); the plugin can't read subagent token counts itself.

## Phase 5 (report UI)
- **Versions:** React 19.3.0, @xyflow/react 12.12.0, elkjs 0.12.0, MiniSearch 7.2.0, Vite 8.3.4 (Rolldown), vite-plugin-singlefile 2.3.3, @vitejs/plugin-react 6.1.2. Fonts are Literata, IBM Plex Sans Condensed and IBM Plex Mono via @fontsource 5.3.0, latin subset, inlined.
- **ELK worker:** one inlined copy of `elk-worker.min.js`. It runs in a Web Worker from a blob URL when the browser allows it, otherwise it's evaluated in-thread. That avoids shipping elk twice; a probe layout decides which.
- **`--split` layout:**
  - `index.html` keeps the app as an *inline* module script; CSS goes to `assets/app.css`; data goes to `data/report-data.js` (`window.__CG_DATA__ = …`).
  - Spec deviation: data is `data/*.js`, not `data/*.json`, and the JS isn't in `assets/`. Chrome blocks `fetch()` and module `<script src>` under `file://`, so JSON or external module files wouldn't load offline.
- **Snippet budget:** snippets are capped at ~6 MB per report, filled in priority order (flow steps, recipes/conventions, endpoint handlers, reading order, symbols by fan-in, file heads). Locations past the budget show "no snippet embedded" plus a file:line link.
- **Canvas:**
  - "Semantic zoom" is a level selector (L0 projects → L3 symbols) plus click-to-expand clusters, not continuous zoom-driven expansion.
  - Env-var and script nodes are hidden by default (toggle the `config` language filter).
  - "Per-cluster cached layout" is a layout cache keyed by the visible node/edge set.
- **Flow views:** the diagram is a layered ELK graph whose edges go from each step's parent (the latest earlier step with a graph edge into it). The sequence view uses modules as participants.

## Phase 6 (commands + hook)
- **Commands:**
  - `/codebase-guide` default runs are already incremental (cached); `--update` is accepted as the same thing.
  - `/repo-flow` requests persist in `explain/requested.json`, so later full runs keep them.
- **Hooks:** two, both in `hooks/hooks.json`.
  - SessionStart (`startup` only): `scripts/session-notice.mjs`, dependency-free so it starts fast. It shows "missing" only in git repos with a Node/Python project marker and "stale" when `report/meta.json` commit ≠ HEAD; opt out with `CODEBASE_GUIDE_NOTICE=0`.
  - PreToolUse(Write): the explain-output auto-approval above.

## Phase 8 hardening (found on the real repos)
- **Django URLconfs:** `include(<imported urls module>)` resolves to that module before trying the DRF `router.urls` reading.
  - Views written as `Foo.as_<anything>_view()` or wrapped inline (`csrf_exempt(login_required(View.as_view()))`) resolve to the class.
  - On kukufm-py this took endpoints from 1 to 1,030, all with handlers.
- **HTTP methods:** when every verb a class-based view answers comes from an in-repo base dispatcher (the class defines none itself, the base defines ≥ 4), the endpoint is listed as `*` (method not statically known) instead of claiming all of them.
- **Python `SyntaxWarning`s** from parsing the target's code are suppressed. They aren't ours, and they made cold and warm runs report different warnings.
- **Units:** when a folder exceeds the unit cap, its own files and its small child folders are packed greedily into parts of ≤ cap files; only oversized child folders recurse. Before this, a Next.js `app/` tree became one 1–3 file unit per page (kukufm-web-ssr: 141 → 46 tasks at quick depth).
- **Report size:** edges ship as integer rows against the node list (`graph.packedEdges`) and are rebuilt in the browser. kukufm-py went from 50 MB to 26 MB; it's still over 15 MB, so render prints the `--split` advice.
- **Performance:** analyze computes per-module "defines" in one pass (5.3 s → 0.5 s on 3.6k files), and prepare indexes imports, env reads, endpoints and handlers (it was quadratic: minutes → under 7 s).
- **Cost estimate calibration:** the raw estimate under-read measured runs by 1.5–1.9× (input+output) and 8–12× (including cache re-reads) on fixtures 06/09. It is now scaled by `EST_CALIBRATION` (×1.7, ×10), and both figures are printed. The confirm threshold compares against input+output.
- **Canvas levels:** a project's root folder counts as L0, and lone single-child folders open regardless of level. L1 now shows real areas: 40 on kukufm-web-ssr and 34 on kukufm-py, where it was 1–3 nodes.
