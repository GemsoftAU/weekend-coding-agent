// Skills: capabilities the agent loads on demand. A tool is always in the
// context window as a JSON schema; a skill costs one line of name, description
// and path until the model decides it needs the instructions, and only then
// pays for the body. The body is Markdown, so the "implementation" of a skill
// is documentation the model follows with the tools it already has.
//
// Discovery is by directory listing, never a hardcoded list: adding
// `skills/<name>/SKILL.md` and restarting is the whole installation procedure.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type PromptTemplate, splitFrontmatter } from "./prompts";

export interface SkillFrontmatter {
	/** The name the model refers to the skill by; falls back to the directory name. */
	name: string;
	description: string;
}

export interface Skill {
	frontmatter: SkillFrontmatter;
	/** The directory name, which is how the path is addressed. */
	dir: string;
	/** Path to the SKILL.md, relative to the skills root, as the model should cite it. */
	path: string;
	/** The full instructions. Held in memory but only shown when loaded. */
	body: string;
}

export interface SkillRegistryEntry {
	name: string;
	description: string;
	path: string;
}

/** Skills live at the repository root by default, beside `src/` and `tests/`. */
export const DEFAULT_SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");

/** The file every skill directory must contain. */
export const SKILL_FILE = "SKILL.md";

/** Parse one SKILL.md into a Skill, given the directory it came from. */
export function parseSkill(raw: string, dir: string, root = "skills"): Skill {
	const { fields, body } = splitFrontmatter(raw);
	return {
		frontmatter: {
			name: fields.name?.trim() || dir,
			description: fields.description?.trim().replace(/\s+/g, " ") || "",
		},
		dir,
		path: `${root}/${dir}/${SKILL_FILE}`.replace(/\\/g, "/"),
		body,
	};
}

export interface LoadSkillsOptions {
	/** Label used to build each skill's path, e.g. `skills` or `/abs/path/skills`. */
	pathPrefix?: string;
}

/**
 * Discover every `skills/<dir>/SKILL.md`. A missing skills directory is an
 * empty registry, not a throw: skills are optional, and a fresh checkout that
 * has not created one yet must still start. A directory without a SKILL.md is
 * skipped for the same reason — half-written skills must not break startup.
 */
export function loadSkills(dir = DEFAULT_SKILLS_DIR, options: LoadSkillsOptions = {}): Skill[] {
	if (!existsSync(dir)) return [];

	const root = options.pathPrefix ?? "skills";
	const skills: Skill[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!entry.isDirectory()) continue;
		const file = join(dir, entry.name, SKILL_FILE);
		if (!existsSync(file) || !statSync(file).isFile()) continue;
		try {
			skills.push(parseSkill(readFileSync(file, "utf-8"), entry.name, root));
		} catch {
			// An unreadable SKILL.md is skipped, not fatal: one broken skill must
			// not disable every other skill the agent could use.
		}
	}
	return skills;
}

/**
 * The one-line-per-skill listing shown in the system prompt. The name and
 * description are always visible; the body is not, so the model is told
 * explicitly to go and read it before acting.
 */
export function formatSkillRegistry(skills: Skill[]): string {
	return [
		"# Skills in this project",
		"Each skill below is a Markdown file that explains one non-obvious procedure.",
		`If the task matches a skill, read its file (${SKILL_FILE} in the skill directory) before doing the work. When a skill applies, use its command form, flags, and examples rather than inventing your own. Do not guess how a skill works (for example, flags or output paths) — read it first.`,
		"",
		...skills.map((s) => `- **${s.frontmatter.name}** — ${s.frontmatter.description} (${s.path})`),
	].join("\n");
}

/** A single skill's body, with a header naming the file so the model keeps it in mind. */
export function formatSkillBody(skill: Skill): string {
	return [
		`# Skill: ${skill.frontmatter.name}`,
		`Source: ${skill.path}`,
		"",
		skill.frontmatter.description,
		"",
		skill.body,
	].join("\n");
}

/** Find a skill by its declared name or by its directory name. */
export function findSkill(skills: Skill[], name: string): Skill | null {
	const needle = name.trim().toLowerCase();
	if (!needle) return null;
	return (
		skills.find((s) => s.frontmatter.name.toLowerCase() === needle) ??
		skills.find((s) => s.dir.toLowerCase() === needle) ??
		null
	);
}

/** A registry the model can quote in an argument: only the cheap frontmatter. */
export function skillRegistry(skills: Skill[]): SkillRegistryEntry[] {
	return skills.map(({ frontmatter, path }) => ({
		name: frontmatter.name,
		description: frontmatter.description,
		path,
	}));
}

/**
 * Resolve the skills root for a run. `AGENT_SKILLS_DIR` overrides the default
 * so a project can keep skills outside the repository, and so the tests can
 * point at a temporary directory instead of the shipped skills.
 */
export function resolveSkillsDir(env: Record<string, string | undefined> = process.env): string {
	const configured = env.AGENT_SKILLS_DIR?.trim();
	return configured ? resolve(configured) : DEFAULT_SKILLS_DIR;
}

/**
 * How the model should name a skill file. A relative `skills/...` path is what
 * the model expects and what read_file resolves against the working directory,
 * but that only holds when the skills directory is actually under it. Otherwise
 * the listing has to carry the absolute path, or the model is sent to a file
 * that does not exist.
 */
export function skillsPathPrefix(skillsDir: string, cwd = process.cwd()): string {
	const normalised = resolve(skillsDir);
	const base = resolve(cwd);
	if (normalised === join(base, "skills")) return "skills";
	if (normalised.startsWith(`${base}/`))
		return normalised.slice(base.length + 1).replace(/\\/g, "/");
	return normalised.replace(/\\/g, "/");
}

/** One line per agent: the frontmatter only, never the body. */
export function formatAgentRoster(agents: PromptTemplate[]): string {
	if (agents.length === 0) return "";
	return [
		"# Agents available in this project",
		"The agents below exist as prompt files. Only the `default` agent is running now; the others are reachable through `run_agent` when this prompt's frontmatter declares them as subagents.",
		"",
		...agents.map((a) => `- **${a.frontmatter.name}** — ${a.frontmatter.description}`),
	].join("\n");
}

export interface SystemPromptInput {
	/** The agent's own instructions. */
	body: string;
	/** Every prompt on disk, for the roster. Empty to omit the section. */
	agents?: PromptTemplate[];
	/** Every skill discovered on disk. Empty to omit the section. */
	skills?: Skill[];
}

/**
 * Compose the system prompt the model actually receives: the agent's own
 * instructions, then the discovered agents and skills. Nothing here is a
 * hardcoded list — all three parts come from disk, so a new prompt file or a
 * new skills directory appears on the next start with no code change.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
	const sections = [input.body.trim()];
	const roster = formatAgentRoster(input.agents ?? []);
	if (roster) sections.push(roster);
	if ((input.skills ?? []).length > 0) sections.push(formatSkillRegistry(input.skills ?? []));
	return sections.join("\n\n");
}
