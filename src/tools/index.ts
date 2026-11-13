import type { ToolSchema } from "../lib/types";
import {
	type Edit,
	listFiles,
	readFileContent,
	replaceInFile,
	searchFiles,
	writeFileContent,
} from "./files";
import { gitDiff, runBash } from "./system";

/** Thrown for bad tool arguments so the loop can hand the problem back to the model. */
export class ToolArgsError extends Error {}

function stringArg(args: Record<string, unknown>, name: string, required = true): string {
	const value = args[name];
	if (value === undefined || value === null) {
		if (!required) return "";
		throw new ToolArgsError(`Missing required string argument: ${name}`);
	}
	if (typeof value !== "string") {
		throw new ToolArgsError(`Argument ${name} must be a string, got ${typeof value}`);
	}
	if (required && value.trim() === "") {
		throw new ToolArgsError(`Argument ${name} must not be empty`);
	}
	return value;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		throw new ToolArgsError(`Argument ${name} must be a number`);
	}
	return parsed;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	return value === "true";
}

/** Normalise the single-edit and multi-edit forms into one list. */
function readEdits(args: Record<string, unknown>): Edit[] {
	const raw = args.edits;
	if (Array.isArray(raw)) {
		return raw.map((entry, index) => {
			if (typeof entry !== "object" || entry === null) {
				throw new ToolArgsError(`edits[${index}] must be an object with oldText and newText`);
			}
			const record = entry as Record<string, unknown>;
			const oldText = stringArg(record, "oldText");
			const newText = typeof record.newText === "string" ? record.newText : "";
			return { oldText, newText };
		});
	}

	const oldText = stringArg(args, "oldText");
	const newText = typeof args.newText === "string" ? args.newText : "";
	return [{ oldText, newText }];
}

export const TOOLS: ToolSchema[] = [
	{
		type: "function",
		function: {
			name: "list_files",
			description:
				"List the entries in one directory. Directories end with a slash. Use this before guessing any path.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Directory to list (default: .)" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description:
				"Read a file with line numbers. Keep startLine/limit small to save context. Line-number prefixes are display only: never copy them into oldText.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path to the file" },
					startLine: { type: "number", description: "First line, 1-based (default: 1)" },
					limit: { type: "number", description: "How many lines to read (default: 500)" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_files",
			description:
				"Search file contents for a pattern using ripgrep. Returns file:line:text. At most 50 matches, so prefer specific patterns.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Pattern to search for" },
					path: { type: "string", description: "Directory to search (default: .)" },
					includeNodeModules: {
						type: "boolean",
						description: "Also search ignored paths (default: false)",
					},
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description:
				"Create a file, or replace an entire existing file. For a small change to an existing file prefer replace_in_file. Overwriting reports the line-count delta so you can spot accidental truncation.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path to write" },
					content: { type: "string", description: "Full content of the file" },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "replace_in_file",
			description:
				"Replace text that must appear exactly once. Fails with an error if oldText is missing or ambiguous, so include surrounding lines to make it unique. All edits are applied atomically: if one fails, nothing is written. Returns a diff of what changed.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path to edit" },
					oldText: { type: "string", description: "Exact text to replace (single edit)" },
					newText: { type: "string", description: "Replacement text (single edit)" },
					edits: {
						type: "array",
						description:
							"Optional batch form: [{oldText, newText}, ...] applied atomically. Use instead of oldText/newText.",
						items: {
							type: "object",
							properties: {
								oldText: { type: "string" },
								newText: { type: "string" },
							},
							required: ["oldText", "newText"],
						},
					},
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_check",
			description:
				"Run 'mise run check' (linter plus tests). Call this after every change you make.",
			parameters: { type: "object", properties: {}, required: [] },
		},
	},
	{
		type: "function",
		function: {
			name: "git_diff",
			description:
				"Show unstaged changes (git diff). Use it to review your own work before reporting.",
			parameters: { type: "object", properties: {}, required: [] },
		},
	},
	{
		type: "function",
		function: {
			name: "bash",
			description:
				"Last resort. Run a shell command when no structured tool fits (installing packages, starting a server, git beyond diffing). Never use this to read or write files that read_file or replace_in_file can handle.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description:
							"The shell command to run. Must not reference secret files or shell variables.",
					},
				},
				required: ["command"],
			},
		},
	},
];

/**
 * Resolve the tool names declared in a prompt's frontmatter against the registry.
 * A name that does not exist is a startup error, not a silent omission: the
 * declared capability list and the actual one must be the same list.
 */
export function selectTools(names: string[]): ToolSchema[] {
	const byName = new Map(TOOLS.map((tool) => [tool.function.name, tool]));
	const unknown = names.filter((name) => !byName.has(name));
	if (unknown.length > 0) {
		throw new Error(`Unknown tool(s) in prompt frontmatter: ${unknown.join(", ")}`);
	}
	return names.map((name) => byName.get(name) as ToolSchema);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
	try {
		switch (name) {
			case "bash":
				return await runBash(stringArg(args, "command"));
			case "list_files":
				return await listFiles(stringArg(args, "path", false) || ".");
			case "read_file":
				return await readFileContent(
					stringArg(args, "path"),
					numberArg(args, "startLine", 1),
					numberArg(args, "limit", 500),
				);
			case "write_file":
				return await writeFileContent(
					stringArg(args, "path"),
					typeof args.content === "string" ? args.content : "",
				);
			case "replace_in_file":
				return await replaceInFile(stringArg(args, "path"), readEdits(args));
			case "search_files":
				return await searchFiles(
					stringArg(args, "query"),
					stringArg(args, "path", false) || ".",
					booleanArg(args, "includeNodeModules"),
				);
			case "run_check":
				return await runBash("mise run check");
			case "git_diff":
				return await gitDiff();
			default:
				return `Unknown tool: ${name}`;
		}
	} catch (error: unknown) {
		if (error instanceof ToolArgsError) return `Tool error: ${error.message}`;
		throw error;
	}
}
