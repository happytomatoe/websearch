import { afterEach, test, expect } from "bun:test";
import { main } from "../src/cli.ts";
import { renderCli, type CliOptions } from "../src/render.ts";
import { searchWithTavily } from "../src/tavily.ts";

const realFetch = globalThis.fetch;
const realStdoutWrite = process.stdout.write;

interface StdoutCapture {
	read: () => string;
}

function captureStdout(): StdoutCapture {
	let buf = "";
	// SAFETY: test doubles the stream; the mock keeps write's (chunk: string) => boolean call shape
	process.stdout.write = ((chunk: string) => {
		buf += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	return { read: () => buf };
}

afterEach(() => {
	globalThis.fetch = realFetch;
	process.stdout.write = realStdoutWrite;
});

const baseOptions = (over: Partial<CliOptions> = {}): CliOptions => ({
	numResults: 5,
	domains: [],
	includeContent: false,
	json: false,
	...over,
});

const entry = (results: { title: string; url: string; snippet: string }[], error: string | null = null) =>
	results.length
		? { response: { answer: "answer", results }, error: null }
		: { response: null, error };

test("exits 2 on missing query", async () => {
	expect(await main([])).toBe(2);
});

test("exits 2 when --query has no value", async () => {
	expect(await main(["--query"])).toBe(2);
	expect(await main(["hello", "-q"])).toBe(2);
});

test("exits 2 on unknown option", async () => {
	expect(await main(["--nope", "hello"])).toBe(2);
});

test("--provider flag is no longer accepted", async () => {
	expect(await main(["--provider", "exa", "hello"])).toBe(2);
});

test("renderCli emits per-provider JSON with response/error entries", () => {
	const res = {
		exa: entry([{ title: "A", url: "https://a.com", snippet: "s" }]),
		parallel: { response: null, error: "boom" },
		tavily: { response: null, error: null },
		firecrawl: entry([{ title: "F", url: "https://f.com", snippet: "fs" }]),
	};
	const out = JSON.parse(renderCli([{ query: "q", providers: res }], baseOptions({ json: true })));
	expect(out.exa.response.results[0]).toEqual({ title: "A", url: "https://a.com", snippet: "s" });
	expect(out.parallel.response).toBeNull();
	expect(out.parallel.error).toBe("boom");
	expect(out.firecrawl.response.results[0]).toEqual({ title: "F", url: "https://f.com", snippet: "fs" });
});

test("renderCli emits ## provider sections, merged sources, and errors", () => {
	const res = {
		exa: entry([{ title: "Shared", url: "https://same.com", snippet: "" }]),
		// Results plus error together is impossible per ProviderEntry's contract;
		// model a real erroring provider with an empty-response entry.
		parallel: { response: null, error: "boom" },
		tavily: entry([{ title: "Shared", url: "https://same.com", snippet: "" }]),
		firecrawl: { response: null, error: "firecrawl boom" },
	};
	const out = renderCli([{ query: "q", providers: res }], baseOptions());
	expect(out).toContain("## Exa\n\nanswer");
	expect(out).toContain("## Provider errors\n\n- **Parallel:** boom");
	expect(out).toContain("- **Firecrawl:** firecrawl boom");
	const sources = out.slice(out.indexOf("**Sources:**"));
	expect(sources).toContain("1. Shared");
	expect(sources).not.toContain("2.");
});

test("renderCli strips control characters from result URLs in Sources", () => {
	const res = {
		exa: entry([{ title: "Esc", url: "https://a.com/\u001b[31mred\u001b[0m", snippet: "" }]),
		parallel: { response: null, error: null },
		tavily: { response: null, error: null },
		firecrawl: { response: null, error: null },
	};
	const out = renderCli([{ query: "q", providers: res }], baseOptions());
	const sources = out.slice(out.indexOf("**Sources:**"));
	const urlLine = sources.split("\n").find(line => line.includes("https://a.com/"));
	// eslint-disable-next-line no-control-regex -- asserting the sanitizer strips ESC
	expect(urlLine).not.toMatch(/[\u0000-\u001f\u007f]/);
});

test("renderCli separates provider sections with two blank lines", () => {
	const res = {
		exa: entry([{ title: "A", url: "https://a.com", snippet: "" }]),
		parallel: entry([{ title: "P", url: "https://p.com", snippet: "" }]),
		tavily: entry([{ title: "T", url: "https://t.com", snippet: "" }]),
		firecrawl: entry([{ title: "F", url: "https://f.com", snippet: "" }]),
	};
	const out = renderCli([{ query: "q", providers: res }], baseOptions());
	expect(out).toContain("answer\n\n\n## Parallel");
	expect(out).toContain("## Parallel\n\nanswer\n\n\n## Tavily");
	expect(out).toContain("## Tavily\n\nanswer\n\n\n## Firecrawl");
	expect(out).toContain("## Firecrawl\n\nanswer\n\n\n---\n\n**Sources:**");
});

test("renderCli groups multiple queries under ## Query headers with one merged source list", () => {
	const q1 = {
		exa: entry([{ title: "Shared", url: "https://same.com", snippet: "" }]),
		parallel: { response: null, error: "boom" },
		tavily: { response: null, error: null },
		firecrawl: { response: null, error: null },
	};
	const q2 = {
		exa: entry([{ title: "Shared", url: "https://same.com", snippet: "" }, { title: "Other", url: "https://other.com", snippet: "" }]),
		parallel: entry([{ title: "P2", url: "https://p2.com", snippet: "" }]),
		tavily: { response: null, error: "tavily down" },
		firecrawl: entry([{ title: "F2", url: "https://f2.com", snippet: "" }]),
	};
	const out = renderCli(
		[{ query: "first", providers: q1 }, { query: "second", providers: q2 }],
		baseOptions(),
	);
	expect(out).toContain('## Query: "first"');
	expect(out).toContain('## Query: "second"');
	expect(out.indexOf('## Query: "first"')).toBeLessThan(out.indexOf("## Exa"));
	expect(out).toContain("## Provider errors\n\n- **Parallel:** boom");
	expect(out).toContain("- **Tavily:** tavily down");
	const sources = out.slice(out.indexOf("**Sources:**"));
	expect(sources).toContain("1. Shared");
	expect(sources).toContain("2. Other");
	expect(sources).toContain("3. P2");
	expect(sources).toContain("4. F2");
});

test("renderCli emits a query-tagged JSON array for multiple queries", () => {
	const make = (url: string) => ({
		exa: entry([{ title: url, url, snippet: "" }]),
		parallel: { response: null, error: "boom" },
		tavily: { response: null, error: null },
		firecrawl: { response: null, error: null },
	});
	const out = JSON.parse(renderCli(
		[{ query: "one", providers: make("https://1.com") }, { query: "two", providers: make("https://2.com") }],
		baseOptions({ json: true }),
	));
	expect(out).toHaveLength(2);
	expect(out[0].query).toBe("one");
	expect(out[0].exa.response.results[0].url).toBe("https://1.com");
	expect(out[0].parallel.error).toBe("boom");
	expect(out[1].query).toBe("two");
	expect(out[1].exa.response.results[0].url).toBe("https://2.com");
});

test("main runs all providers and writes per-provider JSON (mocked fetch)", async () => {
	const exaSse =
		"data: " +
		JSON.stringify({ id: 1, result: { content: [{ type: "text", text: "Title: A\nURL: https://a.com\nText: hi.\n" }] } }) +
		"\n\n";
	const parallelJson = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: { structuredContent: { results: [{ url: "https://p.com", title: "P", excerpts: ["pe"] }] } },
	});
	const tavilyJson = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: {
			structuredContent: {
				answer: null,
				results: [{ url: "https://t.com", title: "T", content: "tc", raw_content: null }],
			},
		},
	});
	const firecrawlJson = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: {
			content: [{
				type: "text",
				text: JSON.stringify({ success: true, data: { web: [{ url: "https://f.com", title: "F", description: "fd" }] } }),
			}],
		},
	});

	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("exa")) {
			return Promise.resolve(new Response(exaSse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}));
		}
		if (url.includes("tavily")) {
			return Promise.resolve(new Response(tavilyJson, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		}
		if (url.includes("firecrawl")) {
			return Promise.resolve(new Response(firecrawlJson, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		}
		return Promise.resolve(new Response(parallelJson, {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));
	}) as typeof globalThis.fetch;

	const cap = captureStdout();
	const code = await main(["langchain", "--json"]);
	expect(code).toBe(0);
	const parsed = JSON.parse(cap.read());
	expect(parsed.exa.error).toBeNull();
	expect(parsed.exa.response.results[0].url).toBe("https://a.com");
	expect(parsed.parallel.error).toBeNull();
	expect(parsed.parallel.response.results[0].url).toBe("https://p.com");
	expect(parsed.tavily.error).toBeNull();
	expect(parsed.tavily.response.results[0].url).toBe("https://t.com");
	expect(parsed.firecrawl.error).toBeNull();
	expect(parsed.firecrawl.response.results[0].url).toBe("https://f.com");
});

test("main reports provider errors per provider and still renders the other", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((input: string | URL | Request) => {
		if (String(input).includes("exa")) {
			return Promise.resolve(new Response("slow down", { status: 429 }));
		}
		return Promise.resolve(new Response(
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [] } } }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		));
	}) as typeof globalThis.fetch;

	const cap = captureStdout();
	const code = await main(["langchain"]);
	expect(code).toBe(0);
	const out = cap.read();
	expect(out).toContain("## Provider errors");
	expect(out).toContain("- **Exa:** Exa MCP rate limit reached (429): slow down");
});

test("main searches each repeated -q query in order and groups output", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("exa")) {
			const sse = "data: " + JSON.stringify({
				id: 1,
				result: { content: [{ type: "text", text: `Title: exa\nURL: https://exa.com\nText: x.\n` }] },
			}) + "\n\n";
			return Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
		}
		const provider = url.includes("tavily") ? "tavily" : "parallel";
		return Promise.resolve(new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					structuredContent: { results: [{ url: `https://${provider}.com`, title: provider, excerpts: ["x"], content: "x", raw_content: null }] },
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		));
	}) as typeof globalThis.fetch;

	const cap = captureStdout();
	const code = await main(["positional one", "-q", "flag two", "--json"]);
	expect(code).toBe(0);
	const parsed = JSON.parse(cap.read());
	expect(parsed).toHaveLength(2);
	expect(parsed[0].query).toBe("positional one");
	expect(parsed[1].query).toBe("flag two");
	expect(parsed[0].exa.error).toBeNull();
	expect(parsed[1].exa.error).toBeNull();
});

test("skill subcommand prints the bundled skill document", async () => {
	const cap = captureStdout();
	const code = await main(["skill"]);
	expect(code).toBe(0);
	const out = cap.read();
	expect(out).toContain("# websearch");
	expect(out).toContain("## How to run");
	expect(out).toContain("websearch \"<query>\"");
});

test("--help returns 0 through main without process.exit", async () => {
	const cap = captureStdout();
	const code = await main(["--help"]);
	expect(code).toBe(0);
	expect(cap.read()).toContain("usage: websearch");
});

test("searchWithTavily sends keyless header and maps structuredContent", async () => {
	let capturedInit: RequestInit | undefined;
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		capturedInit = init;
		return Promise.resolve(new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					structuredContent: {
						answer: "synthesized",
						results: [
							{ url: "https://t.com", title: "T", content: "  chunk   one  ", raw_content: null },
							{ url: "https://raw.com", title: "R", content: "c", raw_content: "FULL PAGE TEXT" },
						],
					},
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		));
	}) as typeof globalThis.fetch;

	const res = await searchWithTavily("bun runtime", {
		numResults: 3,
		recencyFilter: "week",
		domainFilter: ["tavily.com", "-reddit.com"],
		includeContent: true,
	});

	const body = JSON.parse(String(capturedInit?.body));
	expect(capturedInit?.headers).toMatchObject({ "X-Tavily-Access-Mode": "keyless" });
	expect(body.params.name).toBe("tavily_search");
	expect(body.params.arguments).toEqual({
		query: "bun runtime",
		max_results: 3,
		time_range: "week",
		include_domains: ["tavily.com"],
		exclude_domains: ["reddit.com"],
		include_raw_content: true,
	});
	expect(res.answer).toBe("synthesized");
	expect(res.results).toEqual([
		{ title: "T", url: "https://t.com", snippet: "chunk one" },
		{ title: "R", url: "https://raw.com", snippet: "c" },
	]);
	expect(res.inlineContent).toEqual([
		{ url: "https://raw.com", title: "R", content: "FULL PAGE TEXT", error: null },
	]);
});

test("searchWithTavily parses SSE data line and builds answer from content", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((_input: string | URL | Request) => Promise.resolve(new Response(
		"event: message\r\ndata: " +
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				structuredContent: {
					answer: null,
					results: [{ url: "https://s.com", title: "S", content: "some content", raw_content: null }],
				},
			},
		}) + "\r\n\r\n",
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	))) as typeof globalThis.fetch;

	const res = await searchWithTavily("hello");
	expect(res.results[0]).toEqual({ title: "S", url: "https://s.com", snippet: "some content" });
	expect(res.answer).toContain("some content");
	expect(res.answer).toContain("Source: S (https://s.com)");
});

test("searchWithTavily surfaces keyless quota envelope as an error", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((_input: string | URL | Request) => Promise.resolve(new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{ type: "text", text: JSON.stringify({ code: "monthly_cap_reached", message: "You reached the monthly keyless Tavily limit." }) }],
				structuredContent: { code: "monthly_cap_reached", message: "You reached the monthly keyless Tavily limit." },
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	))) as typeof globalThis.fetch;

	await expect(searchWithTavily("hello")).rejects.toThrow("Tavily keyless error: You reached the monthly keyless Tavily limit.");
});

test("searchWithTavily surfaces tool isError as thrown error", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((_input: string | URL | Request) => Promise.resolve(new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { content: [{ type: "text", text: "Not found: Unknown tool: 'nope'" }], isError: true },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	))) as typeof globalThis.fetch;

	await expect(searchWithTavily("hello")).rejects.toThrow("Not found: Unknown tool: 'nope'");
});