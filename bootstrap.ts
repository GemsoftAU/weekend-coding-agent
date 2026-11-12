#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

const API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "deepseek/deepseek-v4.1-flash-1017";

// 1. Load secrets from .env in memory so we can scrub them from stdout/stderr if leaked
function loadSecretValues(envPath = ".env"): string[] {
	if (!existsSync(envPath)) return [];
	return readFileSync(envPath, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && line.includes("="))
		.map((line) =>
			line
				.slice(line.indexOf("=") + 1)
				.trim()
				.replace(/^['"]|['"]$/g, ""),
		)
		.filter((val) => val.length >= 6); // Ignore trivial short values like "true" or "3000"
}

const KNOWN_SECRETS = new Set<string>([
	...loadSecretValues(),
	...(process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY] : []),
]);

function scrubSecrets(text: string): string {
	let sanitized = text;
	for (const secret of KNOWN_SECRETS) {
		if (secret && sanitized.includes(secret)) {
			sanitized = sanitized.replaceAll(secret, "[REDACTED_SECRET]");
		}
	}
	return sanitized;
}

// 2. Schema-level guardrail (soft constraint for the model)
const TOOL = [
	{
		type: "function",
		function: {
			name: "bash",
			description:
				"Run a bash command. SECURITY CONSTRAINT: Never read, print, search, or expose .env files or environment variables.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description:
							"The bash command to execute. Must not reference .env files or dump environment variables.",
						pattern:
							"^(?!.*(\\.env\\b|\\bprintenv\\b|\\benv\\b|\\bexport\\b)).*$",
					},
				},
				required: ["command"],
			},
		},
	},
];

const systemPrompt = `You are a helpful AI assistant with access to a bash tool.
When you need to run a command, use the bash tool.
Be concise and helpful.
Never expose any secrets contained in a .env file.
Never output the contents of a .env file to stdout.`;

// 3. Runtime execution guardrail (hard enforcement)
const FORBIDDEN_PATTERNS = [
	/\.env/i,
	/\bprintenv\b/i,
	/\benv\b/i,
	/\bexport\b/i,
	/\/proc\/.*\/environ/i,
];

async function runGuardedBash(cmd: string): Promise<string> {
	if (FORBIDDEN_PATTERNS.some((regex) => regex.test(cmd))) {
		return "Security Policy Violation: Access to .env files or environment variables is blocked.";
	}

	try {
		// Strip inherited secrets from child process environment; keep only safe defaults
		const rawOutput = await Bun.$`sh -c ${cmd}`
			.env({
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				HOME: process.env.HOME ?? "/tmp",
				TERM: process.env.TERM ?? "xterm-256color",
			})
			.text();

		return scrubSecrets(rawOutput);
	} catch (e: any) {
		const errOutput = e?.stderr?.toString() || e?.message || "Command failed";
		return scrubSecrets(errOutput);
	}
}

let msgs: Array<Record<string, any>> = [
	{ role: "system", content: systemPrompt },
];

const call = async () =>
	(
		await fetch(API, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: MODEL, messages: msgs, tools: TOOL }),
		})
	).json();

for await (const line of console) {
	if (line.trim() === "exit") break;
	msgs.push({ role: "user", content: line });

	while (true) {
		const r = await call();
		if (r.error) {
			console.error("Error:", r.error.message);
			break;
		}
		const m = r.choices[0].message;
		if (m.tool_calls) {
			const tc = m.tool_calls[0];
			let cmd = "";
			try {
				cmd = JSON.parse(tc.function.arguments).command ?? "";
			} catch {
				msgs.push({ role: "assistant", tool_calls: [tc] });
				msgs.push({
					role: "tool",
					tool_call_id: tc.id,
					content: "Error: Invalid JSON arguments.",
				});
				continue;
			}

			console.log(`$ ${cmd}`);
			const result = await runGuardedBash(cmd);
			console.log(result);

			msgs.push({ role: "assistant", tool_calls: [tc] });
			msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
		} else {
			console.log(m.content);
			msgs.push({ role: "assistant", content: m.content });
			break;
		}
	}
}
