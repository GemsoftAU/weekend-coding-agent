// REPL input. `for await (const line of console)` cannot edit a line, recall
// history, or handle a pasted multi-line block: it just splits stdin on newlines.
// readline gives arrow-key history, home/end and paste handling for free, and it
// still reads piped input, so scripted runs keep working.
import { createInterface, type Interface } from "node:readline";

export interface InputOptions {
	/** Defaults to process.stdin. */
	input?: NodeJS.ReadableStream;
	/** Defaults to process.stdout. */
	output?: NodeJS.WritableStream;
	/** Line editing and history. Defaults to whether stdin is a TTY. */
	terminal?: boolean;
	/** Number of recalled lines kept. */
	historySize?: number;
}

/**
 * One readline interface for the whole process. A second instance would fight
 * this one for stdin, which is exactly the bug that kills a REPL when a
 * subagent opens its own prompt.
 */
export function createInput(options: InputOptions = {}): Interface {
	const input = options.input ?? process.stdin;
	return createInterface({
		input,
		output: options.output ?? process.stdout,
		terminal: options.terminal ?? Boolean((input as { isTTY?: boolean }).isTTY),
		historySize: options.historySize ?? 100,
	});
}

/** True when a line means "stop": the bare word exit, or an EOF (null). */
export function isExitLine(line: string | null): boolean {
	if (line === null) return true;
	const trimmed = line.trim();
	return trimmed === "exit" || trimmed === "quit";
}
