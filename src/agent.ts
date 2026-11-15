// Agent turn runner. runTurn() drives one conversation turn: it sends the
// message history to the LLM, executes any requested tool calls (in parallel),
// and feeds the results back until the model produces a final answer,
// then returns the updated history and accumulated token usage.
//
// A subagent is the same loop, run again with a different prompt and tool set.
// `run_agent` is therefore not a special case in the loop: it is a tool whose
// implementation happens to be a nested runTurn().
import { callLLM } from "./lib/api";
import { compactHistory, shouldCompact } from "./lib/compaction";
import type { SessionLog } from "./lib/logger";
import { getPrompt } from "./lib/prompts";
import {
	estimateConversationTokens,
	recordUsage,
	type SessionState,
	sessionStatusLine,
} from "./lib/session";
import { buildSystemPrompt, type Skill } from "./lib/skills";
import type { Spinner } from "./lib/spinner";
import type {
	AgentRunner,
	ApiCaller,
	AskUser,
	Logger,
	Message,
	ToolContext,
	ToolExecutor,
	ToolSchema,
	TurnResult,
} from "./lib/types";
import {
	formatReasoning,
	formatSubagentEnd,
	formatSubagentStart,
	formatToolCall,
	formatToolResult,
} from "./lib/ui";
import { executeTool, TOOLS, toolsForPrompt } from "./tools";

/** How deep subagents may nest. A subagent that spawns subagents forever is a bug. */
export const MAX_SUBAGENT_DEPTH = 2;

export interface RunTurnOptions {
	/** Animated indicator shown while waiting on the API. Optional, TTY-only. */
	spinner?: Spinner | null;
	/** Directory holding the prompt files subagents are loaded from. */
	promptDir?: string;
	/** How the human is reached when a subagent calls `ask_user`. */
	askUser?: AskUser;
	/** Nesting level; 0 is the top-level agent. */
	depth?: number;
	/** Skills available to `use_skill`. Inherited by subagents, which cannot discover them alone. */
	skills?: Skill[];
	/**
	 * Summarise the conversation automatically when it nears the context window.
	 * Opt-in: a turn that compacts spends tokens and rewrites history, which a
	 * caller that did not ask for it must not get.
	 */
	autoCompact?: boolean;
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
	const depth = options.depth ?? 0;

	// The subagent runner closes over this turn's dependencies, so a nested turn
	// uses the same API client, executor, session and log as its parent.
	const agentRunner: AgentRunner = async (subAgentName: string, task: string) => {
		if (depth >= MAX_SUBAGENT_DEPTH) {
			return `Tool error: subagents cannot nest more than ${MAX_SUBAGENT_DEPTH} levels deep`;
		}

		const prompt = getPrompt(subAgentName, options.promptDir);
		const subTools = toolsForPrompt(prompt.frontmatter.tools, prompt.frontmatter.subagents);

		logger?.info(formatSubagentStart(subAgentName, task));

		// A subagent starts from its own prompt and the task, never from the
		// parent's history: that isolation is the point of delegating. The skills
		// listing is the one thing that carries over, and only to a subagent that
		// has a way to act on it: offering skills to an agent whose only tool is
		// `ask_user` is tokens spent on instructions it cannot follow.
		const canLoadSkills = subTools.some((t) =>
			["use_skill", "read_file"].includes(t.function.name),
		);
		const subHistory: Message[] = [
			{
				role: "system",
				content: buildSystemPrompt({
					body: prompt.body,
					skills: canLoadSkills ? options.skills : [],
				}),
			},
			{ role: "user", content: task },
		];
		const subLog = sessionLog?.child(subAgentName) ?? null;
		subLog?.log(subHistory[0]);
		subLog?.log(subHistory[1]);

		const result = await runTurn(
			subHistory,
			apiCaller,
			toolExecutor,
			subTools,
			logger,
			subAgentName,
			session,
			subLog,
			{ ...options, depth: depth + 1 },
		);

		logger?.info(formatSubagentEnd(subAgentName));

		const last = result.messages.at(-1);
		if (last?.role === "assistant" && last.content) return last.content;
		return "Subagent completed without specific output.";
	};

	const toolContext: ToolContext = {
		agentRunner,
		askUser: options.askUser,
		skills: options.skills,
	};

	// Auto-compaction: when the conversation approaches the window, summarise it
	// before the next call instead of letting the provider truncate it silently.
	// Off by default so existing callers and tests keep their exact behaviour.
	const autoCompact = options.autoCompact ?? false;
	const contextLength = session?.stats?.contextLength ?? 0;
	const compactIfNeeded = async (messages: Message[]): Promise<Message[]> => {
		if (!autoCompact || !shouldCompact(messages, contextLength)) return messages;

		logger?.info("[Compact] Context is near the window limit; summarising older turns.");
		const outcome = await compactHistory(messages, apiCaller);
		if (outcome.history) {
			// The summariser is a real API call: bill it like any other.
			if (session) recordUsage(session, outcome.usage);
			logger?.info(
				`[Compact] Summarised ${outcome.dropped} message(s); kept ${outcome.kept}. ` +
					`(${outcome.usage.prompt_tokens} in / ${outcome.usage.completion_tokens} out)`,
			);
			return outcome.history;
		}
		logger?.info(`[Compact] Skipped: ${outcome.reason ?? "unknown reason"}`);
		return messages;
	};

	while (true) {
		apiCallNumber++;
		// Compact before the call, not after: the point is to keep the request
		// that is about to be sent inside the window.
		const compacted = await compactIfNeeded(currentMessages);
		if (compacted !== currentMessages) {
			currentMessages.length = 0;
			currentMessages.push(...compacted);
		}
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

		// Show the model's thinking before its action: it explains the tool call.
		const reasoning = formatReasoning(m.reasoning_details);
		if (reasoning) logger?.info(reasoning);

		if (m.tool_calls && m.tool_calls.length > 0) {
			currentMessages.push({
				role: "assistant",
				content: m.content,
				tool_calls: m.tool_calls,
			});

			for (const toolCall of m.tool_calls) {
				logger?.info(formatToolCall(toolCall.function.name, toolCall.function.arguments));
			}

			// The assistant tool_calls message, then each result, in call order.
			sessionLog?.log({ role: "assistant", content: m.content, tool_calls: m.tool_calls });

			const toolResults = await Promise.all(
				m.tool_calls.map(async (toolCall) => {
					let content: string;
					try {
						const args = JSON.parse(toolCall.function.arguments || "{}");
						content = await toolExecutor(toolCall.function.name, args, toolContext);
					} catch (e: unknown) {
						content = `Tool error: ${(e as Error).message}`;
					}
					logger?.info(formatToolResult(content));
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
