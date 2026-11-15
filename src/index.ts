import { join } from "node:path";
import { runTurn } from "./agent";
import { fetchModelStats, MODEL } from "./lib/api";
import { type CommandContext, parseCommand, runCommand } from "./lib/commands";
import { configuredKeys, ENV_FILE, loadEnvFile } from "./lib/env";
import { createAskUser, createInput, isExitLine, setSharedInput } from "./lib/input";
import { createSessionLogger, recentSessions, type SessionLog } from "./lib/logger";
import { listPrompts, loadPrompt } from "./lib/prompts";
import { createSession } from "./lib/session";
import { buildSystemPrompt, loadSkills, resolveSkillsDir, skillsPathPrefix } from "./lib/skills";
import { createSpinner } from "./lib/spinner";
import type { Message } from "./lib/types";
import { formatAgentPrompt, formatSplash, formatTurnStatus } from "./lib/ui";
import { toolsForPrompt } from "./tools";

const LOG_DIR = join(process.cwd(), ".session_logs");
const PROMPT_DIR = join(import.meta.dir, "prompts");

async function main() {
	// Load the project env file before anything reads a key. `api.ts` resolves
	// MODEL at import time and the skills shell out to child processes, so this
	// has to happen at the top of main rather than lazily at the call site.
	// Only the key *names* are ever printed, never a value.
	const envResult = loadEnvFile();
	if (envResult.loaded.length > 0) {
		console.log(`[env] loaded ${envResult.loaded.join(", ")} from ${ENV_FILE}`);
	}

	const template = loadPrompt("default", PROMPT_DIR);
	const agentName = template.frontmatter.name;

	// Declared capability and actual capability must be the same list. A prompt
	// that declares subagents also gets `run_agent`, with those names in its enum.
	const tools = toolsForPrompt(template.frontmatter.tools, template.frontmatter.subagents);
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

	// Skills are discovered, never listed: a new skills/<name>/SKILL.md appears on
	// the next start. Only their name, description and path enter the prompt; the
	// body costs nothing until the model asks for it with use_skill.
	const skillsDir = resolveSkillsDir();
	const skills = loadSkills(skillsDir, { pathPrefix: skillsPathPrefix(skillsDir) });

	// The system prompt is part of the record: a log you cannot replay is not a log.
	// It is composed from disk (agent body + agent roster + skills) rather than
	// stored whole in default.md, so adding a skill or an agent needs no code change.
	const history: Message[] = [
		{
			role: "system",
			content: buildSystemPrompt({ body: template.body, agents: listPrompts(PROMPT_DIR), skills }),
		},
	];
	sessionLog?.log(history[0]);

	// The recent-session list is decoration, not state: a broken log dir must
	// not stop startup, so failures degrade to an empty list. It is read after
	// the system prompt is logged so this session appears in the list, marked.
	let recent: ReturnType<typeof recentSessions> = [];
	try {
		recent = recentSessions(LOG_DIR, 5);
	} catch {
		recent = [];
	}

	console.log(
		formatSplash({
			model: MODEL,
			stats,
			promptName: agentName,
			promptDescription: template.frontmatter.description,
			tools: toolNames,
			subagents: template.frontmatter.subagents,
			skills: skills.map((s) => s.frontmatter.name),
			apiKeys: configuredKeys(),
			logFile: sessionLog?.logFile ?? null,
			recent,
			sessionId: sessionLog?.sessionId ?? null,
		}),
	);
	console.log();

	// Only animates on a TTY; piped or redirected output gains no escape codes.
	const spinner = createSpinner();

	// Label the first prompt too, so it is always clear which agent is listening.
	const prompt = () => process.stdout.write(formatAgentPrompt(agentName));
	prompt();

	// readline, not `console`: line editing, history and paste handling, and it
	// still reads piped input so scripted runs behave the same way.
	const rl = createInput();
	// Subagents ask their questions on this same interface: a second one would
	// fight it for stdin and end the REPL when the subagent finished.
	setSharedInput(rl);
	const askUser = createAskUser(rl);

	for await (const raw of rl) {
		const input = raw.trim();
		if (input === "") {
			prompt();
			continue;
		}
		if (isExitLine(input)) break;

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
				subagents: template.frontmatter.subagents,
				skills: skills.map((s) => s.frontmatter.name),
				promptDir: PROMPT_DIR,
				skillsDir,
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
			prompt();
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
			{
				// The spinner is created once and reused: it idles silently between turns.
				spinner,
				promptDir: PROMPT_DIR,
				askUser,
				skills,
			},
		);

		history.length = 0;
		history.push(...result.messages);

		console.log(
			formatTurnStatus({
				agentName,
				model: MODEL,
				stats,
				usage: result.usage,
				session,
				messages: history.filter((m) => m.role !== "system").length,
			}),
		);
		console.log();
		prompt();
	}

	// The prompt was written without a newline; end the line before exiting.
	process.stdout.write("\n");
	setSharedInput(null);
	rl.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
