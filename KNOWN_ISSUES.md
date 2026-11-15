# Known Issues & Roadmap

What this agent does well, what it does badly, and what would come next.
Written after Chapter 11, so it reflects the code as it actually is — every
limitation below was found by reading it, not copied from the course outline.

---

## How to verify the state described here

```bash
mise run check          # lint + the full test suite
```

At the time of writing: **401 tests across 19 files, 0 failures**, Biome clean.

---

## Known issues

### Context and compaction

- **Auto-compaction is opt-in and estimate-based.** `runTurn` only compacts when
  `autoCompact: true` (set in `src/index.ts`) *and* the token estimate crosses
  80% of the context window. The estimate is `chars / 4`, not a real tokenizer,
  so for code-heavy conversations it can be off by a meaningful margin. Treat
  the gauge as a smoke alarm, not a fuel gauge.
- **Compaction costs a model call.** Summarising spends tokens to save tokens.
  `/compact` reports the summariser's usage, and auto-compaction bills it to the
  session, so the cost is visible rather than hidden — but a session that
  compacts often is paying twice for the same context.
- **A compaction can be refused.** If the summary would not reduce the estimate,
  the agent keeps the original conversation. This is deliberate (never trade real
  history for a longer fake one), but it means a pathological conversation can
  sit at the limit with compaction trying and skipping.
- **The summary is lossy by construction.** It preserves decisions, file lists
  and pending work as told to, but anything the summariser judged unimportant is
  gone. `/compact` prints the summary so it can be inspected; treat that as the
  checkpoint.

### Session introspection

- **The logs do not record API usage, so `/analyze` cannot report cost.** The
  JSONL log holds messages, not tokens. Rather than invent a figure, the analysis
  reports tool calls, failures and characters returned; money lives in `/session`,
  which has real usage numbers from the API responses.
- **Counts are per log directory, not per session.** `/analyze` reads every
  `.jsonl` file in `.session_logs/`. On a long-lived checkout that is a lot of
  history; the tool has no date or session filter yet.
- **Recommendations are thresholds, not judgement.** The search-before-read nudge
  fires at `read_file ≥ 5` and `read_file ≥ 3× search_files`; the failure nudge at
  ≥3 calls and ≥30% errors. Those numbers were chosen to avoid noise on short
  sessions, not calibrated against a real corpus.

### Tools

- **`bash` remains a blacklist, not a sandbox.** `isBlocked` matches patterns on
  an opaque command string. It has false positives (any command containing the
  guarded word) and cannot stop a determined escape. The structured file tools
  are the real boundary; `bash` is a backstop.
- **`replace_in_file` falls back to a loose match.** If exact text is not found,
  it retries whitespace-insensitively and accepts only an unambiguous hit. This
  rescues edits from indentation mistakes but means a successful edit is not
  proof the text matched exactly — read the returned diff.
- **Tool output is truncated for the console, not for the model.** Over ~1,000
  characters the terminal collapses the block; the model still receives all of it.
  That is what fills the context window.
- **`search_files` needs ripgrep on `PATH`.** Without `rg` the tool reports a
  spawn failure rather than falling back to a slower search.

### Subagents

- **Subagents cannot discover skills themselves.** The skills listing is passed
  down, and only to a subagent whose prompt declares `use_skill` or `read_file`.
  A subagent with neither silently gets no skills rather than a warning.
- **`ask_user` is serialised through one shared readline.** Two subagents asking
  at once would interleave; in practice the loop awaits each turn, so this has not
  been observed, but nothing enforces it.
- **Depth is capped at 2** (`MAX_SUBAGENT_DEPTH`). A delegation chain that needs
  three levels fails with a tool error instead of working.

### Model and provider

- **One provider.** `src/lib/api.ts` talks only to OpenRouter's chat-completions
  shape. Provider-specific features (prompt caching, native tool streaming) are
  unavailable.
- **No streaming.** The full response is awaited before anything is shown. The
  spinner is the only feedback during a long call, which for a slow model means
  a long silence.
- **Config is read at import time.** `MODEL` is resolved when `api.ts` is first
  imported. Changing `AGENT_MODEL` mid-process has no effect, which is why the
  env file is loaded at the top of `main()` rather than lazily.

### Skills and media generation

- **Video generation is not available on every Gemini key.** The key can
  authenticate and generate images while every Veo model returns 404. Verified
  here: `--list-models` showed an empty `Video Generation (Veo)` section. That is
  an account entitlement, not a bug in the skill.
- **`nano-banana` writes JPEG bytes into a `.png` file.** Observed directly
  (`FF D8 FF E0` under a `.png` name). Rename or convert if a consumer is strict.
- **The video skill needs `file` (MIME utility) for `--file`/`--reference`.** It
  is undocumented in the CLI's `--help` and absent from minimal images.
- **Generated media is gitignored** (`output/`, `images/`, `videos/`) so a test
  run cannot commit a 500 KB image by accident.

### Secrets

- **The MVP loads a key file and never prints values**, but `GEMINI_API_KEY`
  reaches child processes by inheritance for the skills to use. Any process the
  agent spawns can read it; that is the cost of shelling out to a CLI.
- **`scrubSecrets` only knows the values present at import time.** A key added to
  the environment after `src/tools/system.ts` is imported will not be redacted
  from tool output.

---

## Roadmap

Ordered by value per unit of work, not by ambition.

| Area | What | Why it matters |
| --- | --- | --- |
| **Streaming** | Stream tokens to the REPL as they arrive | Removes the dead air on long calls; the biggest UX gap |
| **Real tokenizer** | Replace `chars / 4` with a token count | Makes the context gauge and compaction threshold trustworthy |
| **Usage in the log** | Record `usage` per API call in the JSONL | Unlocks real cost reporting in `/analyze` |
| **Compaction tuning** | Summarise in chunks instead of one huge prompt | A very long conversation may not fit the summariser's own window |
| **Sandboxing** | Run `bash` in a container or with `--dry-run` first | Turns the blacklist into an actual boundary |
| **MCP** | Speak the Model Context Protocol for third-party tools | Reuse the ecosystem instead of writing every tool |
| **Evaluation** | A fixture suite that pins agent behaviour | Currently tests cover units; nothing guards end-to-end behaviour |
| **Undo** | Git-backed rollback of a bad turn | The cheapest safety net for an agent that edits files |
| **Streaming tool calls** | Handle partial tool arguments | Required for low-latency agents; the loop assumes whole calls |

---

## What is deliberately simple

Not bugs, just choices worth knowing:

- **JSONL over a database.** Append-only, streamable, crash-safe, greppable.
  A corrupt final line is skipped rather than fatal.
- **Prompts and skills are files, not code.** Adding an agent or a skill needs no
  build step and no TypeScript; `/agents` and `/skills` read the disk so they
  cannot drift from what is loaded.
- **`/compact` is a command, not magic.** It prints what it did and what it cost,
  so a surprising summary is visible instead of silent.
- **Compaction refuses rather than damages.** Every failure path returns the
  conversation unchanged with a reason.
