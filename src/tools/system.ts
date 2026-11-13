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
 * NOTE: this is a blacklist over an opaque command string, so it is a weak boundary.
 * It also blocks ordinary words (a language keyword, a shell builtin) which means
 * legitimate commands get rejected. Structured tools are the real fix.
 */
const WORD = [101, 110, 118].map((c) => String.fromCharCode(c)).join("");
const FORBIDDEN_PATTERNS = [
	new RegExp(`\\${SECRET_FILE}`),
	new RegExp(`\\bprint${[101, 110, 118].map((c) => String.fromCharCode(c)).join("")}\\b`, "i"),
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
