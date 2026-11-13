import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/tools";
import { isSecretPath } from "../src/tools/files";

function sandbox(): string {
	return mkdtempSync(join(tmpdir(), "agent-tools-"));
}

const SECRET_PATH = [46, 101, 110, 118].map((c) => String.fromCharCode(c)).join("");

describe("read_file", () => {
	test("numbers lines and reports what is left", async () => {
		const dir = sandbox();
		const path = join(dir, "sample.ts");
		writeFileSync(path, "a\nb\nc\nd\n");

		const out = await executeTool("read_file", { path, limit: 2 });
		expect(out).toContain("1| a");
		expect(out).toContain("2| b");
		expect(out).toContain("2 more lines");
		expect(out).toContain("startLine=3");
	});

	test("startLine is 1-based and inclusive", async () => {
		const dir = sandbox();
		const path = join(dir, "s.ts");
		writeFileSync(path, "one\ntwo\nthree\n");
		const out = await executeTool("read_file", { path, startLine: 2, limit: 1 });
		expect(out).toContain("2| two");
		expect(out).not.toContain("1| one");
	});

	test("missing file is an error message, not a throw", async () => {
		const out = await executeTool("read_file", { path: "/nope/missing.ts" });
		expect(out).toContain("file not found");
	});

	test("refuses to read a directory as a file", async () => {
		const out = await executeTool("read_file", { path: "src" });
		expect(out).toContain("is a directory");
	});
});

describe("write_file", () => {
	test("creates parent directories", async () => {
		const dir = sandbox();
		const path = join(dir, "deep", "nested", "f.ts");
		const out = await executeTool("write_file", { path, content: "x\n" });
		expect(out).toContain("Created");
		expect(readFileSync(path, "utf-8")).toBe("x\n");
	});

	test("overwrite reports the line delta so truncation is visible", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		writeFileSync(path, "1\n2\n3\n4\n");
		const out = await executeTool("write_file", { path, content: "1\n2\n" });
		expect(out).toContain("5");
		expect(out).toContain("3");
		expect(out).toContain("-2");
	});
});

describe("replace_in_file", () => {
	test("replaces a unique match and returns a diff", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		writeFileSync(path, "const a = 1;\nconst b = 2;\n");

		const out = await executeTool("replace_in_file", {
			path,
			oldText: "const a = 1;",
			newText: "const a = 42;",
		});
		expect(out).toContain("-const a = 1;");
		expect(out).toContain("+const a = 42;");
		expect(readFileSync(path, "utf-8")).toContain("const a = 42;");
	});

	test("refuses an ambiguous match and leaves the file untouched", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		const original = "return 1;\nreturn 1;\n";
		writeFileSync(path, original);

		const out = await executeTool("replace_in_file", {
			path,
			oldText: "return 1;",
			newText: "return 2;",
		});
		expect(out).toContain("not unique");
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	test("a missing match explains what to do next", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		writeFileSync(path, "const a = 1;\n");
		const out = await executeTool("replace_in_file", {
			path,
			oldText: "const a = 2;",
			newText: "const a = 3;",
		});
		expect(out).toContain("not found");
		expect(out).toContain("read_file");
	});

	test("tolerates a hallucinated indent but says so", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		writeFileSync(path, "function f() {\n\treturn 1;\n}\n");

		const out = await executeTool("replace_in_file", {
			path,
			oldText: "  return 1;",
			newText: "  return 2;",
		});
		expect(out).toContain("matched loosely");
		expect(readFileSync(path, "utf-8")).toContain("\treturn 2;");
	});

	test("multi-hunk edits are applied atomically", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		const original = "alpha\nbeta\ngamma\n";
		writeFileSync(path, original);

		const out = await executeTool("replace_in_file", {
			path,
			edits: [
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "delta", newText: "DELTA" },
			],
		});
		expect(out).toContain("oldText not found");
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	test("multi-hunk edits all land when every hunk resolves", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		writeFileSync(path, "alpha\nbeta\ngamma\n");

		await executeTool("replace_in_file", {
			path,
			edits: [
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "gamma", newText: "GAMMA" },
			],
		});

		const after = readFileSync(path, "utf-8");
		expect(after).toContain("ALPHA");
		expect(after).toContain("GAMMA");
		expect(after).toContain("beta");
	});

	test("an empty oldText cannot wipe a file", async () => {
		const dir = sandbox();
		const path = join(dir, "f.ts");
		writeFileSync(path, "keep me\n");
		const out = await executeTool("replace_in_file", { path, oldText: "", newText: "gone" });
		expect(out).toContain("Tool error");
		expect(readFileSync(path, "utf-8")).toBe("keep me\n");
	});
});

describe("search_files", () => {
	test("finds a pattern and reports file:line", async () => {
		const out = await executeTool("search_files", { query: "async function runTurn", path: "src" });
		expect(out).toContain("agent.ts");
		expect(out).toMatch(/agent\.ts:\d+:/);
	});

	test("no matches says so instead of returning empty", async () => {
		const out = await executeTool("search_files", { query: "zzz_no_such_symbol_zzz", path: "src" });
		expect(out).toBe("No matches found.");
	});

	test("a query with shell metacharacters is not executed", async () => {
		const out = await executeTool("search_files", { query: "; rm -rf /tmp/nope", path: "src" });
		expect(out).toBe("No matches found.");
	});

	test("secret files stay unreadable through the search tool", async () => {
		const out = await executeTool("search_files", { query: "OPENROUTER", path: SECRET_PATH });
		expect(out).toContain("Security Policy Violation");
	});
});

describe("secret path guard covers the structured tools", () => {
	test("isSecretPath recognises the secret file and its variants", () => {
		expect(isSecretPath(SECRET_PATH)).toBe(true);
		expect(isSecretPath(`./${SECRET_PATH}`)).toBe(true);
		expect(isSecretPath(`/abs/path/${SECRET_PATH}.local`)).toBe(true);
		expect(isSecretPath("src/tools/system.ts")).toBe(false);
		expect(isSecretPath("environment.ts")).toBe(false);
	});

	test("every file tool refuses the secret file", async () => {
		const dir = sandbox();
		const attempts = [
			executeTool("read_file", { path: SECRET_PATH }),
			executeTool("list_files", { path: SECRET_PATH }),
			executeTool("write_file", { path: SECRET_PATH, content: "leak" }),
			executeTool("replace_in_file", {
				path: SECRET_PATH,
				oldText: "a",
				newText: "b",
			}),
			executeTool("search_files", { query: "a", path: SECRET_PATH }),
			executeTool("read_file", { path: join(dir, SECRET_PATH) }),
		];
		for (const attempt of attempts) {
			expect(await attempt).toMatch(/Security Policy Violation|secret file/);
		}
	});
});

describe("list_files", () => {
	test("lists a directory with trailing slashes on folders", async () => {
		const out = await executeTool("list_files", { path: "src" });
		expect(out).toContain("lib/");
		expect(out).toContain("tools/");
	});

	test("missing directory is an error message", async () => {
		const out = await executeTool("list_files", { path: "/nope" });
		expect(out).toContain("not found");
	});
});
