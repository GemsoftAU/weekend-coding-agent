import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createInput, isExitLine } from "../src/lib/input";

/** Collect the lines readline emits for the given stdin text. */
async function readAll(text: string, terminal = false): Promise<string[]> {
	const input = new PassThrough();
	const output = new PassThrough();
	const rl = createInput({ input, output, terminal, historySize: 5 });
	const lines: string[] = [];
	const done = (async () => {
		for await (const line of rl) lines.push(line as string);
	})();

	input.end(text);
	await done;
	return lines;
}

describe("createInput", () => {
	test("reads piped lines, so scripted runs still work", async () => {
		expect(await readAll("hello\nworld\n")).toEqual(["hello", "world"]);
	});

	test("keeps a pasted multi-line block as separate lines", async () => {
		expect(await readAll("first\nsecond\nthird\n")).toEqual(["first", "second", "third"]);
	});

	test("blank lines come through as empty strings for the REPL to skip", async () => {
		expect(await readAll("a\n\nb\n")).toEqual(["a", "", "b"]);
	});

	test("terminal mode is off for a pipe and on when asked", () => {
		const pipe = new PassThrough();
		const output = new PassThrough();
		// Non-TTY streams must not be treated as terminal, or readline emits
		// escape sequences into a file.
		const piped = createInput({ input: pipe, output });
		expect(piped.terminal).toBe(false);
		piped.close();

		const tty = new PassThrough() as PassThrough & { isTTY?: boolean };
		tty.isTTY = true;
		const interactive = createInput({ input: tty, output, terminal: true });
		expect(interactive.terminal).toBe(true);
		interactive.close();
	});
});

describe("isExitLine", () => {
	test("the bare word exit or quit ends the session", () => {
		expect(isExitLine("exit")).toBe(true);
		expect(isExitLine("quit")).toBe(true);
		expect(isExitLine("  exit  ")).toBe(true);
	});

	test("EOF (null) ends the session instead of looping forever", () => {
		expect(isExitLine(null)).toBe(true);
	});

	test("ordinary input does not", () => {
		expect(isExitLine("exit now")).toBe(false);
		expect(isExitLine("/exit")).toBe(false);
		expect(isExitLine("")).toBe(false);
	});
});
