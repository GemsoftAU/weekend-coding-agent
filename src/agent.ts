// Agent turn runner. runTurn() drives one conversation turn: it sends the
// message history to the LLM, executes any requested tool calls (in parallel),
// and feeds the results back until the model produces a final answer,
// then returns the updated history and accumulated token usage.
import { callLLM } from "./lib/api";
import type { SessionLog } from "./lib/logger";
import {
	estimateConversationTokens,
	recordUsage,
	type SessionState,
	sessionStatusLine,
} from "./lib/session";
import type { Spinner } from "./lib/spinner";
import type { ApiCaller, Logger, Message, ToolExecutor, ToolSchema, TurnResult } from "./lib/types";
import { executeTool, TOOLS } from "./tools";

export interface RunTurnOptions {
	/** Animated indicator shown while waiting on the API. Optional, TTY-only. */
	spinner?: Spinner | null;
}

export async function runTurn(
	history: Message[],
	apiCaller: ApiCaller = callLLM,
	toolExecutor: ToolExecutor = executeTool,
	tools: ToolSchema[] = TOOLS,
	logger?: Logger,
	agentName = "default",
	session?: SessionState | null,
	sessionLog?: SessionLog | null,
	options: RunTurnOptions = {},
): Promise<TurnResult> {
	const currentMessages: Message[] = [...history];
	const usage = { prompt_tokens: 0, completion_tokens: 0 };
	let apiCallNumber = 0;
	const spinner = options.spinner ?? null;

	while (true) {
		apiCallNumber++;
		// Spin only while the request is in flight: the moment a token arrives the
		// glyph would collide with the model's own output.
		let response: Awaited<ReturnType<ApiCaller>>;
		try {
			spinner?.start();
			response = await apiCaller(currentMessages, tools);
		} finally {
			spinner?.stop();
		}

		if (response.error) {
			logger?.error(`[${agentName}] API error: ${response.error.message}`);
			throw new Error(response.error.message);
		}

		// Accumulate, never overwrite: every iteration of the loop costs tokens.
		usage.prompt_tokens += response.usage?.prompt_tokens ?? 0;
		usage.completion_tokens += response.usage?.completion_tokens ?? 0;
		if (session) recordUsage(session, response.usage);

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

			// The assistant tool_calls message, then each result, in call order.
			sessionLog?.log({ role: "assistant", content: m.content, tool_calls: m.tool_calls });

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
			for (const toolResult of toolResults) sessionLog?.log(toolResult);
		} else {
			currentMessages.push({ role: "assistant", content: m.content });
			sessionLog?.log({ role: "assistant", content: m.content });
			logger?.info(m.content ?? "");
		}

		// Log cost right after the response it came from, so the bill follows the output.
		if (session?.stats) {
			const inTok = response.usage?.prompt_tokens ?? 0;
			const outTok = response.usage?.completion_tokens ?? 0;
			const callCost = inTok * session.stats.cost.prompt + outTok * session.stats.cost.completion;
			logger?.info(`[API ${apiCallNumber}] ${inTok} in / ${outTok} out | $${callCost.toFixed(6)}`);
		}

		if (!m.tool_calls || m.tool_calls.length === 0) break;
	}

	// Status after the turn: how full the context is and what the session has cost.
	if (logger && session?.stats) {
		logger.info(sessionStatusLine(session, estimateConversationTokens(currentMessages)));
	}

	return { messages: currentMessages, usage };
}
