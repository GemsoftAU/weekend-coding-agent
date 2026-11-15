import { describe, expect, test } from "bun:test";
import {
	applyCompaction,
	buildSummaryRequest,
	COMPACT_THRESHOLD,
	compactHistory,
	DEFAULT_KEEP_TAIL,
	extractSummary,
	planCompaction,
	renderTranscript,
	SUMMARY_INSTRUCTIONS,
	shouldCompact,
	summaryMessage,
	TRANSCRIPT_MSG_MAX_CHARS,
	trimTail,
} from "../src/lib/compaction";
import { estimateConversationTokens } from "../src/lib/session";
import type { Message } from "../src/lib/types";

/** A conversation with a system prompt and `turns` user/assistant pairs. */
function conversation(turns: number, body = 10): Message[] {
	const history: Message[] = [{ role: "system", content: "SYSTEM PROMPT" }];
	for (let i = 0; i < turns; i++) {
		history.push({ role: "user", content: `q${i} ${"x".repeat(body)}` });
		history.push({ role: "assistant", content: `a${i} ${"y".repeat(body)}` });
	}
	return history;
}

describe("shouldCompact", () => {
	test("is false when the window is unknown: no signal, no paid action", () => {
		expect(shouldCompact(conversation(50), 0)).toBe(false);
		expect(shouldCompact(conversation(50), -1)).toBe(false);
	});

	test("is false for a small conversation in a big window", () => {
		expect(shouldCompact(conversation(2), 1_000_000)).toBe(false);
	});

	test("is true once usage crosses the threshold", () => {
		const history = conversation(20, 200);
		const used = estimateConversationTokens(history);
		// A window sized so usage lands exactly at the threshold.
		const window = Math.floor(used / COMPACT_THRESHOLD);
		expect(shouldCompact(history, window)).toBe(true);
	});

	test("honours a custom ratio", () => {
		const history = conversation(5, 100);
		const used = estimateConversationTokens(history);
		expect(shouldCompact(history, used * 10, 0.5)).toBe(false);
		expect(shouldCompact(history, used * 2, 0.5)).toBe(true);
	});
});

describe("renderTranscript", () => {
	test("omits the system prompt: it survives compaction anyway", () => {
		expect(renderTranscript(conversation(1))).not.toContain("SYSTEM PROMPT");
	});

	test("labels user and assistant turns", () => {
		const out = renderTranscript(conversation(1, 1));
		expect(out).toContain("USER: q0");
		expect(out).toContain("ASSISTANT: a0");
	});

	test("names tool calls instead of dumping their arguments whole", () => {
		const history: Message[] = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "c1", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } },
				],
			},
			{ role: "tool", tool_call_id: "c1", content: "file contents" },
		];
		const out = renderTranscript(history);
		expect(out).toContain("ASSISTANT[tool calls]: read_file(");
		expect(out).toContain("TOOL RESULT: file contents");
	});

	test("clips a giant tool result so the summariser fits too", () => {
		const history: Message[] = [
			{ role: "tool", tool_call_id: "c1", content: "z".repeat(TRANSCRIPT_MSG_MAX_CHARS * 2) },
		];
		const out = renderTranscript(history);
		expect(out.length).toBeLessThan(TRANSCRIPT_MSG_MAX_CHARS * 2);
		expect(out).toContain("truncated");
	});
});

describe("buildSummaryRequest", () => {
	test("is a system instruction plus one user message carrying the transcript", () => {
		const request = buildSummaryRequest(conversation(2));
		expect(request).toHaveLength(2);
		expect(request[0]).toEqual({ role: "system", content: SUMMARY_INSTRUCTIONS });
		expect(request[1].role).toBe("user");
		expect(request[1].content).toContain("q0");
	});

	test("the instructions ask for the summary sections the course specifies", () => {
		for (const section of ["Current State", "Key Decisions", "Pending Work"]) {
			expect(SUMMARY_INSTRUCTIONS).toContain(section);
		}
	});
});

describe("extractSummary", () => {
	test("returns the trimmed content", () => {
		expect(
			extractSummary({ choices: [{ message: { role: "assistant", content: "  hello  " } }] }),
		).toBe("hello");
	});

	test("is null for an error response", () => {
		expect(extractSummary({ choices: [], error: { message: "boom" } })).toBeNull();
	});

	test("is null for blank content, so a real conversation is never wiped", () => {
		expect(
			extractSummary({ choices: [{ message: { role: "assistant", content: "   " } }] }),
		).toBeNull();
		expect(extractSummary({ choices: [{ message: { role: "assistant" } }] })).toBeNull();
	});
});

describe("trimTail", () => {
	test("drops leading tool messages, which would be orphaned", () => {
		const tail: Message[] = [
			{ role: "tool", content: "orphan" },
			{ role: "assistant", content: "next" },
		];
		expect(trimTail(tail).map((m) => m.content)).toEqual(["next"]);
	});

	test("leaves a tail that already starts on a non-tool message", () => {
		const tail: Message[] = [{ role: "user", content: "u" }];
		expect(trimTail(tail)).toHaveLength(1);
	});
});

describe("planCompaction", () => {
	test("splits into system, to-summarise and tail", () => {
		const plan = planCompaction(conversation(10), 6);
		expect(plan.system).toHaveLength(1);
		expect(plan.tail).toHaveLength(6);
		// 20 non-system messages, 6 kept.
		expect(plan.toSummarise).toHaveLength(14);
	});

	test("nothing to summarise when the conversation is already short", () => {
		const plan = planCompaction(conversation(2), 6);
		expect(plan.toSummarise).toHaveLength(0);
		expect(plan.tail).toHaveLength(4);
	});

	test("defaults the tail length", () => {
		expect(planCompaction(conversation(10)).tail).toHaveLength(DEFAULT_KEEP_TAIL);
	});
});

describe("applyCompaction", () => {
	test("puts the summary after the system prompt and before the tail", () => {
		const out = applyCompaction(conversation(10), "SUMMARY", 6);
		expect(out[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
		expect(out[1].content).toContain("SUMMARY");
		expect(out).toHaveLength(8); // system + summary + 6 tail
	});

	test("returns the history untouched when there is nothing to compact", () => {
		const history = conversation(1, 1);
		expect(applyCompaction(history, "SUMMARY", 6)).toEqual(history);
	});
});

describe("summaryMessage", () => {
	test("is labelled as machine-written and says how many messages it replaced", () => {
		const message = summaryMessage("body", 12);
		expect(message.role).toBe("user");
		expect(message.content).toContain("replaces 12 earlier message(s)");
		expect(message.content).toContain("not the user");
		expect(message.content).toContain("body");
	});
});

describe("compactHistory", () => {
	const ok = (content = "## Session Summary\n### Current State\n- a very short summary") => {
		return async () => ({
			choices: [{ message: { role: "assistant" as const, content } }],
			usage: { prompt_tokens: 50, completion_tokens: 10 },
		});
	};

	test("compacts a long conversation and reports what it dropped", async () => {
		const history = conversation(20, 200);
		const outcome = await compactHistory(history, ok());

		expect(outcome.history).not.toBeNull();
		expect(outcome.dropped).toBeGreaterThan(0);
		expect(outcome.kept).toBe(DEFAULT_KEEP_TAIL);
		expect(outcome.summary).toContain("very short summary");
		expect(outcome.usage.prompt_tokens).toBe(50);
	});

	test("the result really is smaller", async () => {
		const history = conversation(20, 200);
		const outcome = await compactHistory(history, ok());
		expect(estimateConversationTokens(outcome.history as Message[])).toBeLessThan(
			estimateConversationTokens(history),
		);
	});

	test("a short conversation is not compacted and the model is not called", async () => {
		let called = false;
		const caller = async () => {
			called = true;
			return { choices: [] };
		};
		const outcome = await compactHistory(conversation(2), caller);

		expect(outcome.history).toBeNull();
		expect(outcome.reason).toContain("Nothing to compact");
		expect(called).toBe(false);
	});

	test("a throwing summariser leaves the conversation unchanged", async () => {
		const outcome = await compactHistory(conversation(20), async () => {
			throw new Error("offline");
		});
		expect(outcome.history).toBeNull();
		expect(outcome.reason).toContain("left unchanged");
		expect(outcome.reason).toContain("offline");
	});

	test("an API error field is reported, not swallowed", async () => {
		const outcome = await compactHistory(conversation(20), async () => ({
			choices: [],
			error: { message: "rate limited" },
		}));
		expect(outcome.history).toBeNull();
		expect(outcome.reason).toContain("rate limited");
	});

	test("a summary that would not save tokens is refused", async () => {
		// A summary far longer than the conversation it replaces.
		const history = conversation(10, 5);
		const huge = "z".repeat(100_000);
		const outcome = await compactHistory(history, ok(huge));

		expect(outcome.history).toBeNull();
		expect(outcome.reason).toContain("would not have saved any tokens");
	});
});
