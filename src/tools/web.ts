// Web access tools: fetch a URL and turn it into markdown for the model, and
// search the web through Tavily. Both return error strings rather than throwing,
// matching the file tools, so the agent loop can hand the problem back to the model.
import TurndownService from "turndown";

/** Some sites reject requests that do not look like a browser. */
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

export const MAX_PAGE_CHARS = 40_000;
export const MAX_SEARCH_RESULTS = 5;
const FETCH_TIMEOUT_MS = 20_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function clip(text: string, max = MAX_PAGE_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n... (truncated at ${max} characters; the full page was ${text.length})`;
}

/**
 * Non-content elements must go before conversion: Turndown keeps the *contents*
 * of <script> and <style>, so leaving them in puts raw CSS and JS in the context
 * window. Verified: `alert(1)` and `body{color:red}` both survive conversion.
 */
const NOISE_ELEMENTS = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"iframe",
	"nav",
	"footer",
	"form",
];

/**
 * Strip noise elements and their contents. Regex, not a DOM: pages are hostile.
 *
 * Known limitation: only markup that declares itself as chrome (<nav>, <footer>,
 * <header>'s contents) is removed. Sites that wrap navigation in plain <div>s, or
 * use a skip-link anchor, still leak a few lines ("Skip to content", "Copy page").
 * Measured on real pages this is ~4 lines out of 150, so it is left to Turndown
 * rather than guessed at with brittle heuristics. Wasted tokens, never wrong content.
 */
export function stripNoise(html: string): string {
	const removed = NOISE_ELEMENTS.map(
		(tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
	);
	let out = html;
	for (const pattern of removed) out = out.replace(pattern, " ");
	// Self-closing and unclosed variants (e.g. `<script src=... />`).
	for (const tag of NOISE_ELEMENTS) {
		out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
	}
	// HTML comments are pure noise and often carry large licence blocks.
	return out.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Read <title> so the model knows what page it is looking at. */
export function extractTitle(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return "";
	return match[1].replace(/\s+/g, " ").trim();
}

/** Convert an HTML document to markdown. */
export function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	return turndown.turndown(stripNoise(html)).trim();
}

export function isValidUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** Download a URL and convert it to clean markdown. */
export async function downloadUrl(raw: string, fetchImpl: FetchLike = fetch): Promise<string> {
	const url = raw.trim();
	if (!isValidUrl(url)) {
		return `Error: not a valid http(s) URL: ${raw}`;
	}

	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "follow",
		});
	} catch (e: unknown) {
		return `Error: could not fetch ${url}: ${(e as Error).message}`;
	}

	if (!response.ok) {
		return `Error: failed to download ${url} (status ${response.status} ${response.statusText}).`;
	}

	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();

	// Plain text and JSON are already model-friendly; only HTML needs converting.
	if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
		const title = `# ${url} (${contentType.split(";")[0]})\n\n`;
		return clip(title + body.trim());
	}

	const markdown = htmlToMarkdown(body);
	if (markdown === "") {
		return `(${url} produced no readable text; the page is script-rendered or empty)`;
	}
	const title = extractTitle(body);
	const header = title ? `# ${title}\n\nSource: ${url}\n\n` : `Source: ${url}\n\n`;
	return clip(header + markdown);
}

export interface TavilyResult {
	title: string;
	url: string;
	content: string;
	score?: number;
}

export interface TavilyResponse {
	answer?: string;
	query?: string;
	results?: TavilyResult[];
}

/** Render a Tavily response as markdown the model can read and cite. */
export function formatTavilyResponse(data: TavilyResponse, query: string): string {
	const results = data.results ?? [];
	if (!data.answer && results.length === 0) {
		return `No search results for "${query}".`;
	}

	const parts: string[] = [`### Search results for "${data.query ?? query}"`, ""];

	if (data.answer) {
		parts.push("**Answer:**", data.answer, "");
	}

	if (results.length > 0) {
		parts.push("**Sources:**", "");
		for (const [i, result] of results.entries()) {
			parts.push(`${i + 1}. [${result.title}](${result.url})`);
			const snippet = (result.content ?? "").replace(/\s+/g, " ").trim();
			if (snippet) parts.push(`   > ${snippet}`);
			parts.push("");
		}
	}

	// Citations are only useful if the model can fetch them, so say so.
	parts.push("Use download_url on a source URL to read the full page.");
	return parts.join("\n").trim();
}

/**
 * Resolve the Tavily key at call time. `env` is injectable so the "no key" path
 * is testable: bun loads .env automatically, so a developer's real key would
 * otherwise leak into the test run.
 */
export function resolveTavilyKey(env: Record<string, string | undefined> = process.env) {
	const key = env.TAVILY_API_KEY?.trim();
	return key ? key : undefined;
}

/**
 * Search the web with Tavily.
 *
 * `apiKey` is an explicit override, not an env lookup in a default parameter:
 * an explicit `undefined` argument re-triggers a default, so a caller could
 * never ask for "no key". Pass "" to force the missing-key path (tests do).
 */
export async function tavilySearch(
	query: string,
	fetchImpl: FetchLike = fetch,
	apiKey?: string,
	maxResults = MAX_SEARCH_RESULTS,
): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed) return "Error: query must not be empty.";

	const key = apiKey ?? resolveTavilyKey();
	if (!key) {
		return "Error: TAVILY_API_KEY is not set. Add it to .env to enable web search.";
	}

	let response: Response;
	try {
		response = await fetchImpl("https://api.tavily.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({
				query: trimmed,
				search_depth: "advanced",
				include_answer: true,
				max_results: maxResults,
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (e: unknown) {
		return `Error: web search failed: ${(e as Error).message}`;
	}

	if (!response.ok) {
		// 401/403 is a key problem, not a query problem; say which.
		const hint =
			response.status === 401 || response.status === 403
				? " Check that TAVILY_API_KEY is valid."
				: "";
		return `Error: web search failed (status ${response.status}).${hint}`;
	}

	let data: TavilyResponse;
	try {
		data = (await response.json()) as TavilyResponse;
	} catch (e: unknown) {
		return `Error: web search returned invalid JSON: ${(e as Error).message}`;
	}

	return formatTavilyResponse(data, trimmed);
}
