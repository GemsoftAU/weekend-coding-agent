import { runTurn } from "./agent";
import { loadPrompt } from "./lib/prompts";
import type { Message } from "./lib/types";

async function main() {
	const template = loadPrompt("default");
	const agentName = template.frontmatter.name;

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
			undefined,
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

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
