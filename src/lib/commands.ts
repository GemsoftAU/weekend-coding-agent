// Slash commands for the REPL. Parsing is separated from execution so the
// dispatcher stays testable without touching the terminal, the network, or disk.
import type { ModelStats } from "./api";
import { type LogEntry, listLogFiles, loadSessionHistory, readLogEntries } from "./logger";
import type { SessionState } from "./session";
import type { Message } from "./types";

export interface CommandContext {
	/** Session state (cost + context) shown by /session. */
	session: SessionState;
	/** Live conversation history, for /compact and /session counts. */
	history: Message[];
	/** Directory holding the JSONL logs, for /search, /restore, /fork, /list. */
	logDir: string;
	/** Current log file, shown by /session. Null when logging is off. */
	logFile?: string | null;
	/** Current session id, shown by /session and /list. */
	sessionId?: string | null;
	/** Current session's agent name, shown by /help. */
	agentName?: string;
	/** Model stats; used by /models. Null when the stats fetch failed. */
	stats?: ModelStats | null;
	/** Names of the tools the agent can call, shown by /help. */
	tools?: string[];
}

export interface CommandResult {
	/** Text to print. */
	output: string;
	/** Set when the command replaces the conversation history. */
	history?: Message[];
	/** Set when the command should continue under a brand new session id. */
	newSession?: boolean;
	/** For /fork: the session the new branch came from, recorded as its parentId. */
	forkedFrom?: string;
	/** Set when the command ends the session. */
	exit?: boolean;
}

export interface ParsedCommand {
	name: string;
	args: string[];
}

/** Split a `/command args` line. Returns null when the line is not a command. */
export function parseCommand(line: string): ParsedCommand | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) return null;
	const [name, ...args] = trimmed.slice(1).split(/\s+/).filter(Boolean);
	if (!name) return null;
	return { name: name.toLowerCase(), args };
}

export const COMMAND_NAMES = [
	"help",
	"models",
	"session",
	"search",
	"list",
	"restore",
	"fork",
	"compact",
	"exit",
] as const;

const HELP = [
	"Commands:",
	"  /help            Show this help",
	"  /models          Show model, context window and pricing",
	"  /session         Show current session id, log file, messages and cost",
	"  /search <text>   Search the session logs for a pattern",
	"  /list            List recent sessions",
	"  /restore <id>    Load a saved session's history (id prefix is enough)",
	"  /fork <id>       Start a new session branched from a saved one",
	"  /compact         Summarise the conversation so far (keeps the last turns)",
	"  /exit            Quit",
].join("\n");

/** Shortest id prefix that is enough to name a session on the command line. */
function matchesId(sessionId: string, prefix: string): boolean {
	return sessionId.startsWith(prefix);
}

/** Collapse whitespace and cap each logged message so compact output stays scannable. */
function preview(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function summariseEntry(entry: LogEntry): string {
	const msg = entry.message;
	const who = `${entry.sessionId.slice(0, 8)} [${entry.agentName}]`;
	if (msg.tool_calls?.length) {
		const names = msg.tool_calls.map((tc) => tc.function.name).join(", ");
		return `${who} assistant -> ${names}`;
	}
	return `${who} ${msg.role}: ${preview(msg.content ?? "")}`;
}

function uniqueSessionIds(logDir: string): string[] {
	const ids: string[] = [];
	for (const file of listLogFiles(logDir)) {
		for (const entry of readLogEntries(file)) {
			if (!ids.includes(entry.sessionId)) ids.push(entry.sessionId);
		}
	}
	return ids;
}

function formatCost(session: SessionState): string {
	return session.stats ? `$${session.totalCost.toFixed(6)}` : "unknown (no pricing)";
}

function helpCommand(ctx: CommandContext): CommandResult {
	const lines = [HELP];
	if (ctx.agentName) lines.push("", `Agent: ${ctx.agentName}`);
	if (ctx.tools?.length) lines.push(`Tools: ${ctx.tools.join(", ")}`);
	return { output: lines.join("\n") };
}

function modelsCommand(ctx: CommandContext): CommandResult {
	const stats = ctx.stats;
	if (!stats) {
		return { output: "Model: stats unavailable (offline or unknown model)." };
	}
	const context =
		stats.contextLength > 0
			? `${(stats.contextLength / 1_000).toFixed(0)}K tokens`
			: "unknown context window";
	return {
		output: [
			`Model: ${stats.name}`,
			`Context window: ${context}`,
			`Pricing: $${(stats.cost.prompt * 1_000_000).toFixed(3)} per 1M input tokens, ` +
				`$${(stats.cost.completion * 1_000_000).toFixed(3)} per 1M output tokens`,
		].join("\n"),
	};
}

function sessionCommand(ctx: CommandContext): CommandResult {
	const messages = ctx.history.filter((m) => m.role !== "system").length;
	return {
		output: [
			`Session: ${ctx.sessionId ?? "not logged"}`,
			`Log file: ${ctx.logFile ?? "(logging disabled)"}`,
			`Messages: ${messages} (plus ${ctx.history.length - messages} system)`,
			`Tokens: ${ctx.session.promptTokens} in / ${ctx.session.completionTokens} out`,
			`Cost: ${formatCost(ctx.session)}`,
		].join("\n"),
	};
}

function searchCommand(ctx: CommandContext, args: string[]): CommandResult {
	const needle = args.join(" ").trim();
	if (!needle) return { output: "Usage: /search <text>" };

	// Every log file, not just this session's: a fresh session's log holds only
	// the system prompt, and "search my logs" is about what happened before.
	const matches: string[] = [];
	for (const path of listLogFiles(ctx.logDir)) {
		for (const entry of readLogEntries(path)) {
			if (JSON.stringify(entry).toLowerCase().includes(needle.toLowerCase())) {
				matches.push(`${entry.timestamp} ${summariseEntry(entry)}`);
			}
		}
	}
	if (matches.length === 0) return { output: `No matches for "${needle}".` };
	return { output: [`${matches.length} match(es) for "${needle}":`, ...matches].join("\n") };
}

function listCommand(ctx: CommandContext): CommandResult {
	const ids = uniqueSessionIds(ctx.logDir);
	if (ids.length === 0) return { output: "No saved sessions." };
	const lines = ids.map((id) => `${id === ctx.sessionId ? "*" : " "} ${id}`);
	return { output: ["Sessions (* = current):", ...lines].join("\n") };
}

function resolveId(ctx: CommandContext, prefix: string): string | null {
	if (!prefix) return null;
	const ids = uniqueSessionIds(ctx.logDir);
	if (ids.includes(prefix)) return prefix;
	const matches = ids.filter((id) => matchesId(id, prefix));
	return matches.length === 1 ? matches[0] : null;
}

function restoreCommand(ctx: CommandContext, args: string[]): CommandResult {
	const id = resolveId(ctx, args[0] ?? "");
	if (!id) {
		return {
			output: `Usage: /restore <session-id> (use /list to see ids). Not found: ${args[0] ?? ""}`,
		};
	}
	const history = loadSessionHistory(ctx.logDir, id);
	if (history.length === 0) return { output: `Session ${id} has no messages.` };
	return { output: `Restored ${history.length} messages from ${id}.`, history };
}

function forkCommand(ctx: CommandContext, args: string[]): CommandResult {
	const id = resolveId(ctx, args[0] ?? "");
	if (!id) {
		return {
			output: `Usage: /fork <session-id> (use /list to see ids). Not found: ${args[0] ?? ""}`,
		};
	}
	const history = loadSessionHistory(ctx.logDir, id);
	if (history.length === 0) return { output: `Session ${id} has no messages.` };
	// Forking keeps the history but starts a fresh session id in the log file,
	// so the two branches can be compared afterwards.
	return {
		output: `Forked ${history.length} messages from ${id} into a new session.`,
		history,
		newSession: true,
		// The branch records where it came from, so the log tree shows the split.
		forkedFrom: id,
	};
}

function compactCommand(ctx: CommandContext): CommandResult {
	// Chapter 11 replaces this with an LLM summariser. Until then, compaction
	// drops old turns mechanically and keeps the system prompt + recent tail.
	const system = ctx.history.filter((m) => m.role === "system");
	const rest = ctx.history.filter((m) => m.role !== "system");
	const keep = 6;
	if (rest.length <= keep) {
		return { output: `Nothing to compact: ${rest.length} non-system message(s).` };
	}

	let tail = rest.slice(rest.length - keep);
	// Never keep a tool result without the assistant call it answers: the API
	// rejects orphaned tool messages, so trim from the front until the tail
	// starts on something the model said.
	while (tail.length > 0 && tail[0].role === "tool") tail = tail.slice(1);

	const dropped = rest.length - tail.length;
	if (dropped <= 0) {
		return { output: `Nothing to compact: ${rest.length} non-system message(s).` };
	}
	const note: Message = {
		role: "user",
		content: `[compacted ${dropped} earlier message(s)]`,
	};
	return {
		output: `Compacted ${dropped} message(s); kept the last ${tail.length}.`,
		history: [...system, note, ...tail],
	};
}

/** Run one parsed command. Unknown commands never throw: they report usage. */
export function runCommand(command: ParsedCommand, ctx: CommandContext): CommandResult {
	switch (command.name) {
		case "help":
			return helpCommand(ctx);
		case "models":
			return modelsCommand(ctx);
		case "session":
			return sessionCommand(ctx);
		case "search":
			return searchCommand(ctx, command.args);
		case "list":
			return listCommand(ctx);
		case "restore":
			return restoreCommand(ctx, command.args);
		case "fork":
			return forkCommand(ctx, command.args);
		case "compact":
			return compactCommand(ctx);
		case "exit":
		case "quit":
			return { output: "Bye.", exit: true };
		default:
			return { output: `Unknown command: /${command.name}. Type /help for the list.` };
	}
}
