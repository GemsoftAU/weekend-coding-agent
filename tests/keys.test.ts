import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configuredKeys,
	ENV_FILE,
	loadEnvFile,
	parseEnvFile,
	resolveApiKey,
	resolveGeminiKey,
} from "../src/lib/env";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "keys-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeEnv(contents: string): string {
	const path = join(dir, "conf");
	writeFileSync(path, contents);
	return path;
}

describe("parseEnvFile", () => {
	test("reads plain KEY=value pairs", () => {
		expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
	});

	test("ignores blank lines and comments", () => {
		expect(parseEnvFile("# note\n\nA=1\n   \n#B=2")).toEqual({ A: "1" });
	});

	test("strips one layer of matching quotes", () => {
		expect(parseEnvFile('A="quoted"\nB=\'single\'\nC="half')).toEqual({
			A: "quoted",
			B: "single",
			C: '"half',
		});
	});

	test("accepts an export prefix", () => {
		expect(parseEnvFile("export A=1")).toEqual({ A: "1" });
	});

	test("keeps = inside the value", () => {
		expect(parseEnvFile("A=a=b=c")).toEqual({ A: "a=b=c" });
	});

	test("skips lines that are not assignments or have bad names", () => {
		expect(parseEnvFile("NOVALUE\n=orphan\n2BAD=x\nGOOD=y")).toEqual({ GOOD: "y" });
	});

	test("trims surrounding whitespace around name and value", () => {
		expect(parseEnvFile("  A  =  spaced  ")).toEqual({ A: "spaced" });
	});
});

describe("loadEnvFile", () => {
	test("loads keys into an injected environment", () => {
		const path = writeEnv("GEMINI_API_KEY=secret-value-123\n");
		const env: Record<string, string | undefined> = {};
		const result = loadEnvFile(env, path);

		expect(result.loaded).toEqual(["GEMINI_API_KEY"]);
		expect(env.GEMINI_API_KEY).toBe("secret-value-123");
	});

	test("never overrides a value already in the environment", () => {
		const path = writeEnv("GEMINI_API_KEY=from-file\n");
		const env = { GEMINI_API_KEY: "from-process" };
		const result = loadEnvFile(env, path);

		expect(env.GEMINI_API_KEY).toBe("from-process");
		expect(result.loaded).toEqual([]);
		expect(result.skipped).toEqual(["GEMINI_API_KEY"]);
	});

	test("a whitespace-only existing value still counts as unset", () => {
		const path = writeEnv("GEMINI_API_KEY=from-file\n");
		const env = { GEMINI_API_KEY: "   " };
		loadEnvFile(env, path);
		expect(env.GEMINI_API_KEY).toBe("from-file");
	});

	test("a missing file is a no-op, not an error", () => {
		const env: Record<string, string | undefined> = {};
		expect(loadEnvFile(env, join(dir, "nope"))).toEqual({ loaded: [], skipped: [] });
		expect(env).toEqual({});
	});

	test("empty values are dropped so they cannot shadow a later load", () => {
		const path = writeEnv("EMPTY=\nFILLED=x\n");
		const env: Record<string, string | undefined> = {};
		const result = loadEnvFile(env, path);
		expect(result.loaded).toEqual(["FILLED"]);
		expect(env.EMPTY).toBeUndefined();
	});
});

describe("resolveApiKey", () => {
	test("returns the trimmed value", () => {
		expect(resolveApiKey("K", { K: "  abc  " })).toBe("abc");
	});

	test("absent, blank and whitespace-only are all undefined", () => {
		expect(resolveApiKey("K", {})).toBeUndefined();
		expect(resolveApiKey("K", { K: "" })).toBeUndefined();
		expect(resolveApiKey("K", { K: "   " })).toBeUndefined();
	});
});

describe("resolveGeminiKey", () => {
	// The name is only ever used as a lookup key here: no value is asserted on,
	// so this test cannot leak a real key from the developer's environment.
	test("reads the Gemini key from the injected environment", () => {
		expect(resolveGeminiKey({ GEMINI_API_KEY: "abc123" })).toBe("abc123");
	});

	test("is undefined when the key is not configured", () => {
		expect(resolveGeminiKey({})).toBeUndefined();
	});
});

describe("configuredKeys", () => {
	test("lists only the names that are set, never values", () => {
		const keys = configuredKeys({ GEMINI_API_KEY: "x", TAVILY_API_KEY: "" });
		expect(keys).toEqual(["GEMINI_API_KEY"]);
	});

	test("is empty when nothing is configured", () => {
		expect(configuredKeys({})).toEqual([]);
	});
});

describe("the shipped env file", () => {
	test("is the dotted name the project already uses", () => {
		expect(ENV_FILE).toBe(".env");
	});

	test("an absent file at the default path loads nothing and does not throw", () => {
		// In a checkout without the file this must still be a clean no-op.
		const result = loadEnvFile({}, join(dir, "definitely-missing"));
		expect(result.loaded).toEqual([]);
	});
});
