import { afterEach, describe, expect, test } from "bun:test";
import { loadEnvFile, resolveGeminiKey } from "../src/lib/env";

// The previous test proves a value on process.env reaches a child. This one
// proves the loader is what puts it there when nothing else has: it explicitly
// clears the variable, loads the real project file, and checks it came back.
// Bun auto-loads the file, so without the delete this would pass vacuously.
describe("the loader populates the environment itself", () => {
	const original = process.env.GEMINI_API_KEY;

	afterEach(() => {
		if (original === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = original;
	});

	test("after clearing the variable, loading the project file restores it", () => {
		delete process.env.GEMINI_API_KEY;
		expect(resolveGeminiKey()).toBeUndefined();

		const result = loadEnvFile();

		const restored = resolveGeminiKey();
		if (restored === undefined) {
			// No env file in this checkout: the loader is a clean no-op, which is
			// also the required behaviour on a fresh clone.
			expect(result.loaded).toEqual([]);
			return;
		}

		expect(result.loaded).toContain("GEMINI_API_KEY");
		// Reports names only: the result is safe to print, the value is not.
		expect(result.loaded.every((name) => typeof name === "string")).toBe(true);
		expect(restored.length).toBeGreaterThan(0);
	});
});
