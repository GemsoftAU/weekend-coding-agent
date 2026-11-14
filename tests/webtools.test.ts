import { describe, expect, test } from "bun:test";
import { executeTool } from "../src/tools";
import {
	downloadUrl,
	extractTitle,
	formatTavilyResponse,
	htmlToMarkdown,
	isValidUrl,
	resolveTavilyKey,
	stripNoise,
	tavilySearch,
} from "../src/tools/web";

/** A fake fetch that returns one canned Response and records the request. */
function fakeFetch(body: string, init: ResponseInit & { contentType?: string } = {}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl = async (url: string, requestInit?: RequestInit) => {
		calls.push({ url, init: requestInit });
		const headers = new Headers(init.headers);
		if (init.contentType) headers.set("content-type", init.contentType);
		return new Response(body, { status: init.status ?? 200, statusText: init.statusText, headers });
	};
	return { impl, calls };
}

const HTML_PAGE = `<!doctype html>
<html><head><title>Test  Page</title>
<style>body { color: red; }</style>
<script>alert("boom")</script>
</head><body>
<nav><a href="/">Home</a></nav>
<h1>Heading</h1>
<p>Hello <strong>world</strong>.</p>
<ul><li>one</li><li>two</li></ul>
<footer>Copyright notice</footer>
<!-- a long licence comment -->
</body></html>`;

describe("isValidUrl", () => {
	test("accepts http and https", () => {
		expect(isValidUrl("https://example.com")).toBe(true);
		expect(isValidUrl("http://example.com/a?b=1")).toBe(true);
	});

	test("rejects other schemes and non-URLs", () => {
		expect(isValidUrl("file:///etc/passwd")).toBe(false);
		expect(isValidUrl("javascript:alert(1)")).toBe(false);
		expect(isValidUrl("not a url")).toBe(false);
		expect(isValidUrl("")).toBe(false);
	});
});

describe("stripNoise", () => {
	test("removes script and style elements with their contents", () => {
		const out = stripNoise(HTML_PAGE);
		expect(out).not.toContain("alert");
		expect(out).not.toContain("color: red");
	});

	test("removes nav and footer chrome, which is not page content", () => {
		const out = stripNoise(HTML_PAGE);
		expect(out).not.toContain("Home");
		expect(out).not.toContain("Copyright");
	});

	test("removes HTML comments", () => {
		expect(stripNoise(HTML_PAGE)).not.toContain("licence comment");
	});

	test("keeps the actual content", () => {
		const out = stripNoise(HTML_PAGE);
		expect(out).toContain("Heading");
		expect(out).toContain("Hello");
	});

	test("handles an unclosed script tag without eating the rest of the page", () => {
		// A truncated page must not swallow the content that follows.
		const out = stripNoise(`<p>before</p><script src="x.js" />`);
		expect(out).toContain("before");
	});
});

describe("extractTitle", () => {
	test("pulls and collapses the title", () => {
		expect(extractTitle(HTML_PAGE)).toBe("Test Page");
	});

	test("is empty when there is no title", () => {
		expect(extractTitle("<p>hi</p>")).toBe("");
	});
});

describe("htmlToMarkdown", () => {
	test("converts structure to markdown", () => {
		const md = htmlToMarkdown(HTML_PAGE);
		expect(md).toContain("Heading");
		expect(md).toContain("**world**");
		expect(md).toContain("-   one");
	});

	test("does not leak script or style contents into the markdown", () => {
		const md = htmlToMarkdown(HTML_PAGE);
		expect(md).not.toContain("alert");
		expect(md).not.toContain("color: red");
	});

	test("markdown is smaller than the raw HTML, which is the whole point", () => {
		expect(htmlToMarkdown(HTML_PAGE).length).toBeLessThan(HTML_PAGE.length);
	});

	test("fenced code blocks are preserved", () => {
		const md = htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
		expect(md).toContain("```");
		expect(md).toContain("const x = 1;");
	});
});

describe("downloadUrl", () => {
	test("returns title, source and markdown body for an HTML page", async () => {
		const fetcher = fakeFetch(HTML_PAGE, { contentType: "text/html; charset=utf-8" });
		const out = await downloadUrl("https://example.com/page", fetcher.impl);

		expect(out).toContain("# Test Page");
		expect(out).toContain("Source: https://example.com/page");
		expect(out).toContain("Hello **world**");
	});

	test("sends a browser user agent, since many sites reject the default", async () => {
		const fetcher = fakeFetch(HTML_PAGE, { contentType: "text/html" });
		await downloadUrl("https://example.com", fetcher.impl);

		const headers = (fetcher.calls[0].init?.headers ?? {}) as Record<string, string>;
		expect(headers["User-Agent"]).toContain("Mozilla/5.0");
	});

	test("passes the URL through untouched and follows redirects", async () => {
		const fetcher = fakeFetch(HTML_PAGE, { contentType: "text/html" });
		await downloadUrl("https://example.com/a/b?c=d", fetcher.impl);

		expect(fetcher.calls[0].url).toBe("https://example.com/a/b?c=d");
		expect(fetcher.calls[0].init?.redirect).toBe("follow");
	});

	test("plain text and JSON skip HTML conversion", async () => {
		const fetcher = fakeFetch('{"ok":true}', { contentType: "application/json" });
		const out = await downloadUrl("https://api.example.com/x", fetcher.impl);

		expect(out).toContain('{"ok":true}');
		expect(out).toContain("application/json");
	});

	test("rejects a non-http(s) URL before any request is made", async () => {
		const fetcher = fakeFetch(HTML_PAGE);
		const out = await downloadUrl("file:///etc/passwd", fetcher.impl);

		expect(out).toContain("Error: not a valid");
		expect(fetcher.calls).toHaveLength(0);
	});

	test("reports a non-ok status without throwing", async () => {
		const fetcher = fakeFetch("nope", { status: 404, statusText: "Not Found" });
		const out = await downloadUrl("https://example.com/missing", fetcher.impl);

		expect(out).toContain("status 404");
	});

	test("reports a network failure without throwing", async () => {
		const impl = async () => {
			throw new Error("dns failure");
		};
		const out = await downloadUrl("https://nope.invalid", impl);
		expect(out).toContain("could not fetch");
		expect(out).toContain("dns failure");
	});

	test("says so when a page yields no readable text", async () => {
		const fetcher = fakeFetch("<script>app()</script>", { contentType: "text/html" });
		expect(await downloadUrl("https://spa.example.com", fetcher.impl)).toContain(
			"no readable text",
		);
	});

	test("truncates an enormous page instead of flooding the context window", async () => {
		const huge = `<p>${"x".repeat(60_000)}</p>`;
		const fetcher = fakeFetch(huge, { contentType: "text/html" });
		const out = await downloadUrl("https://example.com/huge", fetcher.impl);

		expect(out).toContain("truncated");
		expect(out.length).toBeLessThan(45_000);
	});
});

describe("formatTavilyResponse", () => {
	test("renders the answer and numbered sources with URLs", () => {
		const out = formatTavilyResponse(
			{
				answer: "Use advanced depth.",
				results: [
					{ title: "Docs", url: "https://docs.example.com", content: "The advanced depth..." },
					{ title: "Blog", url: "https://blog.example.com", content: "Tips" },
				],
			},
			"tavily best practices",
		);

		expect(out).toContain('Search results for "tavily best practices"');
		expect(out).toContain("**Answer:**");
		expect(out).toContain("Use advanced depth.");
		expect(out).toContain("1. [Docs](https://docs.example.com)");
		expect(out).toContain("2. [Blog](https://blog.example.com)");
		expect(out).toContain("> The advanced depth...");
	});

	test("tells the model how to read a source in full", () => {
		const out = formatTavilyResponse({ results: [{ title: "a", url: "b", content: "c" }] }, "q");
		expect(out).toContain("download_url");
	});

	test("an empty result set says so instead of returning nothing", () => {
		expect(formatTavilyResponse({ results: [] }, "obscure")).toContain("No search results");
	});

	test("the header uses the query the API echoes back", () => {
		const out = formatTavilyResponse(
			{ query: "echoed", results: [{ title: "a", url: "b", content: "c" }] },
			"sent",
		);
		expect(out).toContain('Search results for "echoed"');
	});

	test("with no answer and no results it reports the query it was given", () => {
		// The API may return neither; the message must still name what was asked.
		const out = formatTavilyResponse({}, "sent");
		expect(out).toContain('No search results for "sent"');
	});
});

describe("resolveTavilyKey", () => {
	test("reads TAVILY_API_KEY", () => {
		expect(resolveTavilyKey({ TAVILY_API_KEY: "tvly-abc" })).toBe("tvly-abc");
	});

	test("trims surrounding whitespace", () => {
		expect(resolveTavilyKey({ TAVILY_API_KEY: "  tvly-abc  " })).toBe("tvly-abc");
	});

	test("absent, blank or whitespace-only counts as no key", () => {
		expect(resolveTavilyKey({})).toBeUndefined();
		expect(resolveTavilyKey({ TAVILY_API_KEY: "" })).toBeUndefined();
		expect(resolveTavilyKey({ TAVILY_API_KEY: "   " })).toBeUndefined();
	});
});

describe("tavilySearch", () => {
	const okBody = JSON.stringify({
		answer: "Because.",
		results: [{ title: "T", url: "https://u.example.com", content: "snippet" }],
	});

	test("posts the query to the Tavily endpoint with the key as a bearer token", async () => {
		const fetcher = fakeFetch(okBody);
		await tavilySearch("what is bun", fetcher.impl, "tvly-test");

		const [call] = fetcher.calls;
		expect(call.url).toBe("https://api.tavily.com/search");
		expect(call.init?.method).toBe("POST");
		const headers = (call.init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tvly-test");
	});

	test("asks for advanced depth and an answer", async () => {
		const fetcher = fakeFetch(okBody);
		await tavilySearch("q", fetcher.impl, "tvly-test");

		const body = JSON.parse(fetcher.calls[0].init?.body as string);
		expect(body).toEqual({
			query: "q",
			search_depth: "advanced",
			include_answer: true,
			max_results: 5,
		});
	});

	test("formats a successful response", async () => {
		const fetcher = fakeFetch(okBody);
		const out = await tavilySearch("q", fetcher.impl, "tvly-test");
		expect(out).toContain("**Answer:**");
		expect(out).toContain("[T](https://u.example.com)");
	});

	test("without an API key it explains how to enable search, without calling out", async () => {
		const fetcher = fakeFetch(okBody);
		// "" forces the missing-key path even when the developer has a real key in .env.
		const out = await tavilySearch("q", fetcher.impl, "");

		expect(out).toContain("TAVILY_API_KEY is not set");
		expect(fetcher.calls).toHaveLength(0);
	});

	test("a blank query is rejected before calling out", async () => {
		const fetcher = fakeFetch(okBody);
		expect(await tavilySearch("   ", fetcher.impl, "tvly-test")).toContain("must not be empty");
		expect(fetcher.calls).toHaveLength(0);
	});

	test("an auth failure points at the key", async () => {
		const fetcher = fakeFetch("unauthorized", { status: 401 });
		const out = await tavilySearch("q", fetcher.impl, "bad-key");
		expect(out).toContain("status 401");
		expect(out).toContain("TAVILY_API_KEY is valid");
	});

	test("a server error is reported without a misleading key hint", async () => {
		const fetcher = fakeFetch("boom", { status: 500 });
		const out = await tavilySearch("q", fetcher.impl, "tvly-test");
		expect(out).toContain("status 500");
		expect(out).not.toContain("TAVILY_API_KEY is valid");
	});

	test("a network failure is reported without throwing", async () => {
		const impl = async () => {
			throw new Error("offline");
		};
		expect(await tavilySearch("q", impl, "tvly-test")).toContain("offline");
	});

	test("invalid JSON is reported without throwing", async () => {
		const fetcher = fakeFetch("<html>not json</html>");
		expect(await tavilySearch("q", fetcher.impl, "tvly-test")).toContain("invalid JSON");
	});
});

describe("web tools through the registry", () => {
	test("download_url reaches the web tool", async () => {
		// A malformed URL exercises argument plumbing without any network call.
		expect(await executeTool("download_url", { url: "not-a-url" })).toContain("not a valid");
	});

	test("download_url requires its url argument", async () => {
		expect(await executeTool("download_url", {})).toContain("Tool error");
	});

	test("tavily_search requires its query argument", async () => {
		expect(await executeTool("tavily_search", {})).toContain("Tool error");
	});

	test("a model cannot reach a web tool its prompt does not declare", async () => {
		const { selectTools } = await import("../src/tools");
		const names = selectTools(["read_file"]).map((t) => t.function.name);
		expect(names).toEqual(["read_file"]);
	});
});
