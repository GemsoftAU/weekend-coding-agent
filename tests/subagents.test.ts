import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SUBAGENT_DEPTH, runTurn } from "../src/agent";
import {
	getPrompt,
	listPrompts,
	loadPrompt,
	loadPrompts,
	resetPromptCache,
} from "../src/lib/prompts";
import { createSession } from "../src/lib/session";
import type { CompletionResponse, Logger, Message, ToolSchema } from "../src/lib/types";
import { executeTool, subagentTool, toolsForPrompt } from "../src/tools";

/** Scripted fake: each call returns the next canned response and records its input. */
function scriptedApi(responses: CompletionResponse[]) {
	const seen: Array<{ messages: Message[]; tools: ToolSchema[] }> = [];
	let i = 0;
	const caller = async (messages: Message[], tools: ToolSchema[]) => {
		seen.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
		return responses[i++];
	};
	return { caller, seen, calls: () => i };
}

function toolCall(name: string, args: Record<string, unknown>, id = "call_1"): CompletionResponse {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					tool_calls: [
						{ id, type: "function", function: { name, arguments: JSON.stringify(args) } },
					],
				},
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	};
}

function text(content: string): CompletionResponse {
	return {
		choices: [{ message: { role: "assistant", content } }],
		usage: { prompt_tokens: 20, completion_tokens: 3 },
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "subagents-"));
	resetPromptCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetPromptCache();
});

function writePrompt(name: string, frontmatter: string, body: string): void {
	writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("prompt registry", () => {
	test("loads every prompt file, keyed by its declared name", () => {
		writePrompt("alpha", "name: alpha\ndescription: first\ntools: [read_file]", "A");
		writePrompt("beta", "name: beta\ndescription: second\ntools: [list_files]", "B");

		const registry = loadPrompts(dir);
		expect(Object.keys(registry).sort()).toEqual(["alpha", "beta"]);
		expect(registry.alpha.body).toBe("A");
	});

	test("getPrompt returns the named prompt", () => {
		writePrompt("alpha", "name: alpha\ndescription: first\ntools: [read_file]", "A");
		expect(getPrompt("alpha", dir).frontmatter.description).toBe("first");
	});

	test("an unknown prompt is an error that names the known ones", () => {
		writePrompt("alpha", "name: alpha\ndescription: first\ntools: [read_file]", "A");
		expect(() => getPrompt("ghost", dir)).toThrow("Prompt not found: ghost");
		expect(() => getPrompt("ghost", dir)).toThrow("alpha");
	});

	test("listPrompts is sorted by name", () => {
		writePrompt("zeta", "name: zeta\ndescription: z\ntools: []", "Z");
		writePrompt("alpha", "name: alpha\ndescription: a\ntools: []", "A");
		expect(listPrompts(dir).map((p) => p.frontmatter.name)).toEqual(["alpha", "zeta"]);
	});

	test("a missing directory yields an empty registry, not a throw", () => {
		expect(loadPrompts(join(dir, "nope"))).toEqual({});
	});

	test("the registry is cached until reset", () => {
		writePrompt("alpha", "name: alpha\ndescription: first\ntools: []", "A");
		expect(Object.keys(loadPrompts(dir))).toEqual(["alpha"]);
		writePrompt("beta", "name: beta\ndescription: second\ntools: []", "B");
		// Still the cached view: the app reads prompts once per process.
		expect(Object.keys(loadPrompts(dir))).toEqual(["alpha"]);
		resetPromptCache();
		expect(Object.keys(loadPrompts(dir)).sort()).toEqual(["alpha", "beta"]);
	});
});

describe("shipped prompt arsenal", () => {
	const names = ["default", "code-map", "tech-researcher", "feature-planner", "poet"];

	for (const name of names) {
		test(`${name}.md exists and declares only tools that exist`, () => {
			const template = loadPrompt(name);
			expect(template.frontmatter.name).toBe(name);
			expect(template.frontmatter.description.length).toBeGreaterThan(20);
			expect(() => toolsForPrompt(template.frontmatter.tools)).not.toThrow();
		});
	}

	test("every declared subagent resolves to a real prompt", () => {
		const { frontmatter } = loadPrompt("default");
		expect(frontmatter.subagents.length).toBeGreaterThan(0);
		for (const name of frontmatter.subagents) {
			expect(() => loadPrompt(name)).not.toThrow();
		}
	});

	test("the code-map agent can read and write but not run commands", () => {
		const { frontmatter } = loadPrompt("code-map");
		expect(frontmatter.tools).toContain("read_file");
		expect(frontmatter.tools).toContain("write_file");
		expect(frontmatter.tools).not.toContain("bash");
	});

	test("the poet is the human-in-the-loop agent: ask_user only", () => {
		expect(loadPrompt("poet").frontmatter.tools).toEqual(["ask_user"]);
	});

	test("the feature planner is read-only apart from writing its plan", () => {
		const { frontmatter } = loadPrompt("feature-planner");
		expect(frontmatter.tools).not.toContain("bash");
		expect(frontmatter.tools).not.toContain("replace_in_file");
		expect(frontmatter.tools).toContain("write_file");
	});
});

describe("subagent tool schema", () => {
	test("the agentName enum lists exactly the declared subagents", () => {
		const tool = subagentTool(["code-map", "poet"]);
		const params = tool.function.parameters as {
			properties: { agentName: { enum: string[] } };
			required: string[];
		};
		expect(params.properties.agentName.enum).toEqual(["code-map", "poet"]);
		expect(params.required).toEqual(["agentName", "task"]);
	});

	test("a prompt with subagents gets run_agent appended", () => {
		const tools = toolsForPrompt(["read_file"], ["poet"]);
		expect(tools.map((t) => t.function.name)).toEqual(["read_file", "run_agent"]);
	});

	test("a prompt without subagents gets no run_agent", () => {
		const tools = toolsForPrompt(["read_file"]);
		expect(tools.map((t) => t.function.name)).toEqual(["read_file"]);
	});
});

describe("run_agent", () => {
	test("runs the named subagent with its own prompt and tools, and returns its answer", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: [read_file]", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			text("sub answer"),
			text("parent done"),
		]);

		const result = await runTurn(
			[{ role: "user", content: "delegate" }],
			api.caller,
			executeTool,
			toolsForPrompt(["read_file"], ["helper"]),
			undefined,
			"default",
			null,
			null,
			{ promptDir: dir },
		);

		// The subagent's first call carries its own system prompt and the task.
		const subCall = api.seen[1];
		expect(subCall.messages[0]).toEqual({ role: "system", content: "You help." });
		expect(subCall.messages[1]).toEqual({ role: "user", content: "do it" });
		// And only the tools its prompt declares.
		expect(subCall.tools.map((t) => t.function.name)).toEqual(["read_file"]);

		// The parent sees the subagent's answer as the tool result.
		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage?.content).toBe("sub answer");
	});

	test("the subagent does not see the parent's conversation", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: []", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "just this" }),
			text("sub answer"),
			text("parent done"),
		]);

		await runTurn(
			[{ role: "user", content: "SECRET PARENT CONTEXT" }],
			api.caller,
			executeTool,
			toolsForPrompt([], ["helper"]),
			undefined,
			"default",
			null,
			null,
			{ promptDir: dir },
		);

		const subMessages = api.seen[1].messages;
		expect(subMessages.some((m) => m.content?.includes("SECRET PARENT CONTEXT"))).toBe(false);
	});

	test("an unknown subagent name is reported back as a tool error", async () => {
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "ghost", task: "x" }),
			text("parent done"),
		]);

		const result = await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["ghost"]),
			undefined,
			"default",
			null,
			null,
			{ promptDir: dir },
		);

		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage?.content).toContain("Tool error");
		expect(toolMessage?.content).toContain("Prompt not found");
	});

	test("subagent boundaries are printed so nested output is legible", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: []", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			text("sub answer"),
			text("parent done"),
		]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["helper"]),
			logger,
			"default",
			null,
			null,
			{ promptDir: dir },
		);

		expect(lines).toContain("--- [Subagent Start] helper ---\nTask: do it");
		expect(lines).toContain("--- [Subagent End] helper ---");
		expect(lines.indexOf("--- [Subagent Start] helper ---\nTask: do it")).toBeLessThan(
			lines.indexOf("--- [Subagent End] helper ---"),
		);
	});

	test("a subagent that returns no text still yields a usable result", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: []", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			{ choices: [{ message: { role: "assistant", content: "" } }] },
			text("parent done"),
		]);

		const result = await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["helper"]),
			undefined,
			"default",
			null,
			null,
			{ promptDir: dir },
		);

		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage?.content).toContain("without specific output");
	});

	test("subagent usage is folded into the session totals, not the parent turn's", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: []", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			text("sub answer"),
			text("parent done"),
		]);
		const session = createSession(null);

		const result = await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["helper"]),
			undefined,
			"default",
			session,
			null,
			{ promptDir: dir },
		);

		// The session pays for every call, including the subagent's: 10+20+20 in.
		expect(session.promptTokens).toBe(50);
		expect(session.completionTokens).toBe(11);
		// The parent's own turn usage counts only the calls it made itself.
		expect(result.usage).toEqual({ prompt_tokens: 30, completion_tokens: 8 });
	});

	test("nesting stops at MAX_SUBAGENT_DEPTH instead of recursing forever", async () => {
		// A prompt that declares itself as a subagent is the pathological case.
		writePrompt("loop", "name: loop\ndescription: loops\ntools: []\nsubagents: [loop]", "Loop.");
		const api = scriptedApi([
			// depth 0 -> spawns depth 1
			toolCall("run_agent", { agentName: "loop", task: "again" }),
			// depth 1 -> spawns depth 2
			toolCall("run_agent", { agentName: "loop", task: "again" }, "call_2"),
			// depth 2 -> refused, so it answers instead of spawning again
			toolCall("run_agent", { agentName: "loop", task: "again" }, "call_3"),
			text("depth 2 done"),
			text("depth 1 done"),
			text("parent done"),
		]);
		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["loop"]),
			logger,
			"default",
			null,
			null,
			{ promptDir: dir },
		);

		// The refusal is a tool result the deepest agent sees, so it stops there.
		expect(lines.some((l) => l.includes("cannot nest"))).toBe(true);
		// Bounded: one spawn per level, then answers all the way back up.
		expect(api.calls()).toBe(MAX_SUBAGENT_DEPTH + 4);
	});
});

describe("subagent session logging", () => {
	function memoryLog() {
		const entries: Array<{
			sessionId: string;
			parentId: string | null;
			agentName: string;
			message: Message;
		}> = [];
		const make = (sessionId: string, parentId: string | null, agentName: string) => ({
			logFile: "memory.jsonl",
			sessionId,
			parentId,
			agentName,
			log(message: Message) {
				entries.push({ sessionId, parentId, agentName, message });
			},
			child(name: string, parent?: string) {
				return make(`child-${name}`, parent ?? sessionId, name);
			},
		});
		return { log: make("parent", null, "default"), entries };
	}

	test("the subagent gets its own session id pointing at the parent", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: []", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			text("sub answer"),
			text("parent done"),
		]);
		const memory = memoryLog();

		await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["helper"]),
			undefined,
			"default",
			null,
			memory.log,
			{ promptDir: dir },
		);

		const subEntries = memory.entries.filter((e) => e.agentName === "helper");
		expect(subEntries.length).toBeGreaterThan(0);
		expect(subEntries[0].sessionId).toBe("child-helper");
		expect(subEntries[0].parentId).toBe("parent");
		// The subagent's own prompt and task are the first things in its log.
		expect(subEntries[0].message).toEqual({ role: "system", content: "You help." });
		expect(subEntries[1].message).toEqual({ role: "user", content: "do it" });
	});

	test("parent entries keep the parent session id", async () => {
		writePrompt("helper", "name: helper\ndescription: helps\ntools: []", "You help.");
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			text("sub answer"),
			text("parent done"),
		]);
		const memory = memoryLog();

		await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["helper"]),
			undefined,
			"default",
			null,
			memory.log,
			{ promptDir: dir },
		);

		const parentEntries = memory.entries.filter((e) => e.agentName === "default");
		expect(parentEntries.every((e) => e.sessionId === "parent")).toBe(true);
	});
});

describe("ask_user", () => {
	test("reaches the injected human and returns their answer", async () => {
		const asked: string[] = [];
		const out = await executeTool(
			"ask_user",
			{ question: "What is your name?" },
			{
				askUser: async (q) => {
					asked.push(q);
					return "Alice";
				},
			},
		);
		expect(asked).toEqual(["What is your name?"]);
		expect(out).toBe("Alice");
	});

	test("without an interactive context it reports a tool error", async () => {
		const out = await executeTool("ask_user", { question: "hi" });
		expect(out).toContain("Tool error");
	});

	test("requires a question", async () => {
		const out = await executeTool("ask_user", {}, { askUser: async () => "x" });
		expect(out).toContain("Tool error");
	});

	test("a subagent can ask the human through the same context", async () => {
		writePrompt(
			"poet",
			"name: poet\ndescription: writes poems\ntools: [ask_user]",
			"Ask, then write.",
		);
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "poet", task: "write a poem" }),
			toolCall("ask_user", { question: "What is your name?" }, "call_q"),
			text("A poem for Alice."),
			text("parent done"),
		]);

		const lines: string[] = [];
		const logger: Logger = { info: (m) => lines.push(m), error: () => {} };

		const result = await runTurn(
			[],
			api.caller,
			executeTool,
			toolsForPrompt([], ["poet"]),
			logger,
			"default",
			null,
			null,
			{ promptDir: dir, askUser: async () => "Alice" },
		);

		// The human's answer reached the subagent as a tool result...
		expect(lines).toContain("Alice");
		// ...and the poem came back to the parent as the run_agent result.
		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage?.content).toBe("A poem for Alice.");
	});
});
