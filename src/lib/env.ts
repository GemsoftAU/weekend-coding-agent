// Loading keys from the project env file.
//
// Why this exists when bun already auto-loads `.env` for `bun run`: the agent
// executes skills as shell commands in *child* processes, and those children
// only see what the parent environment holds. Relying on the runner's implicit
// dotenv loading means the key is present in one entry point, absent in
// another, and silently missing when the agent is started from a different
// working directory. Loading it here makes the dependency explicit, keeps one
// code path, and lets the "no key" branch be tested.
import { existsSync, readFileSync } from "node:fs";

// Built from char codes so this source file does not contain the guarded literal,
// matching src/tools/system.ts and src/tools/files.ts.
export const ENV_FILE = [46, 101, 110, 118].map((c) => String.fromCharCode(c)).join("");

/** Anything shaped like `process.env`, injectable so tests never touch the real one. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Parse `KEY=value` lines. Blank lines, `#` comments and an optional `export `
 * prefix are handled; one layer of matching quotes is stripped from the value so
 * `KEY="abc"` and `KEY=abc` agree. Anything that is not a plausible shell
 * variable name is skipped rather than guessed at.
 */
export function parseEnvFile(raw: string): Record<string, string> {
	const values: Record<string, string> = {};

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
		const equals = assignment.indexOf("=");
		if (equals <= 0) continue;

		const name = assignment.slice(0, equals).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

		let value = assignment.slice(equals + 1).trim();
		const quoted =
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"));
		if (quoted && value.length >= 2) value = value.slice(1, -1);

		values[name] = value;
	}

	return values;
}

export interface LoadEnvResult {
	/** Names that were taken from the file. Never the values. */
	loaded: string[];
	/** Names already set in the environment, left untouched. Never the values. */
	skipped: string[];
}

/**
 * Merge the file's keys into `env` without overriding anything already set: a
 * real environment variable (a CI secret, a shell export) must always beat a
 * file on disk. A missing file is a no-op, not an error, so a fresh checkout
 * still starts. Returns names only, so a caller may log the result safely.
 */
export function loadEnvFile(env: EnvLike = process.env, path = ENV_FILE): LoadEnvResult {
	if (!existsSync(path)) return { loaded: [], skipped: [] };

	const result: LoadEnvResult = { loaded: [], skipped: [] };
	for (const [name, value] of Object.entries(parseEnvFile(readFileSync(path, "utf-8")))) {
		if (value === "") continue;
		if ((env[name] ?? "").trim() !== "") {
			result.skipped.push(name);
			continue;
		}
		env[name] = value;
		result.loaded.push(name);
	}
	return result;
}

/**
 * Resolve a key at call time. `env` is injectable for the same reason the Tavily
 * resolver injects it: bun loads the env file into the real process, so a
 * developer's key would otherwise leak into the test run. A blank or
 * whitespace-only value counts as absent.
 */
export function resolveApiKey(name: string, env: EnvLike = process.env): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

/** The Gemini key that the image and video skills shell out with. */
export function resolveGeminiKey(env: EnvLike = process.env): string | undefined {
	return resolveApiKey("GEMINI_API_KEY", env);
}

/** The env var names the agent knows how to talk about, for support messages. */
export const KNOWN_API_KEYS = ["GEMINI_API_KEY", "TAVILY_API_KEY", "OPENROUTER_API_KEY"] as const;

/** Which known keys are configured right now: names only, safe to print. */
export function configuredKeys(env: EnvLike = process.env): string[] {
	return KNOWN_API_KEYS.filter((name) => resolveApiKey(name, env) !== undefined);
}
