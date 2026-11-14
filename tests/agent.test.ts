import { describe, expect, test } from "bun:test";
import { runTurn } from "../src/agent";
import type { ModelStats } from "../src/lib/api";
import { createSession } from "../src/lib/session";
import type { CompletionResponse, Logger, Message, ToolSchema } from "../src/lib/types";

/** Scripted fake: each call returns the next canned response and records its input. */
function scriptedApi(responses: CompletionResponse[]) {
	const seen: Message[][] = [];
	let i = 0;
	const caller = async (messages: Message[], _tools: ToolSchema[]) => {
		seen.push(structuredClone(messages));
		return responses[i++];
	};
	return { caller, seen, calls: () => i };
}

const toolCallReply: CompletionResponse = {
	choices: [
		{
			message: {
				role: "assistant",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"echo hi"}' },
					},
				],
			},
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const textReply: CompletionResponse = {
	choices: [{ message: { role: "assistant", content: "Done." } }],
	usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
};

describe("runTurn", () => {
	test("executes a tool call, feeds the result back, then stops on text", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
		const fakeExecutor = async (name: string, args: Record<string, unknown>) => {
			executed.push({ name, args });
			return "file.txt";
		};

		const result = await runTurn(
			[{ role: "user", content: "list files" }],
			api.caller,
			fakeExecutor,
		);

		// Two round trips: one to get the tool call, one to finish with text.
		expect(api.calls()).toBe(2);
		// The injected executor was used; no real shell ran.
		expect(executed).toEqual([{ name: "bash", args: { command: "echo hi" } }]);
		// The tool result was appended and the final text message closed the loop.
		expect(result.messages.some((m) => m.role === "tool" && m.content === "file.txt")).toBe(true);
		expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "Done." });
		// Token usage accumulates across iterations instead of being overwritten.
		expect(result.usage).toEqual({ prompt_tokens: 30, completion_tokens: 8 });
	});

	test("the tool result is visible to the model on the second call", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		await runTurn([], api.caller, async () => "file.txt");

		const secondCallMessages = api.seen[1];
		const toolMessage = secondCallMessages.find((m) => m.role === "tool");
		expect(toolMessage?.tool_call_id).toBe("call_1");
		expect(toolMessage?.content).toBe("file.txt");
		// The assistant tool_calls must be present or the tool reply is orphaned.
		expect(secondCallMessages.some((m) => m.role === "assistant" && m.tool_calls)).toBe(true);
	});

	test("stops after one call when the reply is plain text", async () => {
		const api = scriptedApi([textReply]);
		const result = await runTurn([{ role: "user", content: "hi" }], api.caller, async () => "x");
		expect(api.calls()).toBe(1);
		expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(0);
		expect(result.messages.at(-1)?.content).toBe("Done.");
	});

	test("reports malformed tool arguments back to the model instead of crashing", async () => {
		const broken: CompletionResponse = {
			choices: [
				{
					message: {
						role: "assistant",
						tool_calls: [
							{
								id: "call_bad",
								type: "function",
								function: { name: "bash", arguments: "{not json" },
							},
						],
					},
				},
			],
		};
		const api = scriptedApi([broken, textReply]);
		const result = await runTurn([], api.caller, async () => "unused");
		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage?.content).toContain("Tool error");
	});

	test("surfaces API errors as thrown exceptions", async () => {
		const api = scriptedApi([{ choices: [], error: { message: "rate limited" } }]);
		expect(runTurn([], api.caller, async () => "x")).rejects.toThrow("rate limited");
	});

	test("does not mutate the caller's history array in place", async () => {
		const api = scriptedApi([textReply]);
		const history: Message[] = [{ role: "user", content: "hi" }];
		await runTurn(history, api.caller, async () => "x");
		expect(history).toHaveLength(1);
	});

	const stats: ModelStats = {
		name: "Test Model",
		contextLength: 1048576,
		cost: { prompt: 0.001, completion: 0.002 },
	};

	test("logs cost per API call using the response usage and stats prices", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn(
			[],
			api.caller,
			async () => "file.txt",
			undefined,
			logger,
			"default",
			createSession(stats),
		);

		// Two API calls, one cost line each: 10*0.001 + 5*0.002 = 0.02, 20*0.001 + 3*0.002 = 0.026.
		expect(lines.filter((l) => l.startsWith("[API "))).toEqual([
			"[API 1] 10 in / 5 out | $0.020000",
			"[API 2] 20 in / 3 out | $0.026000",
		]);
	});

	test("cost lines follow the output of the round they belong to", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn(
			[],
			api.caller,
			async () => "file.txt",
			undefined,
			logger,
			"default",
			createSession(stats),
		);

		// Round 1: tool call line, then its result, then its bill. Round 2: answer, then its bill.
		const order = lines.map((l) =>
			l.startsWith("[API 1]") ? "bill1" : l.startsWith("[API 2]") ? "bill2" : l,
		);
		expect(order.indexOf("file.txt")).toBeLessThan(order.indexOf("bill1"));
		expect(order.indexOf("Done.")).toBeLessThan(order.indexOf("bill2"));
	});

	test("omits cost lines when no model stats are available", async () => {
		const api = scriptedApi([textReply]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn([], api.caller, async () => "x", undefined, logger, "default", null);

		expect(lines.filter((l) => l.startsWith("[API "))).toHaveLength(0);
	});

	test("logs a session status line with the accumulated cost after the turn", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };
		const session = createSession(stats);

		await runTurn([], api.caller, async () => "file.txt", undefined, logger, "default", session);

		// Totals across both calls: 30 in / 8 out, cost 0.02 + 0.026 = 0.046.
		expect(session.promptTokens).toBe(30);
		expect(session.completionTokens).toBe(8);
		expect(session.totalCost).toBeCloseTo(0.046);

		const status = lines.find((l) => l.startsWith("[Session]"));
		expect(status).toBeDefined();
		expect(status).toContain("Context:");
		expect(status).toContain("Cost: $0.046000");
	});

	test("the session status line appears after the final answer", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn(
			[],
			api.caller,
			async () => "file.txt",
			undefined,
			logger,
			"default",
			createSession(stats),
		);

		expect(lines.indexOf("Done.")).toBeLessThan(lines.findIndex((l) => l.startsWith("[Session]")));
	});
});

describe("runTurn spinner", () => {
	/** Records start/stop ordering without needing a TTY or real timers. */
	function fakeSpinner() {
		const events: string[] = [];
		let active = false;
		return {
			events,
			spinner: {
				start() {
					active = true;
					events.push("start");
				},
				stop() {
					active = false;
					events.push("stop");
				},
				get active() {
					return active;
				},
			},
		};
	}

	test("spins once per API call and is idle when the turn ends", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const fake = fakeSpinner();

		await runTurn(
			[],
			api.caller,
			async () => "file.txt",
			undefined,
			undefined,
			"default",
			null,
			null,
			{ spinner: fake.spinner },
		);

		// Two round trips, so two start/stop pairs, and it must end stopped.
		expect(fake.events).toEqual(["start", "stop", "start", "stop"]);
		expect(fake.spinner.active).toBe(false);
	});

	test("the spinner stops before the response is logged, so the glyph never lands in the output", async () => {
		const api = scriptedApi([textReply]);
		const fake = fakeSpinner();
		const lines: string[] = [];

		await runTurn(
			[],
			api.caller,
			async () => "x",
			undefined,
			{ info: (m) => lines.push(m), error: () => {} },
			"default",
			null,
			null,
			{ spinner: fake.spinner },
		);

		// Last spinner event is a stop, so nothing is animating while output prints.
		expect(fake.events.at(-1)).toBe("stop");
		expect(lines).toContain("Done.");
	});

	test("stops the spinner even when the API call throws", async () => {
		const fake = fakeSpinner();
		const boom = async () => {
			throw new Error("network down");
		};

		expect(
			runTurn([], boom, async () => "x", undefined, undefined, "d", null, null, {
				spinner: fake.spinner,
			}),
		).rejects.toThrow("network down");

		// A leaked interval would keep writing to the terminal forever.
		expect(fake.events).toEqual(["start", "stop"]);
		expect(fake.spinner.active).toBe(false);
	});

	test("works with no spinner supplied", async () => {
		const api = scriptedApi([textReply]);
		const result = await runTurn([], api.caller, async () => "x");
		expect(result.messages.at(-1)?.content).toBe("Done.");
	});
});

describe("runTurn session logging", () => {
	/** In-memory SessionLog so the agent tests never touch the filesystem. */
	function memoryLog() {
		const entries: Array<{ agentName: string; message: Message }> = [];
		const log = {
			logFile: "memory.jsonl",
			sessionId: "s1",
			parentId: null,
			agentName: "main",
			log(message: Message) {
				entries.push({ agentName: "main", message });
			},
			child(agentName: string, parentId?: string) {
				return { ...log, agentName, parentId: parentId ?? "s1", sessionId: "s2" };
			},
		};
		return { log, entries };
	}

	test("records the assistant tool call, the tool result, and the answer", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const memory = memoryLog();

		await runTurn(
			[{ role: "user", content: "list files" }],
			api.caller,
			async () => "file.txt",
			undefined,
			undefined,
			"default",
			null,
			memory.log,
		);

		expect(memory.entries.map((e) => e.message.role)).toEqual(["assistant", "tool", "assistant"]);
		// The tool call is kept with its id, or the log cannot be replayed.
		expect(memory.entries[0].message.tool_calls?.[0].function.name).toBe("bash");
		expect(memory.entries[1].message.tool_call_id).toBe("call_1");
		expect(memory.entries[1].message.content).toBe("file.txt");
		expect(memory.entries[2].message.content).toBe("Done.");
	});

	test("logs a plain text reply with no tool calls", async () => {
		const api = scriptedApi([textReply]);
		const memory = memoryLog();

		await runTurn([], api.caller, async () => "x", undefined, undefined, "d", null, memory.log);

		expect(memory.entries.map((e) => e.message.content)).toEqual(["Done."]);
	});

	test("no session log means no logging and no crash", async () => {
		const api = scriptedApi([textReply]);
		const result = await runTurn(
			[],
			api.caller,
			async () => "x",
			undefined,
			undefined,
			"d",
			null,
			null,
		);
		expect(result.messages.at(-1)?.content).toBe("Done.");
	});

	test("the log mirrors the final history, minus the user message runTurn was given", async () => {
		const api = scriptedApi([toolCallReply, textReply]);
		const memory = memoryLog();

		const result = await runTurn(
			[{ role: "user", content: "list files" }],
			api.caller,
			async () => "file.txt",
			undefined,
			undefined,
			"default",
			null,
			memory.log,
		);

		// Everything the model produced or saw is in the log, in order.
		const logged = memory.entries.map((e) => e.message);
		expect(logged).toEqual(result.messages.slice(1));
	});
});
