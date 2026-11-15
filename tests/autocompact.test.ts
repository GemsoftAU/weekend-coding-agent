import { describe, expect, test } from "bun:test";
import { runTurn } from "../src/agent";
import { COMPACT_THRESHOLD } from "../src/lib/compaction";
import { createSession, estimateConversationTokens } from "../src/lib/session";
import type { CompletionResponse, Logger, Message, ToolSchema } from "../src/lib/types";

/** A response with no tool calls, so the turn ends immediately. */
function text(content: string): CompletionResponse {
	return {
		choices: [{ message: { role: "assistant", content } }],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	};
}

/** Records every request the "model" was sent, and answers by script. */
function recorder(responses: CompletionResponse[]) {
	const seen: Message[][] = [];
	let i = 0;
	const caller = async (messages: Message[], _tools: ToolSchema[]) => {
		seen.push(structuredClone(messages));
		return responses[Math.min(i++, responses.length - 1)];
	};
	return { caller, seen, calls: () => i };
}

/** A history big enough to cross a small context window. */
function bigHistory(): Message[] {
	const history: Message[] = [{ role: "system", content: "system" }];
	for (let i = 0; i < 40; i++) {
		history.push({ role: "user", content: `question ${i} ${"q".repeat(400)}` });
		history.push({ role: "assistant", content: `answer ${i} ${"a".repeat(400)}` });
	}
	return history;
}

const SUMMARY = "## Session Summary\n### Current State\n- compacted";

describe("auto-compaction in the turn loop", () => {
	test("is off by default: a full conversation is sent unchanged", async () => {
		const history = bigHistory();
		const used = estimateConversationTokens(history);
		// A window small enough that compaction would definitely trigger.
		const session = createSession({
			name: "tiny",
			contextLength: Math.floor(used / COMPACT_THRESHOLD),
			cost: { prompt: 0, completion: 0 },
		});

		const rec = recorder([text("done")]);
		await runTurn(history, rec.caller, undefined, [], undefined, "default", session, null, {});

		// Sent as-is: every original message is still there.
		const sent = rec.seen[0];
		expect(sent.length).toBe(history.length);
		expect(sent.some((m) => m.content?.includes("question 0"))).toBe(true);
	});

	test("when enabled, a near-full conversation is summarised before the call", async () => {
		const history = bigHistory();
		const used = estimateConversationTokens(history);
		const session = createSession({
			name: "tiny",
			contextLength: Math.floor(used / COMPACT_THRESHOLD),
			cost: { prompt: 0, completion: 0 },
		});

		const rec = recorder([text(SUMMARY), text("done")]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn(history, rec.caller, undefined, [], logger, "default", session, null, {
			autoCompact: true,
		});

		// First call is the summariser, second is the agent.
		expect(rec.calls()).toBe(2);
		expect(rec.seen[0][0].content).toContain("Summarise the conversation below");

		// The agent's request is the compacted history: short, and carrying the summary.
		const agentRequest = rec.seen[1];
		expect(agentRequest.length).toBeLessThan(history.length);
		expect(agentRequest.some((m) => m.content?.includes("compacted"))).toBe(true);

		expect(lines.join("\n")).toContain("[Compact] Summarised");
	});

	test("a big window does not trigger compaction", async () => {
		const history = bigHistory();
		const session = createSession({
			name: "huge",
			contextLength: 10_000_000,
			cost: { prompt: 0, completion: 0 },
		});

		const rec = recorder([text("done")]);
		await runTurn(history, rec.caller, undefined, [], undefined, "default", session, null, {
			autoCompact: true,
		});

		expect(rec.calls()).toBe(1);
		expect(rec.seen[0].length).toBe(history.length);
	});

	test("no session stats means no known window, so nothing is compacted", async () => {
		const history = bigHistory();
		const rec = recorder([text("done")]);
		await runTurn(history, rec.caller, undefined, [], undefined, "default", null, null, {
			autoCompact: true,
		});

		expect(rec.calls()).toBe(1);
		expect(rec.seen[0].length).toBe(history.length);
	});
});
