import type { ToolSchema } from "../lib/types";
import { runGuardedBash } from "./system";

export const TOOLS: ToolSchema[] = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run a bash command on the local machine.",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_check",
			description: "Run the project check task: linter plus test suite.",
			parameters: { type: "object", properties: {} },
		},
	},
];

/** Raised for malformed tool arguments so the loop can report it back to the model. */
export class ToolArgsError extends Error {}

function readCommand(args: Record<string, unknown>): string {
	const command = args.command;
	if (typeof command !== "string" || command.trim() === "") {
		throw new ToolArgsError("Missing required string argument: command");
	}
	return command;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
	switch (name) {
		case "bash": {
			// Argument problems are reported back to the model, never thrown at the loop.
			try {
				return await runGuardedBash(readCommand(args));
			} catch (e: unknown) {
				if (e instanceof ToolArgsError) return `Tool error: ${e.message}`;
				throw e;
			}
		}
		case "run_check":
			return runGuardedBash("mise run check");
		default:
			return `Unknown tool: ${name}`;
	}
}
