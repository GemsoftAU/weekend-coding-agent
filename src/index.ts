import { runTurn } from "./agent";
import { fetchModelStats, MODEL } from "./lib/api";
import { loadPrompt } from "./lib/prompts";
import { createSession } from "./lib/session";
import type { Message } from "./lib/types";
import { selectTools } from "./tools";

async function main() {
	const template = loadPrompt("default");
	const agentName = template.frontmatter.name;

	// Declared capability and actual capability must be the same list.
	const tools = selectTools(template.frontmatter.tools);

	// Model stats fetch is best-effort: the agent must still start offline.
	const stats = await fetchModelStats();
	const session = createSession(stats);

	console.log("AI Coding Assistant (type 'exit' to quit)");
	console.log(`Prompt: ${agentName} | Tools: ${template.frontmatter.tools.join(", ")}`);
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
	console.log();

	const history: Message[] = [{ role: "system", content: template.body }];

	for await (const line of console) {
		const input = line.trim();
		if (input === "") continue;
		if (input === "exit") break;

		history.push({ role: "user", content: input });

		const result = await runTurn(
			history,
			undefined,
			undefined,
			tools,
			{ info: (m) => console.log(m), error: (m) => console.error(m) },
			agentName,
			session,
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
