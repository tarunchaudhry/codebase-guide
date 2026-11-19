# Plugin format notes (Phase 0)

Verified 2026-10-07 against the live docs, with Claude Code **v2.1.292** installed locally.
`docs.anthropic.com/en/docs/claude-code/*` now 301-redirects to `code.claude.com/docs/en/*`.

## Sources read
- Docs map: https://code.claude.com/docs/en/claude_code_docs_map.md
- Plugins: [overview](https://code.claude.com/docs/en/plugins/overview), [create](https://code.claude.com/docs/en/plugins/create), [components](https://code.claude.com/docs/en/plugins/components), [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference), [loading](https://code.claude.com/docs/en/plugins/loading), [dependencies](https://code.claude.com/docs/en/plugins/dependencies), [security](https://code.claude.com/docs/en/plugins/security), [CLI reference](https://code.claude.com/docs/en/plugins/cli-reference)
- Marketplaces: [create-marketplace](https://code.claude.com/docs/en/plugins/create-marketplace), [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
- [Commands](https://code.claude.com/docs/en/commands), [Skills](https://code.claude.com/docs/en/skills), [Subagents](https://code.claude.com/docs/en/sub-agents), [Hooks](https://code.claude.com/docs/en/hooks), [Hooks guide](https://code.claude.com/docs/en/hooks-guide)

## Facts that shape the build

### Commands are now skills
- `commands/*.md` is documented as "the older form of skills. Use `skills/` for new plugins." Both still load.
- A plugin skill is invoked as `/<plugin>:<skill>`. **The bare `/<skill>` also works unless another command already uses that name** (skills → "How a skill gets its command name").
  - So `skills/codebase-guide/SKILL.md` gives both `/codebase-guide:codebase-guide` and `/codebase-guide`.
- Useful frontmatter:
  - `description`, `argument-hint`
  - `disable-model-invocation: true` (user-initiated only, which matters for cost)
  - `user-invocable: false` (Claude-only background knowledge)
  - `allowed-tools`, which can pre-approve `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*)`
- Substitutions available in skill bodies: `$ARGUMENTS`, `$0..$N`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`.
- `` !`cmd` `` runs a command before the prompt reaches Claude. A non-zero exit aborts the whole skill invocation, so preflight commands need `|| true` or must always exit 0.

### Manifest and marketplace
- Only `plugin.json` goes inside `.claude-plugin/`. Components sit at the plugin root.
- `.claude-plugin/marketplace.json` requires `name`, `owner.name` and `plugins[]`. Each entry requires `name` and `source`.
  - `"source": "./"` (or `"."`) lets one repo be both the marketplace and the plugin.
- Install path: `claude plugin marketplace add ./codebase-guide` then `claude plugin install codebase-guide@<marketplace-name>`. Dev loop: `claude --plugin-dir ./codebase-guide` plus `/reload-plugins`.
  - A relative-path plugin from a locally added marketplace **loads in place** (no cache copy).
- `claude plugin validate <path> [--strict]` checks the manifest and all skill/agent frontmatter. It will run as a test step.
- `${CLAUDE_PLUGIN_ROOT}` changes on every version, so nothing gets written there. `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) survives updates.
  - Our cache lives in the target repo anyway (`.codebase-guide/`), so we don't need it.
- Component paths can't escape the plugin root (`../x` and outbound symlinks are rejected).

### Node dependencies
- Claude Code auto-installs plugin deps only for copied (non-local) installs, and only when the root holds `package.json` plus `package-lock.json`/`npm-shrinkwrap.json`/`bun.lock`. **`pnpm-lock.yaml` → install skipped.** A local in-place install never auto-installs.
- **Decision:** ship `dist/` as **esbuild bundles with zero runtime deps** (ts-morph and the TypeScript compiler bundled in). No install step on any path. The pnpm workspace stays dev-only.

### Subagents
- `agents/*.md` → `codebase-guide:<name>`. Plugin agents **ignore `hooks`, `mcpServers`, `permissionMode`**. `tools`, `model` and `skills` are honored.
- The `name` field can't contain `:`.

### Hooks: a SessionStart notice is supported
- `hooks/hooks.json` uses the same shape as the settings `hooks` key. SessionStart supports `type: "command"`. Matchers: `startup|resume|clear|compact|fork`.
- Output channels:
  - `{"systemMessage": "..."}`: a **warning line shown to the user**. This is the one-line notice.
  - Plain stdout / `additionalContext`: added to **Claude's** context, not displayed.
  - Stderr on exit 0: debug log only.
- It runs in the background at startup, but Claude's first reply waits for it, so it must be fast: one `git rev-parse HEAD` plus reading one small JSON file, with a short `timeout`.
- Generation never runs from the hook. It only prints a notice.

## Deviations from the target layout
| Planned | Actual | Why |
|---|---|---|
| `commands/codebase-guide.md`, `repo-map.md`, `repo-flow.md` | `skills/codebase-guide/SKILL.md`, `skills/repo-map/SKILL.md`, `skills/repo-flow/SKILL.md`, all with `disable-model-invocation: true` | `commands/` is legacy. Skills give the same `/name args` UX plus `allowed-tools` and `argument-hint`. |
| `skills/codebase-guide/SKILL.md` (the Phase 7 usage guide) | `skills/using-codebase-guide/SKILL.md`, with `user-invocable: false` | Name collision with the `/codebase-guide` skill. The guide is knowledge for Claude, not a command. |
| `hooks/` "if supported" | `hooks/hooks.json` + `scripts/session-notice.mjs`, SessionStart `startup` matcher only | Supported (above). Firing on `resume`/`clear`/`compact` would just repeat the notice. |
| Users run prebuilt `dist/` | `dist/*.mjs` esbuild bundles, committed, zero runtime deps | No auto-install for local/pnpm installs (above). |
| `scripts/*.mjs` call into packages | Thin entry points that import `dist/` | Keeps `scripts/` editable and readable. |

## Open decision for review
- **Hook noise:** showing "No codebase guide yet" in *every* repo would be noisy. Proposal:
  - Show the "missing" notice only in a git repo that has `package.json`, `pyproject.toml`, `requirements*.txt` or `manage.py` at its root.
  - Always show the "stale" notice when `.codebase-guide/report/meta.json` exists and its commit ≠ HEAD.
  - Opt out with `CODEBASE_GUIDE_NOTICE=0`.

## Phase 1 findings
- **The bare `/name` alias needs an explicit `name:` in the frontmatter.** Without it, only `/codebase-guide:codebase-guide` was registered, and a bare `/codebase-guide` in `-p` mode went to Claude as plain text. Verified on v2.1.292. Every skill now sets `name:`.
- **TypeScript is pinned to 6.0.3, not `latest` (7.0.2).** TS 7 is the native (Go) compiler with no stable JS API. ts-morph 28.0.0 bundles the TS **6.0** JS API (`@ts-morph/common@0.29.0`). Keeping one compiler line avoids two TS semantics in one repo.
- **Node:** current LTS is 24.x (Krypton). The dev machine runs 22.22.1. `engines` is `>=22`, and tests will run on both before Phase 8 sign-off.
- **Local test install:** `claude plugin marketplace add <repo> --scope local` + `claude plugin install codebase-guide@codebase-guide --scope local`. The plugin then shows as "Read from: <repo>" (in place, so edits apply on `/reload-plugins`).
