import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Built from char codes so this source file does not itself contain the guarded literals.
const SECRET_FILE = [46, 101, 110, 118].map((c) => String.fromCharCode(c)).join("");

/**
 * Structured tools need their own path guard. runGuardedBash only protects the bash
 * escape hatch; read_file and search_files bypass it entirely, so without this the
 * "safe" tools become the weakest link.
 */
export function isSecretPath(path: string): boolean {
	const name = basename(resolve(path));
	return name === SECRET_FILE || name.startsWith(`${SECRET_FILE}.`);
}

export function refuseSecretPath(path: string): string | null {
	if (isSecretPath(path)) {
		return `Security Policy Violation: ${path} is a secret file and cannot be read, searched, or written.`;
	}
	return null;
}

export const MAX_READ_LINES = 500;
export const MAX_MATCHES = 50;
export const MAX_ENTRIES = 200;
const MAX_OUTPUT_CHARS = 60_000;

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (output truncated at ${MAX_OUTPUT_CHARS} characters)`;
}

export async function listFiles(path = "."): Promise<string> {
	if (isSecretPath(path)) return `Error: ${path} is a secret file and cannot be listed.`;
	if (!existsSync(path)) return `Error: path not found: ${path}`;
	if (!statSync(path).isDirectory()) return `Error: not a directory: ${path}`;

	const entries = readdirSync(path, { withFileTypes: true })
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
		.filter((name) => name !== ".git/")
		.sort();

	if (entries.length === 0) return `${path} is empty.`;

	const shown = entries.slice(0, MAX_ENTRIES);
	const hidden = entries.length - shown.length;
	const footer = hidden > 0 ? `\n... (and ${hidden} more entries)` : "";
	return clip(shown.join("\n") + footer);
}

export async function readFileContent(
	path: string,
	startLine = 1,
	limit = MAX_READ_LINES,
): Promise<string> {
	const refused = refuseSecretPath(path);
	if (refused) return refused;
	if (!existsSync(path)) return `Error: file not found: ${path}`;
	if (statSync(path).isDirectory()) return `Error: ${path} is a directory. Use list_files.`;

	const raw = readFileSync(path, "utf-8");
	if (raw === "") return `(${path} is empty)`;

	const lines = raw.split("\n");
	if (raw.endsWith("\n")) lines.pop();

	const start = Math.max(1, Math.floor(startLine));
	const count = Math.max(1, Math.floor(limit));
	const slice = lines.slice(start - 1, start - 1 + count);

	if (slice.length === 0) {
		return `Error: startLine ${start} is past the end of ${path} (${lines.length} lines).`;
	}

	const width = String(start + slice.length - 1).length;
	const numbered = slice
		.map((line, i) => `${String(start + i).padStart(width, " ")}| ${line}`)
		.join("\n");

	const consumed = start - 1 + slice.length;
	const remaining = lines.length - consumed;
	const footer =
		remaining > 0
			? `\n... (${remaining} more lines; call read_file with startLine=${consumed + 1})`
			: "";

	return clip(numbered + footer);
}

export async function writeFileContent(path: string, content: string): Promise<string> {
	const refused = refuseSecretPath(path);
	if (refused) return refused;

	const existed = existsSync(path);
	let previousLines = 0;

	if (existed) {
		if (statSync(path).isDirectory()) return `Error: ${path} is a directory.`;
		// Report the delta on overwrite: a silent shrink is how truncation hides.
		previousLines = readFileSync(path, "utf-8").split("\n").length;
	}

	mkdirSync(dirname(path) || ".", { recursive: true });
	writeFileSync(path, content, "utf-8");

	const newLines = content.split("\n").length;
	if (!existed) {
		return `Created ${path}: ${newLines} lines, ${content.length} bytes.`;
	}

	const delta = newLines - previousLines;
	const sign = delta >= 0 ? "+" : "";
	return `Overwrote ${path}: ${previousLines} → ${newLines} lines (${sign}${delta}).`;
}

export function leadingWhitespace(line: string): string {
	const match = line.match(/^[ \t]*/);
	return match ? match[0] : "";
}

/** Re-anchor a replacement block to the indentation actually found in the file. */
function indentBlock(text: string, fromIndent: string, toIndent: string): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.trim() === "") return line;
			const stripped = line.startsWith(fromIndent)
				? line.slice(fromIndent.length)
				: line.trimStart();
			return `${toIndent}${stripped}`;
		})
		.join("\n");
}

interface LooseHit {
	startLine: number;
	lineCount: number;
	indent: string;
}

/**
 * Whitespace-tolerant locator. Matches on trimmed lines so a hallucinated indent
 * does not kill the edit, but only accepts the result when it is unambiguous.
 */
function findLooseHit(content: string, oldText: string): LooseHit | null {
	const contentLines = content.split("\n");
	const target = oldText.split("\n").map((line) => line.trim());
	while (target.length > 0 && target[target.length - 1] === "") target.pop();
	if (target.length === 0) return null;

	const hits: LooseHit[] = [];
	for (let i = 0; i + target.length <= contentLines.length; i++) {
		let ok = true;
		for (let j = 0; j < target.length; j++) {
			if (contentLines[i + j].trim() !== target[j]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			hits.push({
				startLine: i,
				lineCount: target.length,
				indent: leadingWhitespace(contentLines[i]),
			});
		}
	}

	return hits.length === 1 ? hits[0] : null;
}

/** Minimal common-prefix/common-suffix diff: enough for the model to check its own edit. */
export function contextDiff(before: string, after: string, context = 2): string {
	if (before === after) return "(no change)";

	const a = before.split("\n");
	const b = after.split("\n");

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;

	let endA = a.length - 1;
	let endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) {
		endA--;
		endB--;
	}

	const pre = a.slice(Math.max(0, start - context), start).map((line) => ` ${line}`);
	const removed = a.slice(start, endA + 1).map((line) => `-${line}`);
	const added = b.slice(start, endB + 1).map((line) => `+${line}`);
	const post = a.slice(endA + 1, endA + 1 + context).map((line) => ` ${line}`);

	return [
		`@@ line ${Math.max(0, start - context) + 1} @@`,
		...pre,
		...removed,
		...added,
		...post,
	].join("\n");
}

export interface Edit {
	oldText: string;
	newText: string;
}

/**
 * Apply one or more unique-string edits atomically.
 * Every edit is validated against the working copy before anything is written,
 * so a failing hunk leaves the file untouched instead of half-edited.
 */
export async function replaceInFile(filePath: string, edits: Edit[]): Promise<string> {
	if (edits.length === 0) return "Error: no edits provided.";

	const refused = refuseSecretPath(filePath);
	if (refused) return refused;
	if (!existsSync(filePath)) return `Error: file not found: ${filePath}`;
	if (statSync(filePath).isDirectory()) return `Error: ${filePath} is a directory. Use write_file.`;

	const original = readFileSync(filePath, "utf-8");
	let working = original;
	const notes: string[] = [];

	for (const [index, edit] of edits.entries()) {
		const label = `edit ${index + 1}/${edits.length}`;

		if (!edit.oldText || edit.oldText === "") {
			return `Error: ${label} has an empty oldText. Use write_file to create or replace a whole file.`;
		}

		const occurrences = working.split(edit.oldText).length - 1;

		if (occurrences === 1) {
			working = working.replace(edit.oldText, edit.newText);
			continue;
		}

		if (occurrences > 1) {
			return `Error: ${label}: oldText is not unique in ${filePath} (${occurrences} matches). Add surrounding context so it matches exactly once.`;
		}

		const loose = findLooseHit(working, edit.oldText);
		if (!loose) {
			return `Error: ${label}: oldText not found in ${filePath}. Re-read the file with read_file and copy the exact text; there may be a whitespace or wording difference.`;
		}

		const lines = working.split("\n");
		const fromIndent = leadingWhitespace(edit.oldText.split("\n")[0]);
		const replacement = indentBlock(edit.newText, fromIndent, loose.indent).split("\n");
		lines.splice(loose.startLine, loose.lineCount, ...replacement);
		working = lines.join("\n");
		notes.push(`${label}: matched loosely (whitespace differed) — verify the result below.`);
	}

	if (working === original) {
		return "No changes were made: the replacement text is identical to the original.";
	}

	writeFileSync(filePath, working, "utf-8");

	const header = `Updated ${filePath}: ${edits.length} edit${edits.length === 1 ? "" : "s"} applied.`;
	return [header, ...notes, "", contextDiff(original, working)].join("\n");
}

export async function searchFiles(
	query: string,
	searchPath = ".",
	includeNodeModules = false,
): Promise<string> {
	if (!query.trim()) return "Error: query must not be empty.";
	if (isSecretPath(searchPath)) {
		return `Security Policy Violation: ${searchPath} is a secret file and cannot be searched.`;
	}
	if (!existsSync(searchPath)) return `Error: path not found: ${searchPath}`;

	// argv array, no shell: the query cannot escape into a command.
	const argv = ["rg", "-n", "--no-heading", "--color", "never"];
	// Never surface secret files, even when they sit inside a searched directory.
	argv.push("-g", `!${SECRET_FILE}`, "-g", `!${SECRET_FILE}.*`);
	if (includeNodeModules) argv.push("-u");
	argv.push("--", query, searchPath);

	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	const trimmed = stdout.trim();
	if (code === 1 || trimmed === "") {
		if (code > 1 && stderr.trim() !== "") return `rg failed: ${stderr.trim()}`;
		return "No matches found.";
	}

	const lines = trimmed.split("\n");
	if (lines.length > MAX_MATCHES) {
		return clip(
			`${lines.slice(0, MAX_MATCHES).join("\n")}\n... (and ${lines.length - MAX_MATCHES} more matches; narrow the query or path)`,
		);
	}
	return clip(trimmed);
}
