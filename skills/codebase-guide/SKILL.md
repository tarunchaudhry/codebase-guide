---
name: codebase-guide
description: Generate the interactive onboarding report for this repo (extract → link → analyze → explain with subagents → validate → render). Uses LLM tokens; prints an estimate first and asks when it's large.
argument-hint: "[path] [--depth quick|standard|deep] [--update] [--split] [--no-snippets] [--open]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Agent, AskUserQuestion
---

## Deterministic stages (already ran)

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/codebase-guide.mjs prepare $ARGUMENTS`

## Your job: orchestrate the Explain stage, then render

The output above holds the repo summary, the explain plan, the cost estimate, and the exact `VALIDATE:` / `RENDER:` / `RENDER_DETERMINISTIC:` commands. Follow these steps in order.

1. **Errors.** If the output contains `ERROR:`, tell the user what failed in one or two sentences and stop.
2. **Budget.**
   - If it says `CONFIRM: yes`, ask the user with AskUserQuestion: run the Explain stage (state the estimated tokens and file reads from the output), or build the deterministic report only (free).
   - If they choose deterministic, run the `RENDER_DETERMINISTIC:` command, relay its output and stop.
   - If it says `CONFIRM: no`, continue without asking.
3. **Stage 1.**
   - For every `RUN` line under `STAGE 1`, dispatch the subagent named by `agent=` with exactly this prompt: `Input: <the input= path>`.
   - Dispatch in parallel: several Agent calls per message, up to 8 at a time, until all are dispatched.
   - Don't read the input or output files yourself. The validator checks them.
4. **Validate stage 1.**
   - Run the `VALIDATE:` command with `--stage 1`.
   - For each `RETRY` line, re-dispatch the same agent with the prompt `Input: <input path>` plus a new line `Errors: <errors path>. Fix every listed problem and rewrite the output file.`
   - Validate again. Do at most 2 retry rounds, then run the command once more with `--stage 1 --final`.
5. **Stage 2.** Dispatch every `RUN` line under `STAGE 2` (architecture writer, flow tracers, guide writer) in parallel, the same way. Then validate with `--stage 2`, using the same retry rule and finishing with `--final`.
   - Skip any stage that has no `RUN` lines. `CACHE-HIT` tasks need nothing.
6. **Render.** Run the `RENDER:` command.
7. **Report back** in a few lines:
   - the report path;
   - the grounding line and the flow-steps line;
   - any explain tasks that ended `partial`/`missing`;
   - the top warnings;
   - the gitignore note.

   Don't paste the explanations themselves.

Rules:
- Run every command exactly as printed above, one per Bash call: no `&&`, `;`, pipes or shell variables. The plugin pre-approves exactly these commands; anything else triggers a permission prompt.
- Never run the target repo's code, install anything, or read `.env`/secret files.
- If an agent fails outright, keep going. The validator marks it missing and the report falls back to graph-only content for that part.
