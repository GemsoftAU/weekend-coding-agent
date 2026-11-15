import { existsSync, readdirSync, readFileSync } from "node:fs";
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

export interface FrontmatterSplit {
	/** Raw `key: value` fields, unparsed. Empty when the file has no frontmatter. */
	fields: Record<string, string>;
	/** Everything after the closing `---`, trimmed. */
	body: string;
	/** False when the file has no `---` block at all. */
	hasFrontmatter: boolean;
}

/**
 * Split a frontmatter block from its body. Shared by prompts and skills so both
 * read the same subset of YAML: `key: value`, plus indented or `- ` continuation
 * lines folded into the previous key. A full YAML parser is deliberately not
 * pulled in for four scalar fields.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw.trim(), hasFrontmatter: false };

	const fields: Record<string, string> = {};
	let currentKey = "";

	for (const line of match[1].split("\n")) {
		const kv = line.match(/^([A-Za-z_]+):\s?(.*)$/);
		if (kv) {
			currentKey = kv[1];
			fields[currentKey] = kv[2];
		} else if (currentKey) {
			fields[currentKey] += `\n${line}`;
		}
	}

	return { fields, body: match[2].trim(), hasFrontmatter: true };
}

export function parsePrompt(raw: string): PromptTemplate {
	const { fields, body } = splitFrontmatter(raw);
	if (Object.keys(fields).length === 0) {
		return {
			frontmatter: { name: "default", description: "", tools: [], subagents: [] },
			body,
		};
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

/** Every prompt in a directory, keyed by the name in its frontmatter. */
export type PromptRegistry = Record<string, PromptTemplate>;

const registryCache = new Map<string, PromptRegistry>();

/**
 * Read every `.md` file in `dir` into a registry. A prompt file that declares a
 * name different from its filename is still reachable by the declared name,
 * because that is the name the model is told to use.
 */
export function loadPrompts(dir = DEFAULT_DIR): PromptRegistry {
	const cached = registryCache.get(dir);
	if (cached) return cached;

	const registry: PromptRegistry = {};
	if (existsSync(dir)) {
		for (const file of readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort()) {
			const template = parsePrompt(readFileSync(join(dir, file), "utf-8"));
			registry[template.frontmatter.name] = template;
		}
	}
	registryCache.set(dir, registry);
	return registry;
}

/** Clear the registry cache. Intended for tests that write prompt files. */
export function resetPromptCache(): void {
	registryCache.clear();
}

/**
 * Look up one prompt by name. An unknown name is an error, not a silent
 * fallback: a typo in a `subagents:` list must fail at startup, not quietly
 * run the default agent under the wrong name.
 */
export function getPrompt(name: string, dir = DEFAULT_DIR): PromptTemplate {
	const registry = loadPrompts(dir);
	const template = registry[name];
	if (!template) {
		const known = Object.keys(registry).sort().join(", ") || "none";
		throw new Error(`Prompt not found: ${name} (known: ${known})`);
	}
	return template;
}

/** Every prompt, sorted by name, for the splash screen and /help. */
export function listPrompts(dir = DEFAULT_DIR): PromptTemplate[] {
	return Object.values(loadPrompts(dir)).sort((a, b) =>
		a.frontmatter.name.localeCompare(b.frontmatter.name),
	);
}
