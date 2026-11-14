import { describe, expect, test } from "bun:test";
import type { ModelStats } from "../src/lib/api";
import {
	createSession,
	estimateConversationTokens,
	estimateTokens,
	recordUsage,
	sessionStatusLine,
} from "../src/lib/session";
import type { Message } from "../src/lib/types";

const stats: ModelStats = {
	name: "Test Model",
	contextLength: 1048576,
	cost: { prompt: 0.001, completion: 0.002 },
};

describe("estimateTokens", () => {
	test("estimates content length as chars/4 plus per-message overhead", () => {
		const message: Message = { role: "user", content: "x".repeat(400) };
		expect(estimateTokens(message)).toBe(400 / 4 + 16);
	});

	test("counts tool call arguments as part of the message size", () => {
		const message: Message = {
			role: "assistant",
			content: "",
			tool_calls: [
				{
					id: "c1",
					function: { name: "read_file", arguments: '{"path":"'.concat("y".repeat(80), '"}') },
				},
			],
		};
		// 80+12 chars of arguments / 4 + 16 overhead.
		expect(estimateTokens(message)).toBe(92 / 4 + 16);
	});

	test("a message with no content and no tool calls still costs the overhead", () => {
		expect(estimateTokens({ role: "assistant" })).toBe(16);
	});
});

describe("estimateConversationTokens", () => {
	test("sums the estimate across every message, including system prompts", () => {
		const messages: Message[] = [
			{ role: "system", content: "s".repeat(40) },
			{ role: "user", content: "u".repeat(40) },
			{ role: "assistant", content: "" },
		];
		// (40/4 + 16) + (40/4 + 16) + 16 = 26 + 26 + 16 = 68.
		expect(estimateConversationTokens(messages)).toBe(68);
	});

	test("an empty conversation estimates zero", () => {
		expect(estimateConversationTokens([])).toBe(0);
	});
});

describe("recordUsage + sessionStatusLine", () => {
	test("accumulates real usage into the session total cost", () => {
		const session = createSession(stats);
		recordUsage(session, { prompt_tokens: 100, completion_tokens: 50 });
		recordUsage(session, { prompt_tokens: 100, completion_tokens: 50 });

		expect(session.promptTokens).toBe(200);
		expect(session.completionTokens).toBe(100);
		// (100*0.001 + 50*0.002) * 2 = 0.2 * 2 = 0.4.
		expect(session.totalCost).toBeCloseTo(0.4);
	});

	test("usage-less responses are counted as zero, not NaN", () => {
		const session = createSession(stats);
		recordUsage(session, undefined);
		expect(session.totalCost).toBe(0);
		expect(session.promptTokens).toBe(0);
	});

	test("the status line reports context usage and cost", () => {
		const session = createSession(stats);
		recordUsage(session, { prompt_tokens: 100, completion_tokens: 50 });
		const line = sessionStatusLine(session, 52320);

		// 52320 / 1048576 = 5.0% of a 1M-token window; 100*0.001 + 50*0.002 = 0.2.
		expect(line).toBe("[Session] Context: ~52320 / 1048576 tokens (5.0%) | Cost: $0.200000");
	});

	test("without stats the status line omits the window and cost", () => {
		const session = createSession(null);
		expect(sessionStatusLine(session, 1234)).toBe("[Session] Context: ~1234 tokens");
	});
});
