import { describe, expect, test } from "bun:test";
import { runTurn } from "../src/agent";
import type { CompletionResponse, Message, ToolSchema } from "../src/lib/types";

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
});
