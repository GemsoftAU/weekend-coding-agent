import { describe, expect, test } from "bun:test";
import { executeTool } from "../src/tools";
import { isBlocked, runGuardedBash } from "../src/tools/system";

const SECRET_PATH = [46, 101, 110, 118].map((c) => String.fromCharCode(c)).join("");

describe("bash tool", () => {
	test("lists the files in the src directory", async () => {
		const out = await executeTool("bash", { command: "ls src" });
		expect(out).toContain("lib");
		expect(out).toContain("tools");
		expect(out).toContain("agent.ts");
	});

	test("lists files in the current directory", async () => {
		const out = await executeTool("bash", { command: "ls" });
		expect(out).toContain("src");
		expect(out).toContain("tests");
	});

	test("handles failing commands gracefully", async () => {
		const out = await executeTool("bash", { command: "ls /definitely/not/here" });
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
	});

	test("rejects a missing command argument", async () => {
		const out = await executeTool("bash", {});
		expect(out).toContain("Tool error");
	});

	test("blocks access to secret files", async () => {
		const out = await executeTool("bash", { command: `cat ${SECRET_PATH}` });
		expect(out).toContain("Security Policy Violation");
	});

	test("unknown tools return a message rather than throwing", async () => {
		const out = await executeTool("nope", {});
		expect(out).toContain("Unknown tool");
	});
});

describe("guarded bash", () => {
	test("uses the injected runner and does not shell out", async () => {
		const out = await runGuardedBash("echo hi", async () => "fake output");
		expect(out).toBe("fake output");
	});

	test("blocked commands never reach the runner", async () => {
		let ran = false;
		const out = await runGuardedBash(`cat ${SECRET_PATH}`, async () => {
			ran = true;
			return "leaked";
		});
		expect(ran).toBe(false);
		expect(out).toContain("Security Policy Violation");
	});

	test("isBlocked flags secret-file access", () => {
		expect(isBlocked(`cat ${SECRET_PATH}`)).toBe(true);
		expect(isBlocked("ls src")).toBe(false);
	});
});
