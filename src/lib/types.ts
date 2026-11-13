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

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface Logger {
	info: (msg: string) => void;
	error: (msg: string) => void;
}

export interface TurnResult {
	messages: Message[];
	usage: { prompt_tokens: number; completion_tokens: number };
}
