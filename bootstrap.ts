#!/usr/bin/env bun

const API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const TOOL = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run bash command",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		},
	},
];

let msgs = [];
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
	if (line === "exit") break;
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
			const cmd = JSON.parse(tc.function.arguments).command;
			console.log(`$ ${cmd}`);
			const result = await Bun.$`sh -c ${cmd}`
				.text()
				.catch((e) => e.stderr || e.message);
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
