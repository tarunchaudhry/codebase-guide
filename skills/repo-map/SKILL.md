---
name: repo-map
description: Build the deterministic codebase report (structure, routes, models, env vars, hotspots, run-locally facts, canvas). No LLM calls; fast and free.
argument-hint: "[path] [--open] [--split]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*)
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/codebase-guide.mjs map $ARGUMENTS`

Relay the output above to the user, keeping the report path, counts and warnings. Do nothing else.
