import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSessionLogger,
	findSessionFile,
	listLogFiles,
	loadSessionHistory,
	readLogEntries,
	SessionLogger,
	sessionLogFileName,
} from "../src/lib/logger";
import type { Message } from "../src/lib/types";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-log-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("sessionLogFileName", () => {
	test("formats a date as YYYY-MM-DD-HH-MM.jsonl", () => {
		const date = new Date(2025, 3, 15, 14, 23, 45);
		expect(sessionLogFileName(date)).toBe("2025-04-15-14-23.jsonl");
	});

	test("pads single-digit months, days, hours and minutes", () => {
		const date = new Date(2026, 0, 2, 3, 4);
		expect(sessionLogFileName(date)).toBe("2026-01-02-03-04.jsonl");
	});

	test("different minutes get different files", () => {
		const a = sessionLogFileName(new Date(2025, 3, 15, 14, 23));
		const b = sessionLogFileName(new Date(2025, 3, 15, 14, 24));
		expect(a).not.toBe(b);
	});
});

describe("SessionLogger", () => {
	test("appends one JSON line per message with session metadata", () => {
		const logger = new SessionLogger(join(dir, "a.jsonl"), "session-1", null, "main");
		logger.log({ role: "user", content: "hello" });

		const lines = readFileSync(logger.logFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);

		const entry = JSON.parse(lines[0]);
		expect(entry.sessionId).toBe("session-1");
		expect(entry.parentId).toBeNull();
		expect(entry.agentName).toBe("main");
		expect(entry.message).toEqual({ role: "user", content: "hello" });
		// ISO 8601, so entries sort chronologically as text.
		expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	test("logging is append-only: earlier lines survive later writes", () => {
		const logger = new SessionLogger(join(dir, "b.jsonl"));
		logger.log({ role: "user", content: "first" });
		logger.log({ role: "assistant", content: "second" });

		expect(readLogEntries(logger.logFile).map((e) => e.message.content)).toEqual([
			"first",
			"second",
		]);
	});

	test("creates missing parent directories instead of throwing", () => {
		const logger = new SessionLogger(join(dir, "nested", "deep", "c.jsonl"));
		logger.log({ role: "user", content: "x" });
		expect(readLogEntries(logger.logFile)).toHaveLength(1);
	});

	test("preserves tool calls and tool results verbatim", () => {
		const logger = new SessionLogger(join(dir, "d.jsonl"));
		const toolCall: Message = {
			role: "assistant",
			content: "",
			tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: '{"path":"a"}' } }],
		};
		logger.log(toolCall);
		logger.log({ role: "tool", tool_call_id: "call_1", content: "file body" });

		const entries = readLogEntries(logger.logFile);
		expect(entries[0].message.tool_calls?.[0].function.name).toBe("read_file");
		expect(entries[1].message.tool_call_id).toBe("call_1");
	});

	test("child() gets a new session id and points at its parent", () => {
		const parent = new SessionLogger(join(dir, "e.jsonl"), "parent-id", null, "main");
		const child = parent.child("code-map");

		expect(child.sessionId).not.toBe("parent-id");
		expect(child.parentId).toBe("parent-id");
		expect(child.agentName).toBe("code-map");
		// Same file: the session tree is one stream you can read in order.
		expect(child.logFile).toBe(parent.logFile);
	});

	test("child() can name a different parent, as a fork does", () => {
		const current = new SessionLogger(join(dir, "e.jsonl"), "current-id", null, "main");
		const branch = current.child("main", "forked-from-id");

		// The fork came from another session, not from the one that ran /fork.
		expect(branch.parentId).toBe("forked-from-id");
	});

	test("a child session is reconstructable from the tree in one file", () => {
		const parent = new SessionLogger(join(dir, "f.jsonl"), "parent-id", null, "main");
		parent.log({ role: "user", content: "spawn a subagent" });
		const child = parent.child("code-map");
		child.log({ role: "assistant", content: "mapping" });

		const ids = readLogEntries(parent.logFile).map((e) => `${e.agentName}:${e.sessionId}`);
		expect(ids).toEqual(["main:parent-id", `code-map:${child.sessionId}`]);
	});
});

describe("createSessionLogger", () => {
	test("writes into the dated file for the supplied moment", () => {
		const logger = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23), "default");
		expect(logger.logFile).toBe(join(dir, "2025-04-15-14-23.jsonl"));
		expect(logger.agentName).toBe("default");
		expect(logger.parentId).toBeNull();
	});
});

describe("readLogEntries", () => {
	test("returns an empty list for a missing file", () => {
		expect(readLogEntries(join(dir, "nope.jsonl"))).toEqual([]);
	});

	test("skips blank lines", () => {
		const file = join(dir, "g.jsonl");
		writeFileSync(file, `${JSON.stringify({ message: { role: "user" } })}\n\n`);
		expect(readLogEntries(file)).toHaveLength(1);
	});

	test("a corrupt trailing line does not lose the valid ones", () => {
		const file = join(dir, "h.jsonl");
		const good = JSON.stringify({ message: { role: "user", content: "ok" } });
		// A crash mid-append leaves a half-written line; the rest must still parse.
		writeFileSync(file, `${good}\n{"message":{"role":"assis`);
		const entries = readLogEntries(file);
		expect(entries).toHaveLength(1);
		expect(entries[0].message.content).toBe("ok");
	});

	test("skips JSON that is not a message entry", () => {
		const file = join(dir, "i.jsonl");
		writeFileSync(file, `{"not":"a message"}\n${JSON.stringify({ message: { role: "tool" } })}\n`);
		expect(readLogEntries(file)).toHaveLength(1);
	});
});

describe("session lookup", () => {
	test("listLogFiles returns only jsonl files, oldest first", () => {
		createSessionLogger(dir, new Date(2025, 3, 15, 14, 23)).log({ role: "user", content: "a" });
		createSessionLogger(dir, new Date(2025, 3, 15, 9, 5)).log({ role: "user", content: "b" });
		writeFileSync(join(dir, "ignored.txt"), "x");

		expect(listLogFiles(dir).map((p) => p.split("/").pop())).toEqual([
			"2025-04-15-09-05.jsonl",
			"2025-04-15-14-23.jsonl",
		]);
	});

	test("listLogFiles on a missing directory is empty, not an error", () => {
		expect(listLogFiles(join(dir, "missing"))).toEqual([]);
	});

	test("findSessionFile locates the file holding a session id", () => {
		const early = createSessionLogger(dir, new Date(2025, 3, 15, 9, 5));
		early.log({ role: "user", content: "old" });
		const late = createSessionLogger(dir, new Date(2025, 3, 15, 14, 23));
		late.log({ role: "user", content: "new" });

		expect(findSessionFile(dir, early.sessionId)).toBe(early.logFile);
		expect(findSessionFile(dir, late.sessionId)).toBe(late.logFile);
		expect(findSessionFile(dir, "no-such-session")).toBeNull();
	});

	test("loadSessionHistory replays only that session's messages, in order", () => {
		const logger = new SessionLogger(join(dir, "j.jsonl"), "mine", null, "main");
		logger.log({ role: "system", content: "you are helpful" });
		logger.log({ role: "user", content: "hi" });
		logger.child("sub").log({ role: "assistant", content: "from the subagent" });

		const history = loadSessionHistory(dir, "mine");
		expect(history.map((m) => m.content)).toEqual(["you are helpful", "hi"]);
	});

	test("loadSessionHistory of an unknown session is empty", () => {
		expect(loadSessionHistory(dir, "ghost")).toEqual([]);
	});
});
