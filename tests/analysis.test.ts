import { describe, expect, test } from "bun:test";
import {
	analyzeEntries,
	analyzeLogs,
	formatAnalysis,
	isErrorResult,
	recommend,
} from "../src/lib/analysis";
import type { LogEntry } from "../src/lib/logger";
import type { Message } from "../src/lib/types";

/** Build one log entry. */
function entry(message: Message, overrides: Partial<Omit<LogEntry, "message">> = {}): LogEntry {
	return {
		timestamp: "2026-01-01T00:00:00.000Z",
		sessionId: "s1",
		parentId: null,
		agentName: "default",
		message,
		...overrides,
	};
}

/** An assistant message that calls one tool. */
function callEntry(id: string, tool: string, session = "s1"): LogEntry {
	return entry(
		{
			role: "assistant",
			content: "",
			tool_calls: [{ id, function: { name: tool, arguments: "{}" } }],
		},
		{ sessionId: session },
	);
}

/** The matching tool result. */
function resultEntry(id: string, content: string, session = "s1"): LogEntry {
	return entry({ role: "tool", tool_call_id: id, content }, { sessionId: session });
}

describe("isErrorResult", () => {
	test("recognises the error shapes the tools actually return", () => {
		expect(isErrorResult("Tool error: bad argument")).toBe(true);
		expect(isErrorResult("Error: file not found: x")).toBe(true);
		expect(isErrorResult("Security Policy Violation: no")).toBe(true);
		expect(isErrorResult("  Tool error: leading space")).toBe(true);
	});

	test("ordinary output is not an error", () => {
		expect(isErrorResult("src/a.ts\nsrc/b.ts")).toBe(false);
		expect(isErrorResult("(no output)")).toBe(false);
		expect(isErrorResult("")).toBe(false);
		expect(isErrorResult(undefined)).toBe(false);
	});
});

describe("analyzeEntries", () => {
	test("counts sessions and roles", () => {
		const analysis = analyzeEntries([
			entry({ role: "user", content: "hi" }),
			entry({ role: "assistant", content: "hello" }, { sessionId: "s2" }),
		]);
		expect(analysis.sessions).toBe(2);
		expect(analysis.roles.user).toBe(1);
		expect(analysis.roles.assistant).toBe(1);
	});

	test("attributes tool results to the tool by call id, not by guessing", () => {
		const analysis = analyzeEntries([
			callEntry("c1", "read_file"),
			resultEntry("c1", "contents"),
			callEntry("c2", "search_files"),
			resultEntry("c2", "matches"),
		]);

		const read = analysis.tools.find((t) => t.name === "read_file");
		const search = analysis.tools.find((t) => t.name === "search_files");
		expect(read?.calls).toBe(1);
		expect(search?.calls).toBe(1);
		expect(read?.resultChars).toBe("contents".length);
	});

	test("counts an error against the tool that produced it", () => {
		const analysis = analyzeEntries([
			callEntry("c1", "replace_in_file"),
			resultEntry("c1", "Tool error: oldText not found"),
			callEntry("c2", "replace_in_file"),
			resultEntry("c2", "Updated ok"),
		]);
		const tool = analysis.tools.find((t) => t.name === "replace_in_file");
		expect(tool?.calls).toBe(2);
		expect(tool?.errors).toBe(1);
	});

	test("sorts tools by call count, descending", () => {
		const analysis = analyzeEntries([
			callEntry("a", "rare"),
			callEntry("b", "common"),
			callEntry("c", "common"),
		]);
		expect(analysis.tools[0].name).toBe("common");
		expect(analysis.tools[0].calls).toBe(2);
	});

	test("counts subagent messages by agent name", () => {
		const analysis = analyzeEntries([
			entry({ role: "user", content: "x" }, { parentId: "parent", agentName: "poet" }),
			entry({ role: "user", content: "y" }, { parentId: "parent", agentName: "poet" }),
			entry({ role: "user", content: "z" }, { parentId: "parent", agentName: "code-map" }),
		]);
		expect(analysis.subagents.poet).toBe(2);
		expect(analysis.subagents["code-map"]).toBe(1);
	});

	test("an unmatched tool result does not crash or invent a tool", () => {
		const analysis = analyzeEntries([resultEntry("ghost", "content")]);
		expect(analysis.tools).toHaveLength(0);
	});

	test("an empty log reports zero rather than producing a false finding", () => {
		const analysis = analyzeEntries([]);
		expect(analysis.sessions).toBe(0);
		expect(analysis.tools).toHaveLength(0);
		expect(analysis.recommendations[0]).toContain("No tool calls recorded");
	});
});

describe("recommend", () => {
	// Starts from an empty log; each test assigns the tool stats it wants scored.
	const analysisWith = () => analyzeEntries([], { maxRecommendations: 10 });

	test("nudges search-before-read when reads dominate", () => {
		const analysis = analysisWith();
		analysis.tools = [
			{ name: "read_file", calls: 12, errors: 0, resultChars: 0 },
			{ name: "search_files", calls: 1, errors: 0, resultChars: 0 },
		];
		const findings = recommend(analysis);
		expect(findings.join("\n")).toContain("read_file was called 12×");
		expect(findings.join("\n")).toContain("Search for the symbol first");
	});

	test("does not nudge when search is used comparably", () => {
		const analysis = analysisWith();
		analysis.tools = [
			{ name: "read_file", calls: 6, errors: 0, resultChars: 0 },
			{ name: "search_files", calls: 5, errors: 0, resultChars: 0 },
		];
		expect(recommend(analysis).join("\n")).not.toContain("Search for the symbol first");
	});

	test("flags a tool with a high failure rate and says it is usually the arguments", () => {
		const analysis = analysisWith();
		analysis.tools = [{ name: "replace_in_file", calls: 4, errors: 3, resultChars: 100 }];
		const findings = recommend(analysis).join("\n");
		expect(findings).toContain("replace_in_file failed 3/4");
		expect(findings).toContain("malformed argument");
	});

	test("does not flag a tool below the call threshold", () => {
		const analysis = analysisWith();
		analysis.tools = [{ name: "replace_in_file", calls: 2, errors: 2, resultChars: 100 }];
		expect(recommend(analysis).join("\n")).not.toContain("failed");
	});

	test("names the noisiest tool when one dominates the context", () => {
		const analysis = analysisWith();
		analysis.tools = [{ name: "read_file", calls: 2, errors: 0, resultChars: 500_000 }];
		expect(recommend(analysis).join("\n")).toContain("largest share of context");
	});

	test("reports healthy tool use instead of an empty list", () => {
		const analysis = analysisWith();
		analysis.tools = [{ name: "read_file", calls: 3, errors: 0, resultChars: 100 }];
		expect(recommend(analysis).join("\n")).toContain("looks healthy");
	});

	test("caps the number of findings", () => {
		const analysis = analysisWith();
		analysis.tools = [
			{ name: "read_file", calls: 50, errors: 0, resultChars: 500_000 },
			{ name: "replace_in_file", calls: 10, errors: 9, resultChars: 100 },
			{ name: "bash", calls: 10, errors: 9, resultChars: 100 },
		];
		expect(recommend(analysis, 1)).toHaveLength(1);
	});
});

describe("formatAnalysis", () => {
	test("shows the scope, counts and findings", () => {
		const analysis = analyzeEntries([
			entry({ role: "user", content: "hi" }),
			callEntry("c1", "read_file"),
			resultEntry("c1", "contents"),
		]);
		const out = formatAnalysis(analysis, "3 entries");

		expect(out).toContain("Session analysis");
		expect(out).toContain("Scope: 3 entries");
		expect(out).toContain("Sessions: 1");
		expect(out).toContain("read_file: 1 / 0 /");
		expect(out).toContain("Findings:");
	});

	test("says so when no tools were recorded", () => {
		expect(formatAnalysis(analyzeEntries([entry({ role: "user", content: "x" })]))).toContain(
			"Tools: none recorded",
		);
	});
});

describe("analyzeLogs", () => {
	test("is the entry-level entry point the command layer uses", () => {
		const analysis = analyzeLogs([entry({ role: "user", content: "hi" })]);
		expect(analysis.sessions).toBe(1);
	});
});
