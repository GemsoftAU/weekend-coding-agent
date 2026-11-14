import { join } from "node:path";
import { runTurn } from "./agent";
import { fetchModelStats, MODEL } from "./lib/api";
import { type CommandContext, parseCommand, runCommand } from "./lib/commands";
import { createSessionLogger, type SessionLog } from "./lib/logger";
import { loadPrompt } from "./lib/prompts";
import { createSession } from "./lib/session";
import { createSpinner } from "./lib/spinner";
import type { Message } from "./lib/types";
import { selectTools } from "./tools";

const LOG_DIR = join(process.cwd(), ".session_logs");

async function main() {
	const template = loadPrompt("default");
	const agentName = template.frontmatter.name;

	// Declared capability and actual capability must be the same list.
	const tools = selectTools(template.frontmatter.tools);
	const toolNames = tools.map((t) => t.function.name);

	// Model stats fetch is best-effort: the agent must still start offline.
	const stats = await fetchModelStats();
	const session = createSession(stats);

	// Logging is best-effort too: a read-only checkout must not stop the agent.
	let sessionLog: SessionLog | null = null;
	try {
		sessionLog = createSessionLogger(LOG_DIR, new Date(), agentName);
	} catch (e: unknown) {
		console.error(`[log] session logging disabled: ${(e as Error).message}`);
	}

	console.log("AI Coding Assistant (type 'exit' to quit, /help for commands)");
	console.log(`Prompt: ${agentName} | Tools: ${toolNames.join(", ")}`);
	if (stats) {
		console.log(`Model: ${stats.name}`);
		console.log(
			`Cost: $${(stats.cost.prompt * 1_000_000).toFixed(3)} per 1M input tokens, ` +
				`$${(stats.cost.completion * 1_000_000).toFixed(3)} per 1M output tokens`,
		);
		if (stats.contextLength > 0) {
			console.log(`Context window: ${(stats.contextLength / 1_000).toFixed(0)}K tokens`);
		}
	} else {
		console.log(`Model: ${MODEL} (stats not found)`);
	}
	if (sessionLog) console.log(`Logging to: ${sessionLog.logFile}`);
	console.log();

	const history: Message[] = [{ role: "system", content: template.body }];
	// The system prompt is part of the record: a log you cannot replay is not a log.
	sessionLog?.log(history[0]);

	// Only animates on a TTY; piped or redirected output gains no escape codes.
	const spinner = createSpinner();

	for await (const line of console) {
		const input = line.trim();
		if (input === "") continue;
		if (input === "exit") break;

		const command = parseCommand(input);
		if (command) {
			const context: CommandContext = {
				session,
				history,
				logDir: LOG_DIR,
				logFile: sessionLog?.logFile ?? null,
				sessionId: sessionLog?.sessionId ?? null,
				agentName,
				stats,
				tools: toolNames,
			};
			const result = runCommand(command, context);
			console.log(result.output);
			console.log();

			if (result.history) {
				history.length = 0;
				history.push(...result.history);
			}
			// /fork keeps the history but moves to a fresh session id, so the new
			// branch is distinguishable from the one it came from. The branch starts
			// with the system prompt logged, or its log cannot be replayed on its own.
			if (result.newSession && sessionLog) {
				sessionLog = sessionLog.child(agentName, result.forkedFrom);
				const systemPrompt = history.find((m) => m.role === "system");
				if (systemPrompt) sessionLog.log(systemPrompt);
			}
			if (result.exit) break;
			continue;
		}

		const userMessage: Message = { role: "user", content: input };
		history.push(userMessage);
		sessionLog?.log(userMessage);

		const result = await runTurn(
			history,
			undefined,
			undefined,
			tools,
			{ info: (m) => console.log(m), error: (m) => console.error(m) },
			agentName,
			session,
			sessionLog,
			// The spinner is created once and reused: it idles silently between turns.
			{ spinner },
		);

		history.length = 0;
		history.push(...result.messages);

		console.log(
			`[${agentName}] tokens in/out: ${result.usage.prompt_tokens}/${result.usage.completion_tokens}`,
		);
		console.log();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
