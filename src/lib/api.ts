import type { ApiCaller, CompletionResponse, Message, ToolSchema } from "./types";

export const API = "https://openrouter.ai/api/v1/chat/completions";
export const MODELS_API = "https://openrouter.ai/api/v1/models";
export const MODEL = process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";

export interface ModelStats {
	name: string;
	contextLength: number;
	/** Dollars per single token, taken from OpenRouter pricing fields. */
	cost: { prompt: number; completion: number };
}

let cachedStats: ModelStats | null = null;

/** Clear the cached stats. Intended for tests; the app fetches once per process. */
export function resetModelStatsCache(): void {
	cachedStats = null;
}

/** Look up name, context window, and per-token pricing for MODEL. Cached after the first call. */
export async function fetchModelStats(fetchImpl: typeof fetch = fetch): Promise<ModelStats | null> {
	if (cachedStats) return cachedStats;

	try {
		const response = await fetchImpl(MODELS_API);
		const data = (await response.json()) as {
			data: Array<{
				id: string;
				name: string;
				context_length?: number;
				pricing?: { prompt?: string; completion?: string };
			}>;
		};
		const modelInfo = data.data.find((m) => m.id === MODEL);
		if (modelInfo) {
			cachedStats = {
				name: modelInfo.name,
				contextLength: modelInfo.context_length ?? 0,
				cost: {
					prompt: parseFloat(modelInfo.pricing?.prompt ?? "") || 0,
					completion: parseFloat(modelInfo.pricing?.completion ?? "") || 0,
				},
			};
			return cachedStats;
		}
	} catch (e) {
		console.error(`[stats] could not fetch model stats: ${(e as Error).message}`);
	}
	return null;
}

/** Real OpenRouter client. Tests never call this - they inject a fake ApiCaller. */
export const callLLM: ApiCaller = async (
	messages: Message[],
	tools: ToolSchema[],
): Promise<CompletionResponse> => {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");

	const res = await fetch(API, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: MODEL, messages, tools }),
	});

	return (await res.json()) as CompletionResponse;
};
