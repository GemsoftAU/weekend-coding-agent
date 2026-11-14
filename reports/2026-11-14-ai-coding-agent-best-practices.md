---
title: "Best practices for building AI coding agents: harness, context, and verifiable feedback"
date: 2026-11-14
tags: [ai-agents, coding-agents, harness-design, context-engineering, evaluation, security]
recommendation: "Treat the coding agent as a harness (instructions + tools + model) around a verifiable feedback loop: keep instructions short, give the agent a check it can run, and put any rule that cannot have exceptions into deterministic configuration rather than prose."
use_when:
  - "You are building or configuring a coding agent that edits real repositories"
  - "Your agent produces plausible-looking diffs that fail review or tests"
  - "You are writing AGENTS.md / CLAUDE.md / rules files and need to decide what belongs there"
dont_use_when:
  - "The task is a single-shot generation or completion where no tools or iteration are involved"
  - "You have no way to verify output automatically and no human reviewer in the loop"
---

## Question

What are the current best practices for building AI coding agents — meaning both the engineering of the agent loop itself and the workflow practices that make such agents produce reliable code? The request was open-ended, so this report covers the practices that recur across vendor guidance, engineering blogs, and practitioner write-ups, and separates claims that are verifiable from vendor docs from claims that are only asserted.

## Recommendation

Build the agent as a **harness** around a **feedback loop**, and spend most of your effort on the two things the model cannot supply by itself: context it cannot discover, and a check that returns pass or fail.

Concretely, and in priority order:

1. **Make the loop verifiable.** Give the agent something runnable that returns a pass/fail signal — tests, a typechecker, a linter, a build exit code, a fixture diff, a screenshot compared to a mockup. An agent that can read its own failure output will iterate to green; an agent that cannot will stop at "looks done" and make the human the test suite.
2. **Keep instructions minimal and repository-local.** Only write down what the model cannot find by reading the repo: the exact test/lint/typecheck commands, misleading legacy patterns, decisions made outside the repo, and anything you have already had to correct twice.
3. **Escalate from prose to enforcement.** Anything that must happen *every* time belongs in a hook, a deny rule, or a managed setting, not in a markdown instruction file. Prose is for guidelines with exceptions; mechanism is for invariants.
4. **Design the tool interface as deliberately as the prompt.** Tool descriptions, argument shapes, and error messages are the agent's API. Every source that discusses this at depth says the same thing: poor tool ergonomics produce most agent failures that get blamed on the model.
5. **Verify independence and keep the human on the merge.** Parallel agents need isolated checkouts (git worktrees) and a reviewer — ideally one that never saw the conversation that produced the code.

The recurring theme, stated most directly by KDnuggets' survey of practice: better agent output usually does not start with a better model, it starts with better engineering discipline.

## Options considered

Different sources emphasise different architectures, and they do not fully agree. The main positions:

| Approach | What it claims | Evidence | Verdict |
| --- | --- | --- | --- |
| Simple composable patterns over frameworks | Most production value comes from prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer; frameworks add abstraction that obscures prompts and responses | Anthropic's *Building effective agents*, based on work with dozens of customer teams | **Adopt.** Start with direct API calls; add a framework only once you understand what it does underneath |
| Framework-first / graph orchestration | Use an orchestration library (LangGraph, CrewAI, Strands) to encode the patterns | Mentioned as a legitimate option in Anthropic's post and in secondary write-ups covering teams without infrastructure | Acceptable for teams without infra, but you inherit debugging opacity |
| Fully autonomous long-running agent | Let the model run for hours, iterating until the goal is met | Documented as a real pattern: Cursor's stop-hook "grind" loop and long-running agents research preview; Claude Code's `/goal`, `Stop` hooks, and compaction | **Adopt for verifiable goals only**, with an iteration cap and a sandbox |
| Prescriptive workflow with hardcoded steps | Code paths are fixed; the model only fills in steps | Anthropic explicitly distinguishes workflows from agents and recommends workflows for well-defined tasks | Prefer this when the task shape is predictable — it is cheaper and more debuggable |
| Prompt-engineering-only (no config, no checks) | Better prompts produce better code | Contradicted by every source that has run agents at scale | **Reject.** Prose cannot guarantee anything |

The honest trade-off: autonomy buys throughput and costs predictability. Every source that discusses long-running agents pairs them with sandboxing, iteration limits, and human review of the merge.

## Details

### 1. Anatomy of the harness

Cursor's guidance defines an agent harness as three components: **instructions** (system prompt and rules), **tools** (file editing, codebase search, terminal execution), and **model**. The important consequence is that these are tuned *per model* — a model trained on shell-oriented workflows may prefer `grep` over a dedicated search tool; another may need explicit instruction to run a linter after edits. If you support multiple models, expect to maintain more than one instruction set, and evaluate each combination rather than assuming a prompt that works for one transfers.

Claude Code's documentation splits the same space differently and more usefully for builders — into **deterministic** and **non-deterministic** instructions:

- *Non-deterministic*: prompt text, `CLAUDE.md`, skills. The model reads it and usually complies. There is no guarantee.
- *Deterministic*: hooks, deny rules, managed settings, sandboxes, budget caps. The harness executes these regardless of what the model decided.

Every concern has both forms — what to do, what the agent can touch, when it is done, how much it spends, who has the last word. Use the non-deterministic form by default (models are good at judging whether a guideline fits the code in front of them), and reach for the deterministic form only for rules with zero exceptions. A useful diagnostic from that page: if you keep adding emphasis to a line and the model still misses it, the line belongs in a hook — and conversely, if you have hooks for mere preferences, delete them and let the model decide.

### 2. Context: write down only what the model cannot see

The single most over-engineered artefact in most agent setups is the instruction file. Claude Code's docs give a two-question test before writing anything down:

1. Could the agent find this by reading the code?
2. Would it actually go and look?

If both are yes, leave it out. What survives the test:

- The exact commands to install, build, test one file, typecheck, and lint.
- Places where the code is misleading — an old pattern that is everywhere but must not be copied; a directory that looks dead but is not.
- Decisions that are not in the repo — which error helper the team settled on, how deploys work, what needs a migration review.
- Anything you have already corrected twice.

The same page reports that the memory guide recommends staying under 200 lines, and points at `/init` to scaffold a first version and `/doctor` to suggest cuts. Two other structural controls matter:

- **Scope rules by path.** If a rule only applies to `src/api/**/*.ts`, put it in a path-filtered rule file so it loads only when the agent works there, instead of taxing every unrelated task.
- **Put procedures in skills, not in the always-loaded file.** A skill's name and description are visible every session, but its body is read only when the task calls for it — so a long release runbook does not weigh on an unrelated bug fix.

`AGENTS.md` is the cross-tool version of the same idea and is worth adopting even if you use a single vendor. Verified on agents.md: it is a plain-Markdown open format, used by over 60k open-source projects, supported by Codex, Jules, Cursor, Copilot's coding agent, Gemini CLI, Amp, Zed, Warp, Aider, goose, opencode, and others; the **nearest file in the directory tree wins**, explicit chat prompts override it, and nested per-package files are the intended monorepo mechanism (at the time of writing, the main OpenAI repo has 88 of them). It is now stewarded by the Agentic AI Foundation under the Linux Foundation.

KDnuggets summarises the failure modes to avoid as "configuration smells": generic coding advice the model already knows, long framework explanations, contradictory rules, stale commands, and too many "always"/"never" lines. It cites a paper reporting lint leakage in 62% and context bloat in 42% of 100 popular repositories' instruction files; note this figure is reported second-hand in that article — I did not read the paper itself.

### 3. The feedback loop is the product

Every credible source converges here. Claude Code's framing: the agent stops when the work *looks* done; if nothing returns pass/fail, "looks done" is all it has, and you become the test suite.

The escalation ladder for a check, weakest to strongest:

1. **In the prompt** — "run the auth tests after, and keep going until they pass." Works today, needs no setup, model decides when it is satisfied.
2. **As a goal condition** — an explicit pass condition a separate model evaluates after every turn; the agent is sent back to work if it is unmet. Useful mainly for unattended runs, where agents tend to end a turn with a progress summary while items are still open.
3. **As a `Stop` hook** — a script that runs whenever the agent tries to end its turn; exit code 2 blocks the stop and returns stderr to the agent as the reason it cannot finish. Example from the docs: `pnpm tsc --noEmit 1>&2 || exit 2`. Enforced by the harness, so a turn does not end until it passes. There is a block cap (eight consecutive blocks, configurable) to stop infinite loops.
4. **By a reviewer that did not write the code** — a fresh subagent that never saw the conversation, so it is not anchored by the reasoning that produced the diff.

Two caveats worth building in:

- **Always ask for evidence** — the command and its output, not the sentence "all tests pass." Reading the output is faster than rerunning it, and for an unattended run it is the only evidence you have.
- **Tell the reviewer to skip style.** A reviewer asked to find problems will always find something; fixing every finding produces extra abstraction layers and tests for impossible cases. Prefer reviewing against a written spec.

For TDD specifically, Cursor's workflow is worth copying verbatim because it removes the classic failure: write tests from expected input/output pairs, explicitly forbid implementation code at that stage, **run them and confirm they fail**, commit the tests, then ask for implementation with instructions not to modify the tests, iterating until green. The commit boundary between tests and implementation is what makes the diff reviewable.

### 4. Tool and interface design (ACI)

Anthropic's guidance is the most concrete on this, and it is where the biggest wins hide. Treat the agent-computer interface with the same investment as a human-computer interface:

- Put yourself in the model's shoes: is it obvious how to use this tool from the description and parameters? A good definition includes example usage, edge cases, input-format requirements, and clear boundaries against similar tools.
- Keep formats close to what the model has seen in natural text, and avoid formatting overhead — writing a diff requires knowing chunk header line counts *before* writing the code; code inside JSON requires escaping newlines and quotes. Prefer whole-file writes or exact-match replacement over generated diffs.
- **Poka-yoke the tools** — change the arguments so mistakes are impossible. The worked example: the model kept breaking on relative paths after changing directory, so the tool was changed to require absolute paths, after which it used the tool flawlessly. Anthropic reports spending *more* time optimising tools than the overall prompt while building their SWE-bench agent.
- Give the model room to think before writing itself into a corner.

Two further practices that fall out of this and appear in multiple sources:

- **Make failures informative and survivable.** Bad tool arguments should return a message the model can act on rather than killing the turn — a tool-argument error type that is converted into a `Tool error: ...` result keeps the loop alive and lets the agent self-correct.
- **Search beats enumeration.** Let the agent find files by grepping and semantic search rather than requiring you to tag every file; including irrelevant files actively confuses it about what matters.

### 5. Planning: use it, but do not over-plan

Planning before coding recurs everywhere and is the highest-leverage single change per Cursor. Two independent sources (`plan.md` on Google Cloud's blog; plan mode in Copilot CLI's docs, per KDnuggets) describe nearly identical mechanics: write a step-by-step plan to a file, get approval at milestones, and treat the plan as editable.

The important qualifier is that planning is **task-sized**. KDnuggets' split is a good default: plan for migrations, multi-file refactors, auth changes, schema changes, performance work, production bug fixes, and anything touching security or payments; skip heavy planning for typo fixes, small test additions, CSS tweaks, and one-function refactors.

One non-obvious pattern from Claude Code's docs, useful when the requirement is fuzzy: ask the agent to **interview you** until it could write the spec, have it write `SPEC.md`, then **start a fresh session** to build from the spec. That gives the build a clean context and gives you the file to hand the reviewer later. Similarly, when an agent has built the wrong thing, reverting and re-running a sharper plan is usually faster and cleaner than repairing the in-progress attempt.

### 6. Context hygiene and cost

- **Start fresh between logical units of work.** Long conversations accumulate noise; after many turns and summarisations the agent gets distracted or switches tasks. Continue only while iterating on the same feature or debugging what it just built.
- **Cost is quadratic-ish in practice**, not because of the window size but because every request resends the whole conversation. A session that has accumulated three unrelated tasks re-reads all three on every turn of the fourth, discounted while the prompt cache is warm and full price once it expires.
- **Subagents buy parallelism and a fresh perspective, not a smarter answer** — by default they run the same or a smaller model. They pay off for keeping long output (test runs, wide searches) out of the main conversation, for speed on independent work, and for constrained reviewers. They cost tokens, and can be *slower* than doing the work in place because a fresh agent must re-gather context you already had.
- **Isolate parallel agents with git worktrees.** Cursor's implementation creates a worktree per agent so edits, builds, and tests do not collide, then merges via an explicit "Apply". Running the same prompt across several models and picking the best result is reported to help on hard tasks.

### 7. Safety: permissions, sandboxing, dependencies

- **Deny rules before classifiers.** A classifier-based "auto mode" (which reviews risky actions: `curl | bash`, production deploys, force pushes over others' work, sensitive data sent to external endpoints) is a judgement call and can be wrong or be disabled by an org. "Never" rules belong in deny rules — and note they match tool calls, not intent: a `Read` deny catches `cat .env`, but not a script that opens the file, and a `WebFetch` deny for a domain does nothing about `curl` to it.
- **Sandbox at the OS level for anything security-relevant**, and prefer strict mode so the agent cannot retry a blocked command outside the sandbox.
- **Budget caps are a safety mechanism.** Turn limits and spend limits are what make unattended or looping agents survivable.
- **Constrain dependencies.** Agents like to solve problems by installing packages or widening configs. A written dependency policy — no new production dependency without approval, prefer existing utilities, explain the need and list alternatives — is cheap and prevents long-term maintenance debt.
- **Review the diff, not the vibe.** KDnuggets' review checklist is better than "does it look good": did it solve the requested problem, change unrelated behaviour, add unnecessary abstraction, weaken security, hide errors, update tests, follow conventions, and could the diff be smaller?

## Open questions

- **The performance claims are not independently verified.** The "97% of developers use at least one AI assistant" and "nearly a third of code is AI-generated" figures come from HackerRank's 2025 Developer Skills Report as quoted by KDnuggets; I did not read the report. Likewise the 62%/42% configuration-smell figures come from a paper cited second-hand. Treat both as directional.
- **Model and feature specifics in vendor docs are volatile.** The Claude Code and Cursor pages I fetched name specific models, default effort levels, and feature availability (for example, Cursor's page states Agent Skills were nightly-only at time of writing). Nothing load-bearing here depends on those details, and any you rely on should be re-checked against the live docs.
- **Anthropic's own post is dated Dec 19, 2024 and carries a banner saying much of the tooling landscape has changed**, pointing to their Managed Agents material. The *principles* (simplicity, transparency, ACI investment) still read as current and are corroborated independently; the specific framework recommendations are not.
- **Not settled by any source: how to evaluate a coding agent before trusting it.** Several sources say to test in sandboxed environments and evaluate against your own task distribution, but none gives a concrete procedure for building that eval set. That is the gap I would investigate next.
- **Long-running agents** are the frontier and the least-documented. Iteration caps, scratchpad conventions, and stop-hook loops are described as patterns, not as settled practice.

## Sources

All pages below were fetched and read during this session.

- Cursor — Best practices for coding with agents (Lee Robinson, Jan 9, 2026): https://cursor.com/blog/agent-best-practices
- Anthropic — Best practices for Claude Code: https://www.anthropic.com/engineering/claude-code-best-practices
- Anthropic — Building effective agents (Dec 19, 2024, with 2026 update banner): https://www.anthropic.com/engineering/building-effective-agents
- AGENTS.md — open format specification, FAQ, and supported agents: https://agents.md/
- Google Cloud Blog — Five Best Practices for Using AI Coding Assistants (Oct 8, 2025): https://cloud.google.com/blog/topics/developers-practitioners/five-best-practices-for-using-ai-coding-assistants
- KDnuggets — 10 Rules for Getting Better Results from AI Coding Agents (Kanwal Mehreen, Aug 26, 2026): https://www.kdnuggets.com/10-rules-for-getting-better-results-from-ai-coding-agents

Referenced but **not** fetched (secondary citation, unverified):

- HackerRank 2025 Developer Skills Report: https://www.hackerrank.com/reports/developer-skills-report-2025
- agentpatterns.ai — Anthropic effective agents framework pattern map: https://agentpatterns.ai/patterns/agent-design/anthropic-effective-agents-framework
- eagerworks — Agentic Coding: Best Practices: https://eagerworks.com/blog/agentic-coding-best-practices
