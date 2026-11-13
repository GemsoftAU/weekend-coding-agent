import { describe, expect, test } from "bun:test";
import { parseList, parsePrompt } from "../src/lib/prompts";
import { TOOLS } from "../src/tools";

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

describe("tool schema", () => {
	test("exposes bash and run_check", () => {
		expect(TOOLS.map((t) => t.function.name)).toEqual(["bash", "run_check"]);
	});

	test("bash requires a command argument", () => {
		const bash = TOOLS.find((t) => t.function.name === "bash");
		expect(bash?.function.parameters).toEqual({
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
	});
});
