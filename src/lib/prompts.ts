import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptFrontmatter {
	name: string;
	description: string;
	tools: string[];
	subagents: string[];
}

export interface PromptTemplate {
	frontmatter: PromptFrontmatter;
	body: string;
}

const DEFAULT_DIR = join(import.meta.dir, "..", "prompts");

export function parseList(raw: string): string[] {
	const inner = raw.match(/\[([\s\S]*)\]/);
	if (inner) {
		return inner[1]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).trim());
}

export function parsePrompt(raw: string): PromptTemplate {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		return {
			frontmatter: { name: "default", description: "", tools: [], subagents: [] },
			body: raw.trim(),
		};
	}

	const head = match[1];
	const body = match[2];
	const fields: Record<string, string> = {};
	let currentKey = "";

	for (const line of head.split("\n")) {
		const kv = line.match(/^([A-Za-z_]+):\s?(.*)$/);
		if (kv) {
			currentKey = kv[1];
			fields[currentKey] = kv[2];
		} else if (currentKey) {
			fields[currentKey] += `\n${line}`;
		}
	}

	return {
		frontmatter: {
			name: fields.name?.trim() || "default",
			description: fields.description?.trim() || "",
			tools: parseList(fields.tools ?? ""),
			subagents: parseList(fields.subagents ?? ""),
		},
		body: body.trim(),
	};
}

export function loadPrompt(name = "default", dir = DEFAULT_DIR): PromptTemplate {
	const path = join(dir, `${name}.md`);
	if (!existsSync(path)) throw new Error(`Prompt not found: ${path}`);
	return parsePrompt(readFileSync(path, "utf-8"));
}
