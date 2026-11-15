import type { Skill } from "./skills";

export interface ToolCall {
	id: string;
	type?: string;
	function: { name: string; arguments: string };
}

export interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content?: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	reasoning_details?: unknown;
	name?: string;
}

export interface ToolSchema {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens?: number;
}

export interface CompletionResponse {
	choices: { message: Message }[];
	usage?: Usage;
	error?: { message: string };
}

export type ApiCaller = (messages: Message[], tools: ToolSchema[]) => Promise<CompletionResponse>;

/**
 * Runs a named subagent to completion and returns its final answer. Injected
 * into the tool layer so `run_agent` can be tested without a real model.
 */
export type AgentRunner = (agentName: string, task: string) => Promise<string>;

/** Asks the human a question and resolves with their answer. */
export type AskUser = (question: string) => Promise<string>;

/**
 * Per-call dependencies for tools that cannot work from arguments alone.
 * Optional so every existing tool stays a pure `(name, args)` function.
 */
export interface ToolContext {
	agentRunner?: AgentRunner;
	askUser?: AskUser;
	/** Skills discovered at startup, for `use_skill` and `list_skills`. */
	skills?: Skill[];
}

export type ToolExecutor = (
	name: string,
	args: Record<string, unknown>,
	context?: ToolContext,
) => Promise<string>;

export interface Logger {
	info: (msg: string) => void;
	error: (msg: string) => void;
}

export interface TurnResult {
	messages: Message[];
	usage: { prompt_tokens: number; completion_tokens: number };
}
