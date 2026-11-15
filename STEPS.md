# STEPS — Build Log of the Weekend Coding Agent

A milestone-by-milestone summary of what was built, which tools landed, and the
architectural decisions that shaped the code. Derived from `git log` and the
JSONL transcripts in `.session_logs/`.

**Stack:** Bun + TypeScript, Biome (lint/format), `mise` task runner, OpenRouter
for model calls. Single verification gate: `mise run check` (Biome + `bun test`).

**Current state:** 12 chapters, 405 tests across 20 files, 0 failures.

---

## Chapter 01–02 — Foundation (commits `a05eb46`, `5793682`, `a893c40`)

The initial commit and a single `bootstrap.ts` scratchpad script: prompt a model,
stream the answer, keep a message array.

**Decisions**
- **A guardrail before features.** `bootstrap.ts` refuses to start without a
  usable `.env` rather than failing later with an opaque 401.
- Model id lives in code at this stage and is later redacted from history — a
  reminder that config belongs in env, which is why `src/lib/env.ts` exists now.

---

## Chapter 03 — Scaffolding (`32833de`)

`bootstrap.ts` became a real project: `src/` with `agent.ts`, `index.ts`,
a tool registry, prompt files with frontmatter, tests, and Biome.

**Decisions**
- **`runTurn` is the unit of work**, not a one-shot script — the loop that later
  chapters extend rather than rewrite.
- **Prompts are files with frontmatter**, so tools/description are declared next
  to the prose instead of hardcoded.
- **`mise run check` as the only gate.** Lint and tests always run together, so
  "green" means both.

---

## Chapter 04 — File Tools & Secret Safety (`15d4525`)

The structured editing toolkit that everything else is built on.

**Tools added:** `list_files`, `read_file`, `search_files`, `write_file`,
`replace_in_file`, `bash`, plus `run_check` and `git_diff`.

**Decisions**
- **Structured tools over raw shell.** `replace_in_file` fails loudly on a
  missing or ambiguous `oldText`, which is what stops a model from silently
  corrupting a file; `bash` is documented as a last resort.
- **Secret-path guardrail** ported from `bootstrap.ts` into `src/tools/system.ts`,
  so every path-taking tool inherits the refusal instead of each re-implementing
  it.
- **`read_file` returns line-numbered output** for human/agent readability — a
  decision that later forced `use_skill` to exist, since numbered text is useless
  as a copied file body.
- Bounded output (`MAX_READ_LINES`, `MAX_MATCHES`) so one call cannot flood the
  context window.

---

## Chapter 05 — Cost & Context Awareness (`8702228`, `0d2cf62`, `40f592d`, `01da9b5`)

Token accounting, `/session` reporting, and the removal of the `bootstrap.ts`
entry point now that `src/` owned everything.

**Decisions**
- **`/session` is the source of truth for money.** Real usage numbers come from
  the API response, not from estimates — a rule Chapter 11 leans on when it
  refuses to print a fake `$0.00`.
- **Token estimates are `chars / 4`**, deliberately cheap and approximate. Good
  enough for a smoke alarm, documented as such rather than presented as exact.
- **Delete the scratchpad rather than keep it.** The commit message records where
  to recover it (`a893c40:bootstrap.ts`), so cleanup cost nothing.

---

## Chapter 06 — Session Logging (`c36a2c0`)

Every message appended to `.session_logs/YYYY-MM-DD-HH-MM.jsonl`; slash-command
dispatch added.

**Files:** `src/lib/logger.ts`, `src/lib/commands.ts`.

**Commands added:** `/help`, `/models`, `/session`, `/search`, `/list`,
`/restore`, `/fork`, `/compact`, `/exit`.

**Decisions**
- **Log the whole turn in order** — assistant `tool_calls`, each tool result,
  then the final answer — so a session replays exactly as it happened.
- **`child()` mints a new `sessionId` in the same file**, giving forks and
  subagent runs a `parentId` tree without needing a second file format.
- **Readers tolerate a half-written trailing line.** A crash leaves exactly that,
  and losing a session to an unparseable last byte is worse than skipping it.
- **Logging is best-effort at startup**, so a read-only checkout still runs.
- **`/compact` was a mechanical placeholder** here, explicitly marked as such for
  Chapter 11 to replace — never keeping a tool result without the assistant call
  that answers it.

---

## Chapter 07 — Web Research (`7a1592c`, `275ec28`, `fde458c`, `b460f0a`)

**Tools added:** `tavily_search`, `download_url`.
**Prompt added:** `src/prompts/tech-researcher.md`.

**Decisions**
- **`download_url` strips noise before converting.** Turndown leaks the
  *contents* of `<script>`/`<style>`, so the HTML is cleaned first, output is
  capped, and JS-only pages report "no readable text" instead of an empty page.
- **Key resolution is injectable** (`resolveTavilyKey`) so the missing-key path
  is tested without a live key.
- **`reports/` is a deliverable, not build output** — un-gitignored so research
  survives; the same reasoning later moved `KNOWN_ISSUES.md` out of `docs/`.
- **`.env.example` is tracked, `.env` is not.** The secrets pattern was
  over-matching the template, so fresh clones never learned which variables to
  set; the pattern now negates the template only.
- **Documented limits instead of guessed fixes.** `stripNoise` leaks ~4 lines in
  150 from skip-links/plain `div` wrappers; measured, written down, left alone
  rather than patched with brittle heuristics.
- A live run produced `reports/2026-11-14-ai-coding-agent-best-practices.md`
  with four unverified citations explicitly labelled.

---

## Chapter 08 — UI Upgrades (`57d4a54`)

**Files added:** `src/lib/ui.ts` (pure presentation), `src/lib/input.ts`
(readline).

**Decisions**
- **UI is a pure, testable module.** `formatSplash`, `formatToolCall`,
  `formatToolResult`, `formatReasoning`, `formatTurnStatus`, `formatAgentPrompt`
  all take data and return strings — no I/O, so 23 tests cover rendering without
  a terminal.
- **Collapse for the eye, not for the model.** Long tool output is truncated on
  screen but kept whole in the context and the session log.
- **Reasoning is normalised** across the string / `{text}` / `[{text}]` shapes
  different OpenRouter providers return, returning `null` when there is nothing.
- **`recentSessions()` groups by session id**, because one file can hold forks
  and subagents — newest activity first, first user message as the preview.
- **readline replaces `for await (const line of console)`** for editing, history
  and paste, while still accepting piped stdin.
- **`search_files` now excludes `node_modules` by default** — relying on
  `.gitignore` meant searching vendor code in repos without one.

---

## Chapter 09 — Subagents (`249a0a5`)

**Tools added:** `run_agent`, `ask_user`.
**Prompts added:** `code-map.md`, `feature-planner.md`, `poet.md`; `default.md`
gains `subagents:` frontmatter.
**Commands added:** `/agents`.

**Decisions**
- **A subagent is a nested `runTurn`**, not a new mechanism: own system prompt,
  own task, own tool list, own child session log — sharing the parent's API
  client, executor and session totals so cost stays in one place.
- **Isolation is the feature.** A subagent never sees the parent's history; the
  task string is its whole world, which is why every delegation prompt must be
  self-contained.
- **`MAX_SUBAGENT_DEPTH = 2`**, and the refusal returns as a *tool result* so the
  loop stays alive instead of throwing.
- **`ToolContext` threaded through `executeTool`** (`agentRunner`, `askUser`) —
  keeping existing tools pure `(name, args)` while new ones get what they need.
- **`ask_user` reuses the existing readline interface** via
  `setSharedInput`/`getSharedInput`. A second interface would fight stdin and
  kill the REPL; readline routes the answer to the pending question instead of
  emitting it as a REPL line.
- **`run_agent`'s `agentName` enum is built per prompt**, so a subagent can only
  be reached if the current prompt declared it.

---

## Chapter 10 — Skills System (`1e5f319`)

**Files added:** `src/lib/skills.ts`.
**Tools added:** `use_skill`, `list_skills`.
**Skills added:** `big_text`, `generate_image`, `generate_video`.
**Commands added:** `/skills`.

**Decisions**
- **Progressive disclosure.** Only the one-line name/description/path listing
  reaches the prompt; the body loads on demand. That is the entire point of the
  system, and it is why `use_skill` exists rather than a plain `read_file` — the
  latter would hand back line-numbered text.
- **Discovery by directory listing**, never a hardcoded list.
- **`skillsPathPrefix` emits a relative path only when the skills dir really sits
  under the cwd**, otherwise absolute — so the model is never sent to a file that
  does not exist.
- **Skills are gated per subagent**: only agents with `use_skill` or `read_file`
  receive the listing. Offering skills to `poet` (an `ask_user`-only agent) is
  tokens spent on instructions it cannot follow.
- **`splitFrontmatter` extracted** and shared by the prompt and skill loaders.
- **The chapter's own content was corrected from source.** The course's
  `generate_video` skill invented flags; the body now documents what the
  `nano-banana` CLI actually enforces (1080p requires 8s, `--extend` needs a
  `.uri` sidecar, max 3 references, 5-minute poll timeout). Every font in the
  `big_text` showcase is verified against a local `figlet` run.
- **A real bug was caught by the tests:** `formatSkillRegistry` read
  `s.description` instead of `s.frontmatter.description`, listing every skill as
  `undefined` while still *looking* correct.

---

## Chapter 11 — Polish & Introspection (`094b343`)

**Files added:** `src/lib/compaction.ts`, `src/lib/analysis.ts`,
`KNOWN_ISSUES.md`.
**Commands added:** `/compact` (real, replacing the placeholder), `/analyze`.

**Decisions**
- **Every compaction failure path returns the conversation unchanged with a
  reason.** A failed or empty summary can never wipe history, and a summary that
  would not actually save tokens is refused.
- **`shouldCompact` is silent when the window is unknown** — no signal, no paid
  action. Fires at 80% of the window, *before* the request that is about to be
  sent.
- **Pure logic separated from the model call** in `compaction.ts`, so the cut
  point is inspectable and testable without a network.
- **`renderTranscript` names tool calls rather than dumping arguments**, and
  clips each message so the summariser cannot overflow itself.
- **Auto-compaction is opt-in** (`autoCompact`, enabled in `index.ts`), and the
  summariser's tokens are billed to the session like any other call — the cost is
  visible rather than hidden.
- **`/analyze` attributes tool results via `tool_call_id`**, since a result alone
  does not name its tool.
- **`/analyze` deliberately reports no cost.** The JSONL log holds messages, not
  API usage; the first draft summed a placeholder to a confident `$0.00`, which
  was removed. Cost stays in `/session`; `/help` was corrected from "context
  cost" to "context size".
- **`KNOWN_ISSUES.md` sits at the repo root**, not `docs/` — `docs/` is
  gitignored, so a file there would never reach a commit.
- **Verified against the live model, not just fakes:** `/compact` took 5,132 →
  1,963 tokens (62% saved) and honestly flagged its own unverified claim;
  `/analyze` ran over 1,036 real log entries.
- `runCommand` became async to accommodate these.

---

## Cross-cutting decisions worth knowing

| Decision | Why |
| --- | --- |
| `mise run check` = lint + tests | One gate; "green" is never half-true. |
| Pure logic in `src/lib/`, I/O at the edges | Compaction, analysis, UI and skills are testable without a network or terminal. |
| Failures return as tool results | A refusal (depth limit, bad skill name, ambiguous edit) informs the model instead of killing the loop. |
| Secrets guarded centrally | `src/tools/system.ts` refuses secret paths for every tool at once. |
| Estimates are labelled as estimates | `chars / 4` is called a smoke alarm, not a fuel gauge. |
| Never ship a confident-looking fake number | The `/analyze` cost placeholder was deleted rather than printed. |
| Deliverables are tracked | `reports/`, `KNOWN_ISSUES.md`, `skills/`, `.env.example` are committed; build/media output is not. |

---

## Chapter 12+ — Roadmap (not built)

Recorded in `KNOWN_ISSUES.md`: real tokenizer-based accounting, retry/backoff on
provider errors, richer compaction (tool-aware, per-file summaries), and making
`docs/` tracked so the `code-map` subagent's output survives a commit.
