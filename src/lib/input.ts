// REPL input. `for await (const line of console)` cannot edit a line, recall
// history, or handle a pasted multi-line block: it just splits stdin on newlines.
// readline gives arrow-key history, home/end and paste handling for free, and it
// still reads piped input, so scripted runs keep working.
import { createInterface, type Interface } from "node:readline";
import type { AskUser } from "./types";

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

let shared: Interface | null = null;

/** Remember the process-wide interface so subagents can ask questions on it. */
export function setSharedInput(rl: Interface | null): void {
	shared = rl;
}

/** The process-wide interface, or null before the REPL has created one. */
export function getSharedInput(): Interface | null {
	return shared;
}

/**
 * Build an `ask_user` implementation on an existing interface. readline routes
 * a line to a pending question instead of emitting it, so asking mid-turn does
 * not also feed the answer to the REPL loop as a new user message.
 */
export function createAskUser(
	rl: Interface,
	output: NodeJS.WritableStream = process.stdout,
): AskUser {
	return (question: string) =>
		new Promise<string>((resolve) => {
			output.write(`\n[question] ${question}\n> `);
			rl.question("", (answer) => resolve(answer.trim()));
		});
}

/** True when a line means "stop": the bare word exit, or an EOF (null). */
export function isExitLine(line: string | null): boolean {
	if (line === null) return true;
	const trimmed = line.trim();
	return trimmed === "exit" || trimmed === "quit";
}
