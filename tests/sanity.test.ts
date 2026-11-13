import { describe, expect, test } from "bun:test";
import { parseList, parsePrompt } from "../src/lib/prompts";
import { selectTools, TOOLS } from "../src/tools";

describe("prompt parsing", () => {
	test("splits frontmatter from body", () => {
		const raw = [
			"---",
			"name: tester",
			"description: a test",
			"tools: [bash, read_file]",
			"---",
			"You are helpful.",
		].join("\n");
		const t = parsePrompt(raw);
		expect(t.frontmatter.name).toBe("tester");
		expect(t.frontmatter.description).toBe("a test");
		expect(t.frontmatter.tools).toEqual(["bash", "read_file"]);
		expect(t.body).toBe("You are helpful.");
	});

	test("parses yaml block lists", () => {
		const raw = ["---", "name: x", "tools:", "  - bash", "  - run_check", "---", "body"].join("\n");
		expect(parsePrompt(raw).frontmatter.tools).toEqual(["bash", "run_check"]);
	});

	test("returns defaults when there is no frontmatter", () => {
		const t = parsePrompt("just a body");
		expect(t.frontmatter.name).toBe("default");
		expect(t.body).toBe("just a body");
	});

	test("parseList of an empty string is empty", () => {
		expect(parseList("")).toEqual([]);
	});
});

describe("tool registry", () => {
	test("registers the full structured toolset", () => {
		expect(TOOLS.map((t) => t.function.name)).toEqual([
			"list_files",
			"read_file",
			"search_files",
			"write_file",
			"replace_in_file",
			"run_check",
			"git_diff",
			"bash",
		]);
	});

	test("every tool has a description the model can choose from", () => {
		for (const tool of TOOLS) {
			expect(tool.function.description.length).toBeGreaterThan(20);
		}
	});

	test("bash is documented as a last resort", () => {
		const bash = TOOLS.find((t) => t.function.name === "bash");
		expect(bash?.function.description.toLowerCase()).toContain("last resort");
	});

	test("bash requires a command argument", () => {
		const bash = TOOLS.find((t) => t.function.name === "bash");
		expect(bash?.function.parameters).toEqual({
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The shell command to run. Must not reference secret files or shell variables.",
				},
			},
			required: ["command"],
		});
	});
});

describe("selectTools", () => {
	test("returns only the declared tools, in declared order", () => {
		const selected = selectTools(["read_file", "run_check"]);
		expect(selected.map((t) => t.function.name)).toEqual(["read_file", "run_check"]);
	});

	test("a model cannot reach a tool its prompt does not declare", () => {
		const selected = selectTools(["read_file"]);
		expect(selected.some((t) => t.function.name === "bash")).toBe(false);
	});

	test("an unknown declared tool is a startup error, not a silent omission", () => {
		expect(() => selectTools(["read_file", "teleport"])).toThrow("Unknown tool");
	});
});
