import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelStats } from "../src/lib/api";
import { COMMAND_NAMES, type CommandContext, parseCommand, runCommand } from "../src/lib/commands";
import { createSessionLogger, loadSessionHistory, SessionLogger } from "../src/lib/logger";
import { createSession, recordUsage } from "../src/lib/session";
import type { Message } from "../src/lib/types";

const stats: ModelStats = {
	name: "Test Model",
	contextLength: 200000,
	cost: { prompt: 0.001, completion: 0.002 },
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "commands-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		session: createSession(stats),
		history: [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "hello" },
		],
		logDir: dir,
		sessionId: "current-session",
		logFile: join(dir, "2025-04-15-14-23.jsonl"),
		agentName: "default",
		stats,
		tools: ["read_file", "run_check"],
		...overrides,
	};
}

/** Run one raw line the way the REPL does: parse, then dispatch. */
async function run(line: string, ctx: CommandContext = makeContext()) {
	const parsed = parseCommand(line);
	if (!parsed) throw new Error(`not a command: ${line}`);
	return await runCommand(parsed, ctx);
}

describe("parseCommand", () => {
	test("splits the name from its arguments", () => {
		expect(parseCommand("/search read_file")).toEqual({ name: "search", args: ["read_file"] });
	});

	test("non-command input is not a command", () => {
		expect(parseCommand("hello /world")).toBeNull();
	});

	test("a bare slash is not a command", () => {
		expect(parseCommand("/")).toBeNull();
		expect(parseCommand("   /   ")).toBeNull();
	});

	test("command names are case-insensitive", () => {
		expect(parseCommand("/HELP")).toEqual({ name: "help", args: [] });
	});

	test("surrounding and repeated whitespace is collapsed", () => {
		expect(parseCommand("  /restore   abc  ")).toEqual({ name: "restore", args: ["abc"] });
	});

	test("multi-word arguments stay separate, in order", () => {
		expect(parseCommand("/search tool error")).toEqual({
			name: "search",
			args: ["tool", "error"],
		});
	});
});

describe("/help", () => {
	test("lists every command", async () => {
		const { output } = await run("/help");
		for (const name of COMMAND_NAMES) {
			expect(output).toContain(`/${name}`);
		}
	});

	test("shows the agent name and the tools it can call", async () => {
		const { output } = await run("/help");
		expect(output).toContain("Agent: default");
		expect(output).toContain("read_file, run_check");
	});

	test("shows the subagents it can delegate to", async () => {
		const { output } = await run("/help", makeContext({ subagents: ["code-map", "poet"] }));
		expect(output).toContain("Subagents: code-map, poet");
	});

	test("omits the subagent line when there are none", async () => {
		expect((await run("/help")).output).not.toContain("Subagents:");
	});
});

describe("/models", () => {
	test("reports the model, its context window and per-1M pricing", async () => {
		const { output } = await run("/models");
		expect(output).toContain("Model: Test Model");
		expect(output).toContain("200K tokens");
		// 0.001 per token is $1000 per 1M; 0.002 is $2000 per 1M.
		expect(output).toContain("$1000.000 per 1M input tokens");
		expect(output).toContain("$2000.000 per 1M output tokens");
	});

	test("says so plainly when stats are unavailable", async () => {
		expect((await run("/models", makeContext({ stats: null }))).output).toContain(
			"stats unavailable",
		);
	});
});

describe("/session", () => {
	test("reports id, log file, message count, tokens and cost", async () => {
		const session = createSession(stats);
		recordUsage(session, { prompt_tokens: 100, completion_tokens: 50 });
		const { output } = await run("/session", makeContext({ session }));

		expect(output).toContain("Session: current-session");
		expect(output).toContain("2025-04-15-14-23.jsonl");
		// One non-system message plus the system prompt in the fixture history.
		expect(output).toContain("Messages: 1");
		expect(output).toContain("Tokens: 100 in / 50 out");
		expect(output).toContain("Cost: $0.200000");
	});

	test("says cost is unknown rather than claiming $0.000000", async () => {
		const { output } = await run("/session", makeContext({ session: createSession(null) }));
		expect(output).toContain("unknown (no pricing)");
	});

	test("reports a session that is not being logged", async () => {
		const ctx = makeContext({ sessionId: null, logFile: null });
		expect((await run("/session", ctx)).output).toContain("(logging disabled)");
	});
});

describe("/search", () => {
	test("finds matching entries in the session logs", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "user", content: "please refactor the parser" });
		logger.log({ role: "assistant", content: "done" });

		const { output } = await run("/search refactor");
		expect(output).toContain("1 match(es)");
		expect(output).toContain("please refactor the parser");
	});

	test("searches every log file, not just the current session's", async () => {
		// A previous session in an earlier file must still be findable.
		const earlier = createSessionLogger(dir, new Date(2025, 3, 15, 9, 5));
		earlier.log({ role: "user", content: "buried treasure" });
		const current = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		current.log({ role: "user", content: "unrelated" });

		const { output } = await run("/search treasure", makeContext({ logFile: current.logFile }));
		expect(output).toContain("1 match(es)");
	});

	test("attributes each match to its session and agent", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23), "researcher");
		logger.log({ role: "user", content: "please refactor" });

		const { output } = await run("/search refactor");
		expect(output).toContain(logger.sessionId.slice(0, 8));
		expect(output).toContain("[researcher]");
	});

	test("is case-insensitive", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "user", content: "Refactor THIS" });
		expect((await run("/search refactor")).output).toContain("1 match(es)");
	});

	test("summarises tool-call entries by tool name", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({
			role: "assistant",
			tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }],
		});
		expect((await run("/search read_file")).output).toContain("assistant -> read_file");
	});

	test("reports no matches instead of an empty list", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "user", content: "hello" });
		expect((await run("/search zebra")).output).toContain("No matches");
	});

	test("requires a pattern", async () => {
		expect((await run("/search")).output).toContain("Usage: /search");
	});

	test("joins multi-word arguments into one pattern", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "tool", content: "Tool error: missing path" });

		expect((await run("/search Tool error")).output).toContain("1 match(es)");
	});

	test("long entries are truncated so the result list stays scannable", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "tool", content: `needle ${"x".repeat(500)}` });

		const { output } = await run("/search needle");
		expect(output).toContain("…");
		expect(output).not.toContain("x".repeat(500));
	});
});

describe("/list", () => {
	test("says there are no sessions when the log dir is empty", async () => {
		expect((await run("/list")).output).toContain("No saved sessions");
	});

	test("marks the current session and lists the others", async () => {
		const current = createSessionLogger(dir, new Date(2025, 3, 15, 9, 5));
		current.log({ role: "user", content: "a" });
		const other = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		other.log({ role: "user", content: "b" });

		const { output } = await run("/list", makeContext({ sessionId: current.sessionId }));
		expect(output).toContain(`* ${current.sessionId}`);
		expect(output).toContain(`  ${other.sessionId}`);
	});
});

describe("/restore", () => {
	test("replays a saved session into the history", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "system", content: "system prompt" });
		logger.log({ role: "user", content: "earlier question" });

		const result = await run(`/restore ${logger.sessionId}`);
		expect(result.output).toContain("Restored 2 messages");
		expect(result.history?.map((m) => m.content)).toEqual(["system prompt", "earlier question"]);
		// Restoring does not start a new session; /fork does.
		expect(result.newSession).toBeUndefined();
	});

	test("accepts an unambiguous id prefix", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "user", content: "hi" });

		const result = await run(`/restore ${logger.sessionId.slice(0, 8)}`);
		expect(result.history).toHaveLength(1);
	});

	test("an unknown id reports usage rather than throwing", async () => {
		const { output } = await run("/restore nope");
		expect(output).toContain("Usage: /restore");
	});

	test("no argument reports usage", async () => {
		expect((await run("/restore")).output).toContain("Usage: /restore");
	});

	test("a prefix that matches several sessions is refused as ambiguous", async () => {
		// Two sessions that share an id prefix, written into the same log file.
		const file = join(dir, "2025-04-15-14-23.jsonl");
		new SessionLogger(file, "abc-111", null, "main").log({ role: "user", content: "a" });
		new SessionLogger(file, "abc-222", null, "main").log({ role: "user", content: "b" });

		expect((await run("/restore abc")).output).toContain("Usage: /restore");
		// An unambiguous prefix still resolves.
		expect((await run("/restore abc-222")).history?.map((m) => m.content)).toEqual(["b"]);
	});
});

describe("/fork", () => {
	test("keeps the history and asks for a fresh session id", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "user", content: "branch point" });

		const result = await run(`/fork ${logger.sessionId}`);
		expect(result.history?.map((m) => m.content)).toEqual(["branch point"]);
		// A fork must be a new session, or both branches write to the same id.
		expect(result.newSession).toBe(true);
		// And it must remember which session it split from, for the log tree.
		expect(result.forkedFrom).toBe(logger.sessionId);
	});

	test("an unknown id reports usage", async () => {
		expect((await run("/fork nope")).output).toContain("Usage: /fork");
	});
});

/** A fake model that returns one canned summary and records what it was sent. */
function summaryCaller(summary = "## Session Summary\n### Current State\n- built the thing") {
	const seen: Message[][] = [];
	return {
		seen,
		caller: async (messages: Message[]) => {
			seen.push(structuredClone(messages));
			return {
				choices: [{ message: { role: "assistant" as const, content: summary } }],
				usage: { prompt_tokens: 100, completion_tokens: 20 },
			};
		},
	};
}

describe("/compact", () => {
	test("replaces old turns with the summary, keeping the system prompt and tail", async () => {
		const history: Message[] = [{ role: "system", content: "system prompt" }];
		for (let i = 0; i < 10; i++) {
			history.push({ role: "user", content: `q${i}` });
			history.push({ role: "assistant", content: `a${i}` });
		}

		const fake = summaryCaller();
		const result = await run("/compact", makeContext({ history, apiCaller: fake.caller }));

		expect(result.history?.[0]).toEqual({ role: "system", content: "system prompt" });
		expect(result.history?.[1].content).toContain("built the thing");
		// The summary is labelled as machine-written, not as something the user said.
		expect(result.history?.[1].content).toContain("not the user");
		// Keeps the last 6 non-system messages: q7,a7,q8,a8,q9,a9.
		expect(result.history?.slice(2).map((m) => m.content)).toEqual([
			"q7",
			"a7",
			"q8",
			"a8",
			"q9",
			"a9",
		]);
	});

	test("sends the summariser the conversation, not the system prompt", async () => {
		const history: Message[] = [{ role: "system", content: "SYSTEM PROMPT TEXT" }];
		for (let i = 0; i < 10; i++) history.push({ role: "user", content: `q${i}` });

		const fake = summaryCaller();
		await run("/compact", makeContext({ history, apiCaller: fake.caller }));

		const transcript = fake.seen[0][1].content ?? "";
		expect(transcript).toContain("q0");
		expect(transcript).not.toContain("SYSTEM PROMPT TEXT");
	});

	test("the compacted history is shorter than the original", async () => {
		const history: Message[] = [{ role: "system", content: "s" }];
		for (let i = 0; i < 10; i++) history.push({ role: "user", content: `q${i}` });
		const fake = summaryCaller();
		const result = await run("/compact", makeContext({ history, apiCaller: fake.caller }));
		expect(result.history?.length).toBeLessThan(history.length);
	});

	test("reports the tokens the summary call cost", async () => {
		const history: Message[] = [{ role: "system", content: "s" }];
		for (let i = 0; i < 10; i++) history.push({ role: "user", content: `q${i}` });
		const fake = summaryCaller();
		const result = await run("/compact", makeContext({ history, apiCaller: fake.caller }));
		expect(result.output).toContain("100 in / 20 out");
	});

	test("a short conversation is left alone without calling the model", async () => {
		const fake = summaryCaller();
		const ctx = makeContext({ history: [{ role: "user", content: "hi" }], apiCaller: fake.caller });
		const result = await run("/compact", ctx);
		expect(result.history).toBeUndefined();
		expect(result.output).toContain("Nothing to compact");
		expect(fake.seen).toHaveLength(0);
	});

	test("a failed summary leaves the conversation unchanged", async () => {
		const history: Message[] = [{ role: "system", content: "s" }];
		for (let i = 0; i < 10; i++) history.push({ role: "user", content: `q${i}` });
		const failing = async () => {
			throw new Error("network down");
		};

		const result = await run("/compact", makeContext({ history, apiCaller: failing }));
		expect(result.history).toBeUndefined();
		expect(result.output).toContain("left unchanged");
		expect(result.output).toContain("network down");
	});

	test("an empty summary is refused rather than wiping the conversation", async () => {
		const history: Message[] = [{ role: "system", content: "s" }];
		for (let i = 0; i < 10; i++) history.push({ role: "user", content: `q${i}` });
		const empty = async () => ({
			choices: [{ message: { role: "assistant" as const, content: "   " } }],
		});

		const result = await run("/compact", makeContext({ history, apiCaller: empty }));
		expect(result.history).toBeUndefined();
		expect(result.output).toContain("no summary");
	});

	test("never keeps a tool result without the assistant call it answers", async () => {
		// The API rejects an orphaned tool message, so a cut that would land on one
		// has to trim further forward.
		const history: Message[] = [{ role: "system", content: "s" }];
		for (let i = 0; i < 3; i++) {
			history.push({ role: "user", content: `q${i}` });
			history.push({
				role: "assistant",
				content: "",
				tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: "{}" } }],
			});
			history.push({ role: "tool", tool_call_id: `c${i}`, content: `r${i}` });
			history.push({ role: "assistant", content: `a${i}` });
		}

		const fake = summaryCaller();
		const result = await run("/compact", makeContext({ history, apiCaller: fake.caller }));
		const kept = result.history?.slice(2) ?? [];
		expect(kept.length).toBeGreaterThan(0);
		expect(kept[0].role).not.toBe("tool");
		for (const [i, message] of kept.entries()) {
			if (message.role === "tool") expect(kept[i - 1]?.role).toBe("assistant");
		}
	});
});

describe("/agents", () => {
	test("lists every prompt on disk with its description and tools", async () => {
		const { output } = await run(
			"/agents",
			makeContext({ promptDir: join(import.meta.dir, "..", "src", "prompts") }),
		);
		expect(output).toContain("code-map:");
		expect(output).toContain("tech-researcher:");
		expect(output).toContain("feature-planner:");
		expect(output).toContain("poet:");
		expect(output).toContain("tools:");
	});

	test("marks the subagents this agent may delegate to", async () => {
		const { output } = await run(
			"/agents",
			makeContext({
				promptDir: join(import.meta.dir, "..", "src", "prompts"),
				subagents: ["poet"],
			}),
		);
		expect(output).toContain("* poet:");
		expect(output).toContain("  code-map:");
	});

	test("names the current agent", async () => {
		const { output } = await run(
			"/agents",
			makeContext({ promptDir: join(import.meta.dir, "..", "src", "prompts") }),
		);
		expect(output).toContain("Current agent: default");
	});

	test("a missing prompt directory is reported, not thrown", async () => {
		const { output } = await run("/agents", makeContext({ promptDir: join(dir, "nope") }));
		expect(output).toContain("No prompts found");
	});
});

describe("dispatch edges", () => {
	test("/exit ends the session", async () => {
		expect((await run("/exit")).exit).toBe(true);
	});

	test("an unknown command reports usage instead of throwing", async () => {
		expect((await run("/teleport")).output).toContain("Unknown command: /teleport");
	});
});

// A fork's history and a restore's history must survive a real round trip through
// the log file, not just the in-memory fixture.
describe("fork round trip", () => {
	test("the forked history can be reloaded under its own new session id", async () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		logger.log({ role: "user", content: "original" });

		const forked = await run(`/fork ${logger.sessionId}`);
		const child = logger.child("default", forked.forkedFrom);
		for (const message of forked.history ?? []) child.log(message);

		expect(loadSessionHistory(dir, logger.sessionId)).toHaveLength(1);
		expect(loadSessionHistory(dir, child.sessionId)).toHaveLength(1);
	});
});
