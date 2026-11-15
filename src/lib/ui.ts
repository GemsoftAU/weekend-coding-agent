// Terminal presentation helpers. Everything here is a pure string builder so the
// REPL's look can be tested without a TTY, a network call, or a running agent.
import type { ModelStats } from "./api";
import type { RecentSession } from "./logger";
import type { SessionState } from "./session";

/** Long tool output is collapsed in the terminal; the full text stays in the log. */
export const TOOL_RESULT_MAX_LINES = 12;
export const TOOL_RESULT_MAX_CHARS = 1_000;
/** Tool arguments are shown on one line, capped so a large write does not flood the REPL. */
export const TOOL_ARGS_MAX_CHARS = 100;

export interface SplashInput {
	/** Configured model id (AGENT_MODEL), shown even when stats are unavailable. */
	model: string;
	stats: ModelStats | null;
	promptName: string;
	promptDescription: string;
	tools: string[];
	/** Subagents this prompt may delegate to, by name. */
	subagents?: string[];
	/** Skills discovered on disk, by name. */
	skills?: string[];
	/** Names of the API keys that are configured. Names only, never values. */
	apiKeys?: string[];
	logFile?: string | null;
	/** Most recent saved sessions, newest first. */
	recent?: RecentSession[];
	/** Current session id, marked with `*` in the recent list. */
	sessionId?: string | null;
}

export interface TurnStatusInput {
	agentName: string;
	model: string;
	stats: ModelStats | null;
	/** Usage for this turn only. */
	usage: { prompt_tokens: number; completion_tokens: number };
	session: SessionState;
	/** Number of non-system messages in the conversation. */
	messages: number;
}

function pricingLine(stats: ModelStats | null): string {
	if (!stats) return "Pricing: unknown (no model stats)";
	return (
		`Pricing: $${(stats.cost.prompt * 1_000_000).toFixed(3)} per 1M input tokens, ` +
		`$${(stats.cost.completion * 1_000_000).toFixed(3)} per 1M output tokens`
	);
}

function contextLine(stats: ModelStats | null): string {
	if (!stats || stats.contextLength <= 0) return "Context window: unknown";
	return `Context window: ${(stats.contextLength / 1_000).toFixed(0)}K tokens`;
}

function recentLines(recent: RecentSession[], currentId?: string | null): string[] {
	if (recent.length === 0) return ["Recent sessions: none"];
	const lines = recent.map((s) => {
		const mark = s.sessionId === currentId ? "*" : " ";
		const preview = s.preview ? ` ${s.preview}` : "";
		return `  ${mark} ${s.sessionId.slice(0, 8)} [${s.agentName}] ${s.messages} msg(s)${preview}`;
	});
	return ["Recent sessions (* = current):", ...lines];
}

/**
 * Startup banner: what model is running, what it costs, which prompt and tools
 * are loaded, where the log goes, and what sessions exist to restore.
 */
export function formatSplash(input: SplashInput): string {
	const model = input.stats
		? `${input.stats.name} (${input.model})`
		: `${input.model} (stats not found)`;
	const lines = [
		"AI Coding Assistant",
		`Model: ${model}`,
		contextLine(input.stats),
		pricingLine(input.stats),
		`Prompt: ${input.promptName} - ${input.promptDescription}`,
		`Tools: ${input.tools.length > 0 ? input.tools.join(", ") : "none"}`,
		`Subagents: ${input.subagents && input.subagents.length > 0 ? input.subagents.join(", ") : "none"}`,
		`Skills: ${input.skills && input.skills.length > 0 ? input.skills.join(", ") : "none"}`,
		`API keys: ${input.apiKeys && input.apiKeys.length > 0 ? input.apiKeys.join(", ") : "none configured"}`,
		`Logging to: ${input.logFile ?? "(logging disabled)"}`,
		...recentLines(input.recent ?? [], input.sessionId),
		"Type 'exit' to quit, /help for commands.",
	];
	return lines.join("\n");
}

/** Bash gets a shell-looking line; every other tool gets a labelled JSON line. */
export function formatToolCall(name: string, rawArguments: string): string {
	let args: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(rawArguments || "{}");
		if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
	} catch {
		// Malformed JSON is still worth showing: the model needs to see its own mistake.
		return `[Tool: ${name}] ${clip(rawArguments, TOOL_ARGS_MAX_CHARS)}`;
	}

	if (name === "bash" && typeof args.command === "string") {
		return `$ ${clip(args.command, TOOL_ARGS_MAX_CHARS)}`;
	}

	const json = JSON.stringify(args);
	return `[Tool: ${name}] ${clip(json, TOOL_ARGS_MAX_CHARS)}`;
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Collapse a long tool result to a readable block. Short results are returned
 * verbatim; long ones keep the head and name how much was hidden.
 */
export function formatToolResult(
	content: string,
	maxLines = TOOL_RESULT_MAX_LINES,
	maxChars = TOOL_RESULT_MAX_CHARS,
): string {
	const lines = content.split("\n");
	if (content.length <= maxChars && lines.length <= maxLines) return content;

	const kept: string[] = [];
	let chars = 0;
	for (const line of lines.slice(0, maxLines)) {
		if (chars + line.length + 1 > maxChars) break;
		kept.push(line);
		chars += line.length + 1;
	}
	const hiddenLines = lines.length - kept.length;
	const hiddenChars = content.length - kept.join("\n").length;
	return [
		...kept,
		`... [collapsed ${hiddenLines} line(s), ${hiddenChars} char(s); full output is in the session log]`,
	].join("\n");
}

/**
 * Pull reasoning text out of the shapes OpenRouter providers use: a string, a
 * single object, or a list of `{ text }` blocks. Returns null when there is
 * nothing to show, so callers never print an empty label.
 */
export function formatReasoning(details: unknown): string | null {
	if (!details) return null;

	const texts: string[] = [];
	const collect = (value: unknown) => {
		if (typeof value === "string") {
			if (value.trim()) texts.push(value.trim());
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) collect(item);
			return;
		}
		if (value && typeof value === "object") {
			const text = (value as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) texts.push(text.trim());
		}
	};

	collect(details);
	if (texts.length === 0) return null;
	return `[Reasoning]: ${texts.join("\n")}`;
}

/** Input label naming the agent that will answer, e.g. `[default]> `. */
export function formatAgentPrompt(agentName: string): string {
	return `[${agentName}]> `;
}

/**
 * Subagent boundaries are printed so a nested run is legible in the terminal:
 * without them the subagent's tool calls look like the parent's.
 */
export function formatSubagentStart(agentName: string, task: string): string {
	return `--- [Subagent Start] ${agentName} ---\nTask: ${task}`;
}

export function formatSubagentEnd(agentName: string): string {
	return `--- [Subagent End] ${agentName} ---`;
}

/**
 * Status bar printed after a turn: who answered, which model, how many messages
 * are in play, and what this turn cost in tokens alongside the session totals.
 * The context gauge and money total stay in `sessionStatusLine`.
 */
export function formatTurnStatus(input: TurnStatusInput): string {
	const model = input.stats?.name ?? input.model;
	const tokens =
		`tokens ${input.usage.prompt_tokens}/${input.usage.completion_tokens} ` +
		`(session ${input.session.promptTokens}/${input.session.completionTokens})`;
	return `[${input.agentName}] ${model} | msgs: ${input.messages} | ${tokens}`;
}
