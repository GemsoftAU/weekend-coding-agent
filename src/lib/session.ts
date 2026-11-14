// Session state: how big the conversation is, how full the context window is,
// and what the session has cost so far. Costs come from real API usage; the
// context size is an estimate (chars/4) because the API does not report it.
import type { ModelStats } from "./api";
import type { Message } from "./types";

export interface SessionState {
	stats: ModelStats | null;
	totalCost: number;
	promptTokens: number;
	completionTokens: number;
}

export function createSession(stats: ModelStats | null): SessionState {
	return { stats, totalCost: 0, promptTokens: 0, completionTokens: 0 };
}

/**
 * Rough token estimate for one message: characters / 4 plus a fixed per-message
 * overhead. Approximate on purpose - good enough for a context gauge, never
 * used for billing.
 */
export function estimateTokens(message: Message): number {
	let chars = message.content?.length ?? 0;
	for (const tc of message.tool_calls ?? []) {
		chars += tc.function.arguments.length;
	}
	return Math.ceil(chars / 4) + 16;
}

/** Estimated size of the whole conversation the next API call will send. */
export function estimateConversationTokens(messages: Message[]): number {
	return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/** Fold one API response's usage into the running session totals. */
export function recordUsage(
	session: SessionState,
	usage?: { prompt_tokens?: number; completion_tokens?: number },
): void {
	const inTok = usage?.prompt_tokens ?? 0;
	const outTok = usage?.completion_tokens ?? 0;
	session.promptTokens += inTok;
	session.completionTokens += outTok;
	if (session.stats) {
		session.totalCost += inTok * session.stats.cost.prompt + outTok * session.stats.cost.completion;
	}
}

/** One status line: context gauge plus session cost, printed after each turn. */
export function sessionStatusLine(session: SessionState, estimatedTokens: number): string {
	const ctx = session.stats?.contextLength ?? 0;
	const ctxPart =
		ctx > 0
			? `Context: ~${estimatedTokens} / ${ctx} tokens (${((estimatedTokens / ctx) * 100).toFixed(1)}%)`
			: `Context: ~${estimatedTokens} tokens`;
	// No pricing, no cost figure: a $0.00 display would claim a free session.
	const costPart = session.stats ? ` | Cost: $${session.totalCost.toFixed(6)}` : "";
	return `[Session] ${ctxPart}${costPart}`;
}
