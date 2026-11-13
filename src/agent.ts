// Agent turn runner. runTurn() drives one conversation turn: it sends the
// message history to the LLM, executes any requested tool calls (in parallel),
// and feeds the results back until the model produces a final answer,
// then returns the updated history and accumulated token usage.
import { callLLM } from "./lib/api";
import type { ApiCaller, Logger, Message, ToolExecutor, ToolSchema, TurnResult } from "./lib/types";
import { executeTool, TOOLS } from "./tools";

export async function runTurn(
	history: Message[],
	apiCaller: ApiCaller = callLLM,
	toolExecutor: ToolExecutor = executeTool,
	tools: ToolSchema[] = TOOLS,
	logger?: Logger,
	agentName = "default",
): Promise<TurnResult> {
	const currentMessages: Message[] = [...history];
	const usage = { prompt_tokens: 0, completion_tokens: 0 };

	while (true) {
		const response = await apiCaller(currentMessages, tools);

		if (response.error) {
			logger?.error(`[${agentName}] API error: ${response.error.message}`);
			throw new Error(response.error.message);
		}

		// Accumulate, never overwrite: every iteration of the loop costs tokens.
		usage.prompt_tokens += response.usage?.prompt_tokens ?? 0;
		usage.completion_tokens += response.usage?.completion_tokens ?? 0;

		const m = response.choices[0].message;

		if (m.tool_calls && m.tool_calls.length > 0) {
			currentMessages.push({
				role: "assistant",
				content: m.content,
				tool_calls: m.tool_calls,
			});

			for (const toolCall of m.tool_calls) {
				logger?.info(`$ ${toolCall.function.name} ${toolCall.function.arguments}`);
			}

			const toolResults = await Promise.all(
				m.tool_calls.map(async (toolCall) => {
					let content: string;
					try {
						const args = JSON.parse(toolCall.function.arguments || "{}");
						content = await toolExecutor(toolCall.function.name, args);
					} catch (e: unknown) {
						content = `Tool error: ${(e as Error).message}`;
					}
					logger?.info(content);
					return {
						role: "tool" as const,
						tool_call_id: toolCall.id,
						content,
					};
				}),
			);

			currentMessages.push(...toolResults);
		} else {
			currentMessages.push({ role: "assistant", content: m.content });
			logger?.info(m.content ?? "");
			break;
		}
	}

	return { messages: currentMessages, usage };
}
