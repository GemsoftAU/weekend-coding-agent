import { describe, expect, test } from "bun:test";
import { fetchModelStats, MODEL, MODELS_API, resetModelStatsCache } from "../src/lib/api";

const TEST_MODEL_NAME = "Fake: Test Model";

/** Fake OpenRouter /models response, shaped like the real thing. */
function fakeModelsBody() {
	return {
		data: [
			{
				id: "other/model",
				name: "Other Model",
				context_length: 200000,
				pricing: { prompt: "0.01", completion: "0.03" },
			},
			{
				id: MODEL,
				name: TEST_MODEL_NAME,
				context_length: 1048576,
				pricing: { prompt: "0.000000038", completion: "0.0000005" },
			},
		],
	};
}

function fakeFetch(body: unknown = fakeModelsBody()) {
	let calls = 0;
	const impl = async (url: string) => {
		calls++;
		expect(url).toBe(MODELS_API);
		return new Response(JSON.stringify(body), { status: 200 });
	};
	return { impl, calls: () => calls };
}

describe("fetchModelStats", () => {
	test("finds the configured model and parses per-token pricing", async () => {
		resetModelStatsCache();
		const fetcher = fakeFetch();
		const stats = await fetchModelStats(fetcher.impl);

		expect(stats?.name).toBe(TEST_MODEL_NAME);
		expect(stats?.contextLength).toBe(1048576);
		expect(stats?.cost.prompt).toBeCloseTo(0.000000038);
		expect(stats?.cost.completion).toBeCloseTo(0.0000005);
		expect(fetcher.calls()).toBe(1);
	});

	test("does not fetch a second time once cached", async () => {
		resetModelStatsCache();
		const fetcher = fakeFetch();
		await fetchModelStats(fetcher.impl);
		const second = await fetchModelStats(fetcher.impl);

		expect(second?.name).toBe(TEST_MODEL_NAME);
		expect(fetcher.calls()).toBe(1);
	});

	test("returns null when the model is missing from the list", async () => {
		resetModelStatsCache();
		const fetcher = fakeFetch({ data: [{ id: "other/model" }] });
		expect(await fetchModelStats(fetcher.impl)).toBeNull();
	});

	test("returns null and does not throw when the fetch fails", async () => {
		resetModelStatsCache();
		const impl = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		expect(await fetchModelStats(impl)).toBeNull();
	});
});
