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
	results.length || !error ? { response: { answer: "answer", results }, error } : { response: null, error };

test("exits 2 on missing query", async () => {
	expect(await main([])).toBe(2);
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
	};
	const out = JSON.parse(renderCli(res, baseOptions({ json: true })));
	expect(out.exa.response.results[0]).toEqual({ title: "A", url: "https://a.com", snippet: "s" });
	expect(out.parallel.response).toBeNull();
	expect(out.parallel.error).toBe("boom");
});

test("renderCli emits ## provider sections, merged sources, and errors", () => {
	const res = {
		exa: entry([{ title: "Shared", url: "https://same.com", snippet: "" }]),
		parallel: entry(
			[{ title: "Shared", url: "https://same.com", snippet: "" }, { title: "Extra", url: "https://extra.com", snippet: "" }],
			"boom",
		),
		tavily: entry([{ title: "Shared", url: "https://same.com", snippet: "" }]),
	};
	const out = renderCli(res, baseOptions());
	expect(out).toContain("## Exa\n\nanswer");
	expect(out).toContain("## Parallel\n\nanswer");
	expect(out).toContain("## Provider errors\n\n- **Parallel:** boom");
	const sources = out.slice(out.indexOf("**Sources:**"));
	expect(sources).toContain("1. Shared");
	expect(sources).toContain("2. Extra");
	expect(sources).not.toContain("3.");
});

test("renderCli separates provider sections with two blank lines", () => {
	const res = {
		exa: entry([{ title: "A", url: "https://a.com", snippet: "" }]),
		parallel: entry([{ title: "P", url: "https://p.com", snippet: "" }]),
		tavily: entry([{ title: "T", url: "https://t.com", snippet: "" }]),
	};
	const out = renderCli(res, baseOptions());
	expect(out).toContain("answer\n\n\n## Parallel");
	expect(out).toContain("## Parallel\n\nanswer\n\n\n## Tavily");
	expect(out).toContain("## Tavily\n\nanswer\n\n\n---\n\n**Sources:**");
});

test("main runs both providers and writes per-provider JSON (mocked fetch)", async () => {
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

test("skill subcommand prints the bundled skill document", async () => {
	const cap = captureStdout();
	const code = await main(["skill"]);
	expect(code).toBe(0);
	const out = cap.read();
	expect(out).toContain("# websearch");
	expect(out).toContain("## How to run");
	expect(out).toContain("bun run src/cli.ts");
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