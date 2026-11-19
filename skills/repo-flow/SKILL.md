---
name: repo-flow
description: Trace one end-to-end flow you describe (e.g. "how an order is saved"), validate it, add it to the existing report and re-render.
argument-hint: "\"<description>\" [--entry <file|METHOD path>]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Agent
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/codebase-guide.mjs flow . $ARGUMENTS`

The output above plans one requested flow.

1. If it contains `ERROR:`, relay it and stop.
2. For the `RUN` line (agent `codebase-guide:flow-tracer`), dispatch that agent with the prompt `Input: <input path>`. A `CACHE-HIT` line means it's already traced; skip to step 4.
3. Run the `VALIDATE:` command with `--stage 2`.
   - If the flow's task shows `RETRY`, re-dispatch with `Input: <input path>` plus `Errors: <errors path>. Fix every listed problem and rewrite the output file.`
   - At most 2 retries, then validate with `--stage 2 --final`.
4. Run the `RENDER:` command.
5. Run each command exactly as printed, one per Bash call (no `&&`, `;` or shell variables).
6. Tell the user the report path and say the flow is under **Key Flows**. It's saved, so future `/codebase-guide` runs keep it.
