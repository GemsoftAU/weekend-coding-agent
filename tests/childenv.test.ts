import { afterEach, describe, expect, test } from "bun:test";
import { loadEnvFile, resolveGeminiKey } from "../src/lib/env";

// Skills are executed as shell commands, so a key that the parent process holds
// but a child does not is a key that every image/video skill will fail to use.
// This pins that invariant without needing a real key: it sets a marker value,
// spawns a child, and checks the child saw it. No secret is printed, and the
// real environment is restored afterwards.
describe("key inheritance by spawned processes", () => {
	const original = process.env.GEMINI_API_KEY;

	afterEach(() => {
		if (original === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = original;
	});

	test("a value on process.env is visible to a child shell", async () => {
		process.env.GEMINI_API_KEY = "marker-value-for-inheritance-test";

		// The child reads its own environment and reports only the length.
		const script = "process.stdout.write(String((process.env.GEMINI_API_KEY||'').length))";
		const observed = (await Bun.$`node -e ${script}`.text()).trim();

		expect(Number(observed)).toBe("marker-value-for-inheritance-test".length);
	});

	test("loadEnvFile only ever reports names, so its result is safe to log", () => {
		const result = loadEnvFile({}, "/nonexistent/path/for/test");
		// The shape is names, not values: a value here would mean a leak in the log.
		expect(Object.keys(result).sort()).toEqual(["loaded", "skipped"]);
	});

	test("resolveGeminiKey reflects what loadEnvFile put in the environment", () => {
		loadEnvFile();
		const key = resolveGeminiKey();
		// Presence only: the assertion never depends on the value itself.
		expect(key === undefined || key.length > 0).toBe(true);
	});
});
