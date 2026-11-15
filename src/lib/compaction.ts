// Context compaction: replace a long conversation with a summary plus a short
// tail of recent turns.
//
// Why this is a model call and not a splice: dropping old messages silently
// loses the decisions that produced the current state, and the agent then
// re-derives (or contradicts) work it already did. A summary keeps the
// decisions and the file list while collapsing the tokens spent discovering
// them.
//
// The pure half (build the request, apply the result) is separated from the
// async half (call the model) so the interesting logic is testable without a
// network, matching how runTurn() takes an injected ApiCaller.
import { estimateConversationTokens } from "./session";
import type { ApiCaller, Message } from "./types";

/** Compact once the conversation is this fraction of the context window. */
export const COMPACT_THRESHOLD = 0.8;

/** How many recent non-system messages to keep verbatim after compaction. */
export const DEFAULT_KEEP_TAIL = 6;

/** Cap on any single message rendered into the transcript, so the summariser
 *  does not itself blow the window on one giant tool result. */
export const TRANSCRIPT_MSG_MAX_CHARS = 2_000;

/**
 * True when the conversation is close enough to the window that the next turn
 * is at risk. `contextLength` of 0 or less means the window is unknown, and an
 * unknown window must never trigger a paid compaction: no signal, no action.
 */
export function shouldCompact(
	history: Message[],
	contextLength: number,
	ratio = COMPACT_THRESHOLD,
): boolean {
	if (contextLength <= 0) return false;
	return estimateConversationTokens(history) / contextLength >= ratio;
}

/** Percentage of the window used, for display. Null when the window is unknown. */
export function contextUsagePercent(history: Message[], contextLength: number): number | null {
	if (contextLength <= 0) return null;
	return (estimateConversationTokens(history) / contextLength) * 100;
}

function clip(text: string, max = TRANSCRIPT_MSG_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/**
 * Render the conversation as a compact transcript for the summariser. Tool
 * calls are named (not dumped) and tool results are clipped: the summariser
 * needs to know what was done, not every byte it was shown.
 */
export function renderTranscript(history: Message[]): string {
	const lines: string[] = [];

	for (const message of history) {
		if (message.role === "system") continue;

		if (message.tool_calls?.length) {
			const calls = message.tool_calls
				.map((call) => `${call.function.name}(${clip(call.function.arguments, 300)})`)
				.join(", ");
			lines.push(`ASSISTANT[tool calls]: ${calls}`);
			if (message.content?.trim()) {
				lines.push(`ASSISTANT: ${clip(message.content)}`);
			}
			continue;
		}

		if (message.role === "tool") {
			lines.push(`TOOL RESULT: ${clip(message.content ?? "")}`);
			continue;
		}

		const label = message.role === "user" ? "USER" : "ASSISTANT";
		lines.push(`${label}: ${clip(message.content ?? "")}`);
	}

	return lines.join("\n\n");
}

/** The instruction the summariser follows. Exported so tests can assert on it. */
export const SUMMARY_INSTRUCTIONS = [
	"Summarise the conversation below so another agent can continue the work with",
	"no other context. Be specific and terse. Use exactly these sections:",
	"",
	"## Session Summary",
	"### Current State",
	"- What is being built and where it stands",
	"- Files created or modified, by path",
	"- The last action taken and whether it succeeded",
	"### Key Decisions",
	"- Numbered list of choices made and the reasons, including ones rejected",
	"### Open Problems",
	"- Anything broken, unfinished, or uncertain",
	"### Pending Work",
	"- The next concrete steps",
	"",
	"Do not invent facts. If something is unknown, write 'unknown'. Do not",
	"include tool output verbatim; describe what it showed.",
].join("\n");

/**
 * Build the summariser's message list. The transcript goes in as one user
 * message so a provider that only accepts a single system message is happy.
 */
export function buildSummaryRequest(history: Message[]): Message[] {
	return [
		{ role: "system", content: SUMMARY_INSTRUCTIONS },
		{ role: "user", content: `Conversation to summarise:\n\n${renderTranscript(history)}` },
	];
}

/**
 * Pull the summary text out of a completion response. Returns null when the
 * model produced nothing usable, so the caller can refuse to compact rather
 * than replace a real conversation with an empty summary.
 */
export function extractSummary(response: {
	choices: { message: Message }[];
	error?: { message: string };
}): string | null {
	if (response.error) return null;
	const content = response.choices?.[0]?.message?.content;
	if (!content) return null;
	const trimmed = content.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Drop leading tool results from a tail. The API rejects a tool message that
 * does not answer a preceding assistant tool call, so a cut that lands on one
 * has to move forward until the tail starts on something the model said.
 */
export function trimTail(tail: Message[]): Message[] {
	let out = tail;
	while (out.length > 0 && out[0].role === "tool") out = out.slice(1);
	return out;
}

export interface CompactionPlan {
	/** System messages, which are always preserved verbatim. */
	system: Message[];
	/** The messages that will be summarised away. */
	toSummarise: Message[];
	/** The recent messages kept verbatim. */
	tail: Message[];
}

/**
 * Split a history into "preserved", "summarise" and "keep". Pure, so the
 * cut can be inspected before any tokens are spent on it.
 */
export function planCompaction(history: Message[], keepTail = DEFAULT_KEEP_TAIL): CompactionPlan {
	const system = history.filter((m) => m.role === "system");
	const rest = history.filter((m) => m.role !== "system");

	if (rest.length <= keepTail) return { system, toSummarise: [], tail: rest };

	const tail = trimTail(rest.slice(rest.length - keepTail));
	return { system, toSummarise: rest.slice(0, rest.length - tail.length), tail };
}

/**
 * Build the summary message that replaces the old turns. It is a user message,
 * not a system one: the running agent already has a system prompt, and some
 * providers accept only a single leading system message. The label makes it
 * unmistakable as machine-written context rather than something the human said.
 */
export function summaryMessage(summary: string, droppedCount: number): Message {
	return {
		role: "user",
		content: `[Session summary — replaces ${droppedCount} earlier message(s); written by the agent, not the user]\n\n${summary}`,
	};
}

/** Splice the summary into place. Pure. */
export function applyCompaction(
	history: Message[],
	summary: string,
	keepTail = DEFAULT_KEEP_TAIL,
): Message[] {
	const plan = planCompaction(history, keepTail);
	if (plan.toSummarise.length === 0) return history;
	return [...plan.system, summaryMessage(summary, plan.toSummarise.length), ...plan.tail];
}

export interface CompactionOutcome {
	/** The new history, or null when nothing was compacted. */
	history: Message[] | null;
	/** Why nothing happened, for a user-facing message. */
	reason?: string;
	/** How many messages were replaced by the summary. */
	dropped: number;
	/** How many recent messages were kept verbatim. */
	kept: number;
	/** The summary itself, so the caller can show or log it. */
	summary?: string;
	/** Tokens spent on the summariser call. */
	usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Summarise the old turns and splice the summary in.
 *
 * Returns `history: null` with a reason instead of throwing: compaction is a
 * maintenance action, and a failed summariser must leave the conversation
 * exactly as it was rather than destroy it.
 */
export async function compactHistory(
	history: Message[],
	caller: ApiCaller,
	options: { keepTail?: number } = {},
): Promise<CompactionOutcome> {
	const keepTail = options.keepTail ?? DEFAULT_KEEP_TAIL;
	const empty = { prompt_tokens: 0, completion_tokens: 0 };
	const plan = planCompaction(history, keepTail);

	if (plan.toSummarise.length === 0) {
		return {
			history: null,
			reason: `Nothing to compact: ${history.filter((m) => m.role !== "system").length} message(s) is within the ${keepTail}-message tail.`,
			dropped: 0,
			kept: 0,
			usage: empty,
		};
	}

	let response: Awaited<ReturnType<ApiCaller>>;
	try {
		response = await caller(buildSummaryRequest(history), []);
	} catch (e: unknown) {
		return {
			history: null,
			reason: `Compaction failed, conversation left unchanged: ${(e as Error).message}`,
			dropped: 0,
			kept: 0,
			usage: empty,
		};
	}

	const usage = {
		prompt_tokens: response.usage?.prompt_tokens ?? 0,
		completion_tokens: response.usage?.completion_tokens ?? 0,
	};

	if (response.error) {
		return {
			history: null,
			reason: `Compaction failed, conversation left unchanged: ${response.error.message}`,
			dropped: 0,
			kept: 0,
			usage,
		};
	}

	const summary = extractSummary(response);
	if (!summary) {
		return {
			history: null,
			reason: "Compaction failed: the model returned no summary. Conversation left unchanged.",
			dropped: 0,
			kept: 0,
			usage,
		};
	}

	const next = applyCompaction(history, summary, keepTail);
	// A summary that is not smaller is not a compaction: refuse rather than
	// trade a real conversation for a longer fake one.
	if (estimateConversationTokens(next) >= estimateConversationTokens(history)) {
		return {
			history: null,
			reason: "Compaction skipped: the summary would not have saved any tokens.",
			dropped: 0,
			kept: 0,
			summary,
			usage,
		};
	}

	return {
		history: next,
		dropped: plan.toSummarise.length,
		kept: plan.tail.length,
		summary,
		usage,
	};
}
