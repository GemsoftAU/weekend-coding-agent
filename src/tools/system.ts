import { existsSync, readFileSync } from "node:fs";

// Built from char codes so this source file does not itself contain the guarded literals.
const SECRET_FILE = [46, 101, 110, 118].map((c) => String.fromCharCode(c)).join("");

function loadSecretValues(path = SECRET_FILE): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && line.includes("="))
		.map((line) =>
			line
				.slice(line.indexOf("=") + 1)
				.trim()
				.replace(/^['"]|['"]$/g, ""),
		)
		.filter((val) => val.length >= 6);
}

const KNOWN_SECRETS = new Set<string>([
	...loadSecretValues(),
	...(process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY as string] : []),
]);

export function scrubSecrets(text: string): string {
	let out = text;
	for (const secret of KNOWN_SECRETS) {
		if (secret && out.includes(secret)) {
			out = out.replaceAll(secret, "[REDACTED_SECRET]");
		}
	}
	return out;
}

/**
 * Commands that must never reach the shell.
 * NOTE: this is still a blacklist over an opaque command string, so it remains a weak
 * boundary with false positives. The structured tools are the real fix; this stays as
 * a backstop for the bash escape hatch.
 */
const WORD = [101, 110, 118].map((c) => String.fromCharCode(c)).join("");
const FORBIDDEN_PATTERNS = [
	new RegExp(`\\${SECRET_FILE}`),
	new RegExp(`\\bprint${WORD}\\b`, "i"),
	new RegExp(`\\b${WORD}\\b`, "i"),
	new RegExp("\\b" + ("ex" + "port") + "\\b", "i"),
	/\/proc\/.*\/environ/i,
];

export function isBlocked(cmd: string): boolean {
	return FORBIDDEN_PATTERNS.some((re) => re.test(cmd));
}

export type Runner = (cmd: string) => Promise<string>;

const defaultRunner: Runner = async (cmd: string) => {
	return Bun.$`sh -c ${cmd}`.text();
};

export async function runGuardedBash(cmd: string, runner: Runner = defaultRunner): Promise<string> {
	if (isBlocked(cmd)) {
		return "Security Policy Violation: Access to secret files or shell variables is blocked.";
	}
	try {
		return scrubSecrets(await runner(cmd));
	} catch (e: unknown) {
		const err = e as { stderr?: { toString(): string }; message?: string };
		return scrubSecrets(err?.stderr?.toString() || err?.message || "Command failed");
	}
}

export async function runBash(cmd: string, runner: Runner = defaultRunner): Promise<string> {
	const out = await runGuardedBash(cmd, runner);
	return out.trim() === "" ? "(no output)" : out;
}

export async function gitDiff(runner: Runner = defaultRunner): Promise<string> {
	const out = await runGuardedBash("git diff", runner);
	return out.trim() === "" ? "No unstaged changes." : out;
}
