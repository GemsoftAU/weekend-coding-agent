import { describe, expect, test } from "bun:test";
import type { ModelStats } from "../src/lib/api";
import type { RecentSession } from "../src/lib/logger";
import { createSession, recordUsage } from "../src/lib/session";
import {
	formatAgentPrompt,
	formatReasoning,
	formatSplash,
	formatToolCall,
	formatToolResult,
	formatTurnStatus,
	TOOL_ARGS_MAX_CHARS,
	TOOL_RESULT_MAX_CHARS,
	TOOL_RESULT_MAX_LINES,
} from "../src/lib/ui";

const stats: ModelStats = {
	name: "Test Model",
	contextLength: 200000,
	cost: { prompt: 0.000001, completion: 0.000002 },
};

function splash(overrides: Partial<Parameters<typeof formatSplash>[0]> = {}) {
	return formatSplash({
		model: "vendor/model-id",
		stats,
		promptName: "default",
		promptDescription: "The default full-featured coding agent.",
		tools: ["read_file", "run_check"],
		logFile: "/logs/2025-04-15-14-23.jsonl",
		recent: [],
		sessionId: "abc-123",
		...overrides,
	});
}

describe("formatSplash", () => {
	test("shows the model name and id, context window, and pricing", () => {
		const out = splash();
		expect(out).toContain("Model: Test Model (vendor/model-id)");
		expect(out).toContain("Context window: 200K tokens");
		expect(out).toContain("$1.000 per 1M input tokens");
		expect(out).toContain("$2.000 per 1M output tokens");
	});

	test("shows the selected prompt name and description", () => {
		const out = splash();
		expect(out).toContain("Prompt: default - The default full-featured coding agent.");
	});

	test("lists the tools the agent can call and where it logs", () => {
		const out = splash();
		expect(out).toContain("Tools: read_file, run_check");
		expect(out).toContain("Logging to: /logs/2025-04-15-14-23.jsonl");
	});

	test("lists the subagents it can delegate to", () => {
		expect(splash({ subagents: ["code-map", "poet"] })).toContain("Subagents: code-map, poet");
	});

	test("says there are no subagents rather than printing an empty line", () => {
		expect(splash()).toContain("Subagents: none");
	});

	test("degrades to 'stats not found' when pricing is unavailable", () => {
		const out = splash({ stats: null });
		expect(out).toContain("Model: vendor/model-id (stats not found)");
		expect(out).toContain("Context window: unknown");
		expect(out).toContain("Pricing: unknown");
	});

	test("says logging is disabled rather than printing a null path", () => {
		expect(splash({ logFile: null })).toContain("Logging to: (logging disabled)");
	});

	test("says so when there are no saved sessions", () => {
		expect(splash()).toContain("Recent sessions: none");
	});

	test("lists recent sessions and marks the current one", () => {
		const recent: RecentSession[] = [
			{
				sessionId: "current-session-0001",
				agentName: "default",
				messages: 4,
				lastActivity: "2025-04-15T14:30:00.000Z",
				preview: "refactor the parser",
			},
			{
				sessionId: "other-session-0002",
				agentName: "tech-researcher",
				messages: 12,
				lastActivity: "2025-04-15T09:00:00.000Z",
				preview: "",
			},
		];
		const out = splash({ recent, sessionId: "current-session-0001" });

		expect(out).toContain("Recent sessions (* = current):");
		// Ids are shortened to a prefix, as /list and /restore accept.
		expect(out).toContain("* current- [default] 4 msg(s) refactor the parser");
		expect(out).toContain("  other-se [tech-researcher] 12 msg(s)");
	});

	test("tells the user how to leave and how to find help", () => {
		const out = splash();
		expect(out).toContain("exit");
		expect(out).toContain("to quit");
		expect(out).toContain("/help");
	});
});

describe("formatToolCall", () => {
	test("bash shows the command as a shell line", () => {
		expect(formatToolCall("bash", '{"command":"ls src"}')).toBe("$ ls src");
	});

	test("other tools show a labelled JSON argument line", () => {
		expect(formatToolCall("read_file", '{"path":"src/index.ts"}')).toBe(
			'[Tool: read_file] {"path":"src/index.ts"}',
		);
	});

	test("long arguments are clipped so one write cannot flood the REPL", () => {
		const args = JSON.stringify({ content: "x".repeat(500) });
		const line = formatToolCall("write_file", args);
		expect(line.length).toBeLessThanOrEqual(`[Tool: write_file] `.length + TOOL_ARGS_MAX_CHARS);
		expect(line.endsWith("...")).toBe(true);
	});

	test("malformed arguments are still shown, not swallowed", () => {
		expect(formatToolCall("bash", "{not json")).toContain("[Tool: bash]");
		expect(formatToolCall("bash", "{not json")).toContain("{not json");
	});

	test("empty arguments render as an empty object", () => {
		expect(formatToolCall("run_check", "")).toBe("[Tool: run_check] {}");
	});
});

describe("formatToolResult", () => {
	test("short output is passed through untouched", () => {
		expect(formatToolResult("src\nlib")).toBe("src\nlib");
	});

	test("long output is collapsed and says how much was hidden", () => {
		const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const out = formatToolResult(content);

		expect(out).toContain("line 0");
		expect(out).toContain("collapsed");
		expect(out).toContain("full output is in the session log");
		// The collapsed block is bounded, so the terminal stays readable.
		expect(out.split("\n").length).toBeLessThanOrEqual(TOOL_RESULT_MAX_LINES + 1);
	});

	test("one enormous line is bounded by characters too", () => {
		const out = formatToolResult("x".repeat(TOOL_RESULT_MAX_CHARS * 2));
		expect(out.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 100);
		expect(out).toContain("collapsed");
	});

	test("an error string is still visible, because it is short", () => {
		expect(formatToolResult("Tool error: missing path")).toBe("Tool error: missing path");
	});
});

describe("formatReasoning", () => {
	test("reads a plain string", () => {
		expect(formatReasoning("weighing the options")).toBe("[Reasoning]: weighing the options");
	});

	test("reads a list of text blocks", () => {
		expect(formatReasoning([{ text: "first" }, { text: "second" }])).toBe(
			"[Reasoning]: first\nsecond",
		);
	});

	test("reads a single object with a text field", () => {
		expect(formatReasoning({ text: "one thought" })).toBe("[Reasoning]: one thought");
	});

	test("returns null when there is nothing to show", () => {
		expect(formatReasoning(undefined)).toBeNull();
		expect(formatReasoning(null)).toBeNull();
		expect(formatReasoning([])).toBeNull();
		expect(formatReasoning("   ")).toBeNull();
		expect(formatReasoning({})).toBeNull();
	});
});

describe("formatTurnStatus", () => {
	test("names the agent and model and shows this turn against session totals", () => {
		const session = createSession(stats);
		recordUsage(session, { prompt_tokens: 100, completion_tokens: 50 });
		recordUsage(session, { prompt_tokens: 10, completion_tokens: 5 });

		const line = formatTurnStatus({
			agentName: "default",
			model: "vendor/model-id",
			stats,
			usage: { prompt_tokens: 10, completion_tokens: 5 },
			session,
			messages: 3,
		});

		expect(line).toBe("[default] Test Model | msgs: 3 | tokens 10/5 (session 110/55)");
	});

	test("falls back to the model id when stats are unavailable", () => {
		const line = formatTurnStatus({
			agentName: "default",
			model: "vendor/model-id",
			stats: null,
			usage: { prompt_tokens: 1, completion_tokens: 2 },
			session: createSession(null),
			messages: 0,
		});
		expect(line).toContain("vendor/model-id");
	});
});

describe("formatAgentPrompt", () => {
	test("labels the input with the agent that will answer", () => {
		expect(formatAgentPrompt("default")).toBe("[default]> ");
		expect(formatAgentPrompt("tech-researcher")).toBe("[tech-researcher]> ");
	});
});
