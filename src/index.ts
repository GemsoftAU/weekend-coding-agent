import { runTurn } from "./agent";
import { loadPrompt } from "./lib/prompts";
import type { Message } from "./lib/types";
import { selectTools } from "./tools";

async function main() {
	const template = loadPrompt("default");
	const agentName = template.frontmatter.name;

	// Declared capability and actual capability must be the same list.
	const tools = selectTools(template.frontmatter.tools);

	console.log("AI Coding Assistant (type 'exit' to quit)");
	console.log(`Prompt: ${agentName} | Tools: ${template.frontmatter.tools.join(", ")}`);
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
