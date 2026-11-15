import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent";
import { loadPrompt, parsePrompt, resetPromptCache, splitFrontmatter } from "../src/lib/prompts";
import {
	buildSystemPrompt,
	DEFAULT_SKILLS_DIR,
	findSkill,
	formatAgentRoster,
	formatSkillBody,
	formatSkillRegistry,
	loadSkills,
	parseSkill,
	resolveSkillsDir,
	SKILL_FILE,
	skillRegistry,
	skillsPathPrefix,
} from "../src/lib/skills";
import type { CompletionResponse, Message, ToolSchema } from "../src/lib/types";
import { executeTool } from "../src/tools";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "skills-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Create `<root>/<name>/SKILL.md`. */
function writeSkill(name: string, frontmatter: string, body: string, root = dir): void {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, SKILL_FILE), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("splitFrontmatter", () => {
	test("splits a frontmatter block from its body", () => {
		const split = splitFrontmatter("---\nname: x\ndescription: y\n---\n\nBody here\n");
		expect(split.hasFrontmatter).toBe(true);
		expect(split.fields.name).toBe("x");
		expect(split.fields.description).toBe("y");
		expect(split.body).toBe("Body here");
	});

	test("a file with no frontmatter is all body", () => {
		const split = splitFrontmatter("just text");
		expect(split.hasFrontmatter).toBe(false);
		expect(split.fields).toEqual({});
		expect(split.body).toBe("just text");
	});

	test("prompt parsing still works on top of it", () => {
		const parsed = parsePrompt("---\nname: a\ntools: [read_file]\n---\nBody");
		expect(parsed.frontmatter.name).toBe("a");
		expect(parsed.frontmatter.tools).toEqual(["read_file"]);
		expect(parsed.body).toBe("Body");
	});
});

describe("parseSkill", () => {
	test("reads the name and description from frontmatter", () => {
		const skill = parseSkill(
			"---\nname: big_text\ndescription: Banners\n---\n\nInstructions",
			"big_text",
		);
		expect(skill.frontmatter.name).toBe("big_text");
		expect(skill.frontmatter.description).toBe("Banners");
		expect(skill.body).toBe("Instructions");
		expect(skill.path).toBe("skills/big_text/SKILL.md");
	});

	test("falls back to the directory name when name is absent", () => {
		const skill = parseSkill("---\ndescription: only a description\n---\n\nBody", "from_dir");
		expect(skill.frontmatter.name).toBe("from_dir");
	});

	test("collapses newlines in a folded description so the listing stays one line", () => {
		const skill = parseSkill("---\nname: x\ndescription: a\n  b\n---\nBody", "x");
		expect(skill.frontmatter.description).toBe("a b");
	});

	test("honours a custom path prefix", () => {
		const skill = parseSkill("---\nname: x\n---\nBody", "x", "/abs/skills");
		expect(skill.path).toBe("/abs/skills/x/SKILL.md");
	});
});

describe("loadSkills", () => {
	test("discovers every directory that has a SKILL.md, sorted by name", () => {
		writeSkill("zeta", "name: zeta\ndescription: z", "Z body");
		writeSkill("alpha", "name: alpha\ndescription: a", "A body");

		const skills = loadSkills(dir);
		expect(skills.map((s) => s.frontmatter.name)).toEqual(["alpha", "zeta"]);
		expect(skills[0].body).toBe("A body");
	});

	test("a missing skills directory is an empty list, not a throw", () => {
		expect(loadSkills(join(dir, "nope"))).toEqual([]);
	});

	test("a directory without a SKILL.md is skipped", () => {
		writeSkill("real", "name: real\ndescription: d", "body");
		mkdirSync(join(dir, "empty"), { recursive: true });
		expect(loadSkills(dir).map((s) => s.frontmatter.name)).toEqual(["real"]);
	});

	test("stray files at the skills root are ignored", () => {
		writeSkill("real", "name: real\ndescription: d", "body");
		writeFileSync(join(dir, "README.md"), "not a skill");
		expect(loadSkills(dir)).toHaveLength(1);
	});

	test("the shipped skills are discoverable and describe themselves", () => {
		const skills = loadSkills(DEFAULT_SKILLS_DIR);
		expect(skills.length).toBeGreaterThan(0);
		const names = skills.map((s) => s.frontmatter.name);
		expect(names).toContain("big_text");
		expect(names).toContain("generate_image");
		expect(names).toContain("generate_video");
		for (const skill of skills) {
			// A description is the only thing the model sees before deciding to load it.
			expect(skill.frontmatter.description.length).toBeGreaterThan(20);
			expect(skill.body.length).toBeGreaterThan(100);
			expect(skill.path.endsWith(`${skill.dir}/${SKILL_FILE}`)).toBe(true);
		}
	});
});

describe("findSkill", () => {
	// Built in beforeEach, not at collection time: `dir` does not exist yet when
	// the describe body runs.
	let skills: ReturnType<typeof loadSkills>;

	beforeEach(() => {
		writeSkill("big_text", "name: big_text\ndescription: banners", "body");
		skills = loadSkills(dir);
	});

	test("finds by declared name", () => {
		expect(findSkill(skills, "big_text")?.frontmatter.name).toBe("big_text");
	});

	test("is case-insensitive and ignores surrounding space", () => {
		expect(findSkill(skills, "  BIG_TEXT ")?.frontmatter.name).toBe("big_text");
	});

	test("finds by directory name when the declared name differs", () => {
		const odd = [parseSkill("---\nname: Pretty Name\n---\nbody", "the_dir")];
		expect(findSkill(odd, "the_dir")?.frontmatter.name).toBe("Pretty Name");
	});

	test("an unknown or blank name is null", () => {
		expect(findSkill(skills, "ghost")).toBeNull();
		expect(findSkill(skills, "   ")).toBeNull();
	});
});

describe("formatting", () => {
	const skills = [parseSkill("---\nname: demo\ndescription: Does a demo\n---\nStep one", "demo")];

	test("the registry lists name, description and path but not the body", () => {
		const out = formatSkillRegistry(skills);
		expect(out).toContain("**demo**");
		expect(out).toContain("Does a demo");
		expect(out).toContain("skills/demo/SKILL.md");
		// The body is the whole point of on-demand loading: it must not be here.
		expect(out).not.toContain("Step one");
	});

	test("the registry tells the model to read the file before acting", () => {
		const out = formatSkillRegistry(skills).toLowerCase();
		expect(out).toContain("read");
		expect(out).toContain("before doing the work");
	});

	test("a loaded body carries its name and source", () => {
		const out = formatSkillBody(skills[0]);
		expect(out).toContain("# Skill: demo");
		expect(out).toContain("Source: skills/demo/SKILL.md");
		expect(out).toContain("Step one");
	});

	test("skillRegistry exposes only the cheap frontmatter", () => {
		expect(skillRegistry(skills)).toEqual([
			{ name: "demo", description: "Does a demo", path: "skills/demo/SKILL.md" },
		]);
	});

	test("the agent roster lists prompts by name and description", () => {
		const out = formatAgentRoster([
			{
				frontmatter: { name: "poet", description: "Writes poems", tools: [], subagents: [] },
				body: "SECRET",
			},
		]);
		expect(out).toContain("**poet**");
		expect(out).toContain("Writes poems");
		expect(out).not.toContain("SECRET");
	});

	test("an empty roster is empty output, so the section can be omitted", () => {
		expect(formatAgentRoster([])).toBe("");
	});
});

describe("buildSystemPrompt", () => {
	const agent = {
		frontmatter: { name: "helper", description: "Helps", tools: [], subagents: [] },
		body: "B",
	};
	const skills = [parseSkill("---\nname: demo\ndescription: Does a demo\n---\nStep one", "demo")];

	test("is the agent body when there is nothing else to add", () => {
		expect(buildSystemPrompt({ body: "Just me" })).toBe("Just me");
	});

	test("appends the agent roster and the skills listing", () => {
		const out = buildSystemPrompt({ body: "Agent body", agents: [agent], skills });
		expect(out.startsWith("Agent body")).toBe(true);
		expect(out).toContain("# Agents available in this project");
		expect(out).toContain("**helper**");
		expect(out).toContain("# Skills in this project");
		expect(out).toContain("**demo**");
		// Ordering: the agent's own instructions must come before the registry.
		expect(out.indexOf("Agent body")).toBeLessThan(out.indexOf("# Agents available"));
		expect(out.indexOf("# Agents available")).toBeLessThan(out.indexOf("# Skills in this project"));
	});

	test("omits the skills section entirely when there are none", () => {
		expect(buildSystemPrompt({ body: "B", skills: [] })).not.toContain("# Skills in this project");
	});
});

describe("skillsPathPrefix", () => {
	test("a skills directory directly under the working directory is addressed relatively", () => {
		expect(skillsPathPrefix("/repo/skills", "/repo")).toBe("skills");
	});

	test("a nested skills directory keeps its relative path", () => {
		expect(skillsPathPrefix("/repo/tools/skills", "/repo")).toBe("tools/skills");
	});

	test("a directory outside the working directory gets an absolute path", () => {
		expect(skillsPathPrefix("/elsewhere/skills", "/repo")).toBe("/elsewhere/skills");
	});
});

describe("resolveSkillsDir", () => {
	test("defaults to the shipped skills directory", () => {
		expect(resolveSkillsDir({})).toBe(DEFAULT_SKILLS_DIR);
	});

	test("AGENT_SKILLS_DIR overrides it", () => {
		expect(resolveSkillsDir({ AGENT_SKILLS_DIR: "/tmp/mine" })).toBe("/tmp/mine");
	});

	test("a blank override is ignored", () => {
		expect(resolveSkillsDir({ AGENT_SKILLS_DIR: "   " })).toBe(DEFAULT_SKILLS_DIR);
	});
});

describe("use_skill and list_skills tools", () => {
	const skills = [parseSkill("---\nname: demo\ndescription: Does a demo\n---\nStep one", "demo")];

	test("use_skill returns the body for a known skill", async () => {
		const out = await executeTool("use_skill", { name: "demo" }, { skills });
		expect(out).toContain("# Skill: demo");
		expect(out).toContain("Step one");
	});

	test("an unknown skill is a tool error listing the known ones", async () => {
		const out = await executeTool("use_skill", { name: "ghost" }, { skills });
		expect(out).toContain("Tool error");
		expect(out).toContain("Unknown skill: ghost");
		expect(out).toContain("demo");
	});

	test("use_skill without any skills says so instead of failing obscurely", async () => {
		const out = await executeTool("use_skill", { name: "demo" }, {});
		expect(out).toContain("Tool error");
		expect(out).toContain("No skills");
	});

	test("use_skill requires a name argument", async () => {
		const out = await executeTool("use_skill", {}, { skills });
		expect(out).toContain("Tool error");
		expect(out).toContain("name");
	});

	test("list_skills lists every skill with its path", async () => {
		const out = await executeTool("list_skills", {}, { skills });
		expect(out).toContain("demo");
		expect(out).toContain("skills/demo/SKILL.md");
	});

	test("list_skills says so when there are none", async () => {
		expect(await executeTool("list_skills", {}, {})).toContain("No skills");
	});
});

describe("skills in the agent loop", () => {
	/** Canned responses, recording what the model was sent. */
	function scriptedApi(responses: CompletionResponse[]) {
		const seen: Array<{ messages: Message[]; tools: ToolSchema[] }> = [];
		let i = 0;
		const caller = async (messages: Message[], tools: ToolSchema[]) => {
			seen.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
			return responses[i++];
		};
		return { caller, seen };
	}

	function toolCall(name: string, args: Record<string, unknown>): CompletionResponse {
		return {
			choices: [
				{
					message: {
						role: "assistant",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name, arguments: JSON.stringify(args) },
							},
						],
					},
				},
			],
		};
	}

	function text(content: string): CompletionResponse {
		return { choices: [{ message: { role: "assistant", content } }] };
	}

	test("the model can load a skill body through the loop", async () => {
		const skills = [parseSkill("---\nname: demo\ndescription: Does a demo\n---\nStep one", "demo")];
		const api = scriptedApi([toolCall("use_skill", { name: "demo" }), text("done")]);

		const result = await runTurn(
			[{ role: "user", content: "use the demo skill" }],
			api.caller,
			executeTool,
			[],
			undefined,
			"default",
			null,
			null,
			{ skills },
		);

		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage?.content).toContain("Step one");
	});

	test("a subagent gets the skills listing even though it starts from its own prompt", async () => {
		resetPromptCache();
		writeFileSync(
			join(dir, "helper.md"),
			"---\nname: helper\ndescription: helps\ntools: [use_skill]\n---\n\nYou help.\n",
		);
		const skills = [parseSkill("---\nname: demo\ndescription: Does a demo\n---\nStep one", "demo")];
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "helper", task: "do it" }),
			text("sub answer"),
			text("parent done"),
		]);

		await runTurn(
			[{ role: "user", content: "delegate" }],
			api.caller,
			executeTool,
			[
				{
					type: "function",
					function: { name: "run_agent", description: "d", parameters: {} },
				},
			],
			undefined,
			"default",
			null,
			null,
			{ promptDir: dir, skills },
		);

		const subSystem = api.seen[1].messages[0].content ?? "";
		expect(subSystem).toContain("You help.");
		expect(subSystem).toContain("**demo**");
		// The body is still not spent: only the listing travels.
		expect(subSystem).not.toContain("Step one");
	});

	test("a subagent that cannot load a skill is not given the listing", async () => {
		resetPromptCache();
		// The poet shape: ask_user and nothing else.
		writeFileSync(
			join(dir, "mute.md"),
			"---\nname: mute\ndescription: asks only\ntools: [ask_user]\n---\n\nYou only ask.\n",
		);
		const skills = [parseSkill("---\nname: demo\ndescription: Does a demo\n---\nStep one", "demo")];
		const api = scriptedApi([
			toolCall("run_agent", { agentName: "mute", task: "ask" }),
			text("sub answer"),
			text("parent done"),
		]);

		await runTurn(
			[],
			api.caller,
			executeTool,
			[
				{
					type: "function",
					function: { name: "run_agent", description: "d", parameters: {} },
				},
			],
			undefined,
			"default",
			null,
			null,
			{ promptDir: dir, skills, askUser: async () => "an answer" },
		);

		const subSystem = api.seen[1].messages[0].content ?? "";
		expect(subSystem).toContain("You only ask.");
		expect(subSystem).not.toContain("# Skills in this project");
	});
});

describe("the shipped prompt files", () => {
	test("default declares the skill tools, so the listing is usable", () => {
		const { frontmatter } = loadPrompt("default");
		expect(frontmatter.tools).toContain("use_skill");
		expect(frontmatter.tools).toContain("list_skills");
	});

	test("default tells the agent to load a skill before doing the work", () => {
		const body = loadPrompt("default").body.toLowerCase();
		expect(body).toContain("use_skill");
		expect(body).toContain("skill");
	});

	test("no prompt hardcodes the skill names: they come from disk", () => {
		// A SKILL.md is discoverable, but never named in a prompt file's frontmatter.
		for (const name of ["default", "code-map", "tech-researcher", "feature-planner", "poet"]) {
			const { frontmatter } = loadPrompt(name);
			expect(frontmatter.tools).not.toContain("big_text");
			expect(frontmatter.subagents).not.toContain("generate_image");
		}
	});
});
