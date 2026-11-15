// Session logging: every message that enters or leaves the agent is appended to
// a dated JSONL file. JSONL is append-only, streamable, crash-safe and grep-able,
// which is exactly what makes a log useful for debugging, analysis, and (later)
// compaction and resumption.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Message } from "./types";

/** One line of a session log file. */
export interface LogEntry {
	timestamp: string;
	sessionId: string;
	parentId: string | null;
	agentName: string;
	message: Message;
}

/**
 * A sink for conversation messages that can mint a child sink for a subagent.
 * Deliberately NOT called `Logger`: types.ts already exports a `Logger`, which is
 * the human-facing console sink (info/error text). Two different jobs, two names.
 */
export interface SessionLog {
	readonly logFile: string;
	readonly sessionId: string;
	readonly parentId: string | null;
	readonly agentName: string;
	log(message: Message): void;
	/**
	 * A new session id writing to the same file. `parentId` defaults to this
	 * session, which is right for a subagent; a fork passes the session it
	 * branched from instead.
	 */
	child(agentName: string, parentId?: string): SessionLog;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Log file name for a moment in time, in local time: YYYY-MM-DD-HH-MM.jsonl.
 * Minute resolution means one file per agent run in practice.
 */
export function sessionLogFileName(date: Date = new Date()): string {
	const ymd = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
	return `${ymd}-${pad2(date.getHours())}-${pad2(date.getMinutes())}.jsonl`;
}

/**
 * Append-only JSONL writer. One instance per session; `child()` starts a new
 * session id that points back at its parent so subagent runs form a tree.
 */
export class SessionLogger implements SessionLog {
	readonly logFile: string;
	readonly sessionId: string;
	readonly parentId: string | null;
	readonly agentName: string;

	constructor(
		logFile: string,
		sessionId: string = randomUUID(),
		parentId: string | null = null,
		agentName = "main",
	) {
		this.logFile = logFile;
		this.sessionId = sessionId;
		this.parentId = parentId;
		this.agentName = agentName;
		mkdirSync(dirname(logFile), { recursive: true });
	}

	log(message: Message): void {
		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			sessionId: this.sessionId,
			parentId: this.parentId,
			agentName: this.agentName,
			message,
		};
		appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
	}

	/** New session id, same file, `parentId` naming the session it came from. */
	child(agentName: string, parentId: string = this.sessionId): SessionLogger {
		return new SessionLogger(this.logFile, randomUUID(), parentId, agentName);
	}
}

/** Open the log file for "now" inside `logDir`, creating the directory if needed. */
export function createSessionLogger(
	logDir: string,
	date: Date = new Date(),
	agentName = "main",
): SessionLogger {
	return new SessionLogger(join(logDir, sessionLogFileName(date)), randomUUID(), null, agentName);
}

/**
 * Parse a JSONL log file. Missing files and corrupt lines are skipped rather
 * than thrown: a half-written last line is exactly what a crash leaves behind,
 * and it must not make the rest of the log unreadable.
 */
export function readLogEntries(file: string): LogEntry[] {
	if (!existsSync(file)) return [];
	const entries: LogEntry[] = [];
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as LogEntry;
			if (parsed?.message && typeof parsed.message.role === "string") {
				entries.push(parsed);
			}
		} catch {
			// Corrupt or partial line: keep reading.
		}
	}
	return entries;
}

/** Every `.jsonl` file in the log directory, oldest first. */
export function listLogFiles(logDir: string): string[] {
	if (!existsSync(logDir)) return [];
	return readdirSync(logDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(logDir, name));
}

/** The log file that contains `sessionId`, or null when no file does. */
export function findSessionFile(logDir: string, sessionId: string): string | null {
	for (const file of listLogFiles(logDir)) {
		if (readLogEntries(file).some((entry) => entry.sessionId === sessionId)) return file;
	}
	return null;
}

/** Rebuild the message history of one session from the log files. */
export function loadSessionHistory(logDir: string, sessionId: string): Message[] {
	const file = findSessionFile(logDir, sessionId);
	if (!file) return [];
	return readLogEntries(file)
		.filter((entry) => entry.sessionId === sessionId)
		.map((entry) => entry.message);
}

/** One saved session, summarised for the startup screen and /list. */
export interface RecentSession {
	sessionId: string;
	agentName: string;
	/** Number of logged messages in the session. */
	messages: number;
	/** Timestamp of the newest entry, ISO 8601. */
	lastActivity: string;
	/** First user message, flattened and shortened, for recognising the session. */
	preview: string;
}

function previewText(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Summarise every session in the log directory, newest activity first. Sessions
 * are grouped by id because one file can hold several (subagents, forks); the
 * entry count is the number of logged messages, not files.
 */
export function recentSessions(logDir: string, limit = 5): RecentSession[] {
	const byId = new Map<string, RecentSession>();
	for (const file of listLogFiles(logDir)) {
		for (const entry of readLogEntries(file)) {
			const existing = byId.get(entry.sessionId);
			const isUserText =
				entry.message.role === "user" && (entry.message.content ?? "").trim() !== "";
			if (!existing) {
				byId.set(entry.sessionId, {
					sessionId: entry.sessionId,
					agentName: entry.agentName,
					messages: 1,
					lastActivity: entry.timestamp,
					preview: isUserText ? previewText(entry.message.content ?? "") : "",
				});
				continue;
			}
			existing.messages++;
			if (entry.timestamp > existing.lastActivity) existing.lastActivity = entry.timestamp;
			// Keep the first user message: it is what the session was about.
			if (existing.preview === "" && isUserText) {
				existing.preview = previewText(entry.message.content ?? "");
			}
		}
	}

	return [...byId.values()]
		.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
		.slice(0, limit);
}
