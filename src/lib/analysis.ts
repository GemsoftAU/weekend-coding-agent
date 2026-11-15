// Session introspection: read the JSONL logs back and say what actually
// happened. Tool usage, failure rates and cost are counted from the record
// rather than guessed, so the recommendations are evidence rather than advice.
//
// The analysis is pure: it takes parsed entries and returns numbers. That keeps
// the interesting part testable without log files, and means the same analysis
// can run over one session, one file, or the whole log directory.
import type { LogEntry } from "./logger";

/** One tool's usage across the analysed entries. */
export interface ToolStat {
	name: string;
	/** How many times the model asked for it. */
	calls: number;
	/** How many of the results came back as an error. */
	errors: number;
	/** Total characters returned by this tool, a proxy for context cost. */
	resultChars: number;
}

export interface Analysis {
	/** Sessions seen in the analysed entries. */
	sessions: number;
	/** Messages total, by role. */
	roles: Record<string, number>;
	/** Per-tool counts, sorted by calls descending. */
	tools: ToolStat[];
	/** Messages the assistant sent. */
	assistantMessages: number;
	/** Messages that carried at least one tool call. */
	toolCallMessages: number;
	/** Total characters every tool returned: the context this log actually cost. */
	resultChars: number;
	/** Subagent sessions, by agent name. */
	subagents: Record<string, number>;
	/** Findings, each with the evidence that produced it. */
	recommendations: string[];
}

/** A tool result that reported a failure in the shape the tools actually use. */
export function isErrorResult(content: string | undefined): boolean {
	if (!content) return false;
	const head = content.trimStart();
	return (
		head.startsWith("Tool error:") ||
		head.startsWith("Error:") ||
		head.startsWith("Security Policy Violation:")
	);
}

export interface AnalyzeOptions {
	/** How many findings to return at most. */
	maxRecommendations?: number;
}

/**
 * Analyse log entries. Tool calls are attributed to the tool by matching each
 * `tool` message to the assistant message that requested it through
 * `tool_call_id`, because a result alone does not name its tool.
 */
export function analyzeEntries(entries: LogEntry[], options: AnalyzeOptions = {}): Analysis {
	const tools = new Map<string, ToolStat>();
	const roles: Record<string, number> = {};
	const subagents: Record<string, number> = {};
	const sessions = new Set<string>();
	const callIdToTool = new Map<string, string>();

	let assistantMessages = 0;
	let toolCallMessages = 0;

	for (const entry of entries) {
		const message = entry.message;
		sessions.add(entry.sessionId);
		roles[message.role] = (roles[message.role] ?? 0) + 1;

		if (entry.parentId !== null && entry.agentName) {
			subagents[entry.agentName] = (subagents[entry.agentName] ?? 0) + 1;
		}

		if (message.role === "assistant") {
			assistantMessages++;
			if (message.tool_calls?.length) {
				toolCallMessages++;
				for (const call of message.tool_calls) {
					callIdToTool.set(call.id, call.function.name);
					const stat = tools.get(call.function.name) ?? {
						name: call.function.name,
						calls: 0,
						errors: 0,
						resultChars: 0,
					};
					stat.calls++;
					tools.set(call.function.name, stat);
				}
			}
		}

		if (message.role === "tool") {
			const name = message.tool_call_id ? callIdToTool.get(message.tool_call_id) : undefined;
			if (name) {
				const stat = tools.get(name);
				if (stat) {
					if (isErrorResult(message.content)) stat.errors++;
					stat.resultChars += message.content?.length ?? 0;
				}
			}
		}
	}

	const toolStats = [...tools.values()].sort(
		(a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
	);

	// The JSONL log records messages, not API usage: there is no token count to
	// read back. Rather than invent a cost figure, the analysis reports context
	// size in characters and leaves money to /session, which does have real
	// usage numbers from the API responses.
	const analysis: Analysis = {
		sessions: sessions.size,
		roles,
		tools: toolStats,
		assistantMessages,
		toolCallMessages,
		resultChars: toolStats.reduce((sum, t) => sum + t.resultChars, 0),
		subagents,
		recommendations: [],
	};

	analysis.recommendations = recommend(analysis, options.maxRecommendations ?? 6);
	return analysis;
}

/**
 * Turn the counts into findings. Every sentence here is derived from the counts
 * above, which is the point: an introspection report that cannot be traced back
 * to the log is just an opinion. Thresholds are deliberately conservative so a
 * short session does not produce noise.
 */
export function recommend(analysis: Analysis, max = 6): string[] {
	const out: string[] = [];
	const total = analysis.tools.reduce((sum, t) => sum + t.calls, 0);

	if (total === 0) {
		out.push("No tool calls recorded yet: run the agent for a while before analysing.");
		return out.slice(0, max);
	}

	// The search-before-read nudge the course asks for, stated with its numbers.
	const read = analysis.tools.find((t) => t.name === "read_file");
	const search = analysis.tools.find((t) => t.name === "search_files");
	if (read && read.calls >= 5) {
		if (!search || read.calls >= 3 * search.calls) {
			out.push(
				`read_file was called ${read.calls}× vs search_files ${search?.calls ?? 0}×. ` +
					"Search for the symbol first, then read only the file it pointed at.",
			);
		}
	}

	// A tool that fails often is a tool with a bad interface or a bad prompt.
	for (const stat of analysis.tools) {
		if (stat.calls >= 3 && stat.errors / stat.calls >= 0.3) {
			out.push(
				`${stat.name} failed ${stat.errors}/${stat.calls} calls (${Math.round(
					(stat.errors / stat.calls) * 100,
				)}%). Check the error text: it usually means a malformed argument, not a bad model.`,
			);
		}
	}

	// Context cost is dominated by whichever tool returns the most text.
	const byChars = [...analysis.tools].sort((a, b) => b.resultChars - a.resultChars);
	const noisiest = byChars[0];
	if (noisiest && noisiest.resultChars > 100_000) {
		out.push(
			`${noisiest.name} returned ~${Math.round(noisiest.resultChars / 1000)}K characters, ` +
				"the largest share of context. Narrow its arguments (paths, patterns, limits).",
		);
	}

	// Long assistant messages with no tool call are usually narration, which is
	// pure context cost with no effect on the work.
	if (analysis.toolCallMessages > 0 && analysis.assistantMessages > 20) {
		const ratio = analysis.toolCallMessages / analysis.assistantMessages;
		if (ratio > 0.6) {
			out.push(
				`${Math.round(ratio * 100)}% of assistant messages carried tool calls. ` +
					"Good: the agent is acting rather than narrating.",
			);
		}
	}

	const subagentRuns = Object.values(analysis.subagents).reduce((a, b) => a + b, 0);
	if (subagentRuns > 0) {
		const names = Object.entries(analysis.subagents)
			.sort((a, b) => b[1] - a[1])
			.map(([name, count]) => `${name} (${count})`)
			.join(", ");
		out.push(`Subagent messages by agent: ${names}.`);
	}

	if (out.length === 0) {
		out.push("No problems found in the analysed sessions: tool use looks healthy.");
	}

	return out.slice(0, max);
}

/**
 * Analyse already-parsed log entries. The name the command layer calls: it
 * reads entries, not files, so the caller decides which logs are in scope.
 */
export function analyzeLogs(entries: LogEntry[], options: AnalyzeOptions = {}): Analysis {
	return analyzeEntries(entries, options);
}

/**
 * Render an analysis as the report the user reads. Kept separate from the
 * counting so the format can change without touching the maths.
 */
export function formatAnalysis(analysis: Analysis, scope = "all sessions"): string {
	const lines = ["Session analysis", `Scope: ${scope}`, `Sessions: ${analysis.sessions}`];

	const roles = Object.entries(analysis.roles)
		.map(([role, count]) => `${role} ${count}`)
		.join(", ");
	if (roles) lines.push(`Messages: ${roles}`);

	if (analysis.tools.length === 0) {
		lines.push("Tools: none recorded.");
	} else {
		lines.push("", "Tool usage (calls / errors / chars returned):");
		for (const stat of analysis.tools) {
			lines.push(`  ${stat.name}: ${stat.calls} / ${stat.errors} / ${stat.resultChars}`);
		}
	}

	lines.push("", "Findings:");
	for (const finding of analysis.recommendations) lines.push(`  - ${finding}`);

	return lines.join("\n");
}
