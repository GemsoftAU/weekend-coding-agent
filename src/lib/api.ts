import type { ApiCaller, CompletionResponse, Message, ToolSchema } from "./types";

export const API = "https://openrouter.ai/api/v1/chat/completions";
export const MODEL = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";

/** Real OpenRouter client. Tests never call this - they inject a fake ApiCaller. */
export const callLLM: ApiCaller = async (
	messages: Message[],
	tools: ToolSchema[],
): Promise<CompletionResponse> => {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");

	const res = await fetch(API, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: MODEL, messages, tools }),
	});

	return (await res.json()) as CompletionResponse;
};
