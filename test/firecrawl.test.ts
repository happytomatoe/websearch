import { afterEach, test, expect } from "bun:test";
import { searchWithFirecrawl } from "../src/firecrawl.ts";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; headers: Record<string, string>; body: any };

interface JsonRpcResult {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number;
	result?: JsonRpcResult;
	error?: { code?: number; message?: string };
}

function mockFetchOnce(fn: (call: FetchCall) => Response): void {
	const mock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		// SAFETY: JSON-RPC body is always a JSON string; init.body typed as BodyInit by fetch
		const body = JSON.parse(init?.body as string);
		return fn({ url, headers, body });
	};
	// SAFETY: test mock intentionally narrower than Bun's fetch (no preconnect); cast to satisfy assignment
	globalThis.fetch = mock as typeof globalThis.fetch;
}

function ok(response: JsonRpcResponse): Response {
	return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

test("sends tools/call firecrawl_search with query and limit, maps results", async () => {
	let captured: FetchCall | null = null;
	mockFetchOnce(call => {
		captured = call;
		return ok({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{
					type: "text",
					text: JSON.stringify({
						success: true,
						data: {
							web: [
								{ url: "https://bun.com/", title: "Bun Runtime", description: "A fast JS runtime.", position: 1 },
								{ url: "https://example.com/x", title: null, description: "Example description" },
							],
						},
						creditsUsed: 1,
					}),
				}],
			},
		});
	});

	const res = await searchWithFirecrawl("bun javascript runtime", { numResults: 3 });

	expect(captured).not.toBeNull();
	expect(captured!.url).toBe("https://mcp.firecrawl.dev/v2/mcp");
	expect(captured!.body.method).toBe("tools/call");
	expect(captured!.body.params.name).toBe("firecrawl_search");
	expect(captured!.body.params.arguments).toEqual({ query: "bun javascript runtime", limit: 3 });

	expect(res.results).toHaveLength(2);
	expect(res.results[0]).toEqual({ title: "Bun Runtime", url: "https://bun.com/", snippet: "A fast JS runtime." });
	expect(res.results[1].title).toBe("Source 2");
	expect(res.answer).toContain("A fast JS runtime.");
	expect(res.answer).toContain("https://bun.com/");
});

test("sends SSE data line response", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((_input: string | URL | Request) => Promise.resolve(new Response(
		"event: message\r\ndata: " +
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{
					type: "text",
					text: JSON.stringify({
						success: true,
						data: { web: [{ url: "https://s.com", title: "S", description: "desc text" }] },
					}),
				}],
			},
		}) + "\r\n\r\n",
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	))) as typeof globalThis.fetch;

	const res = await searchWithFirecrawl("hello");
	expect(res.results[0]).toEqual({ title: "S", url: "https://s.com", snippet: "desc text" });
	expect(res.answer).toContain("desc text");
	expect(res.answer).toContain("Source: S (https://s.com)");
});

test("maps recency filter to tbs and domains to include/exclude", async () => {
	let captured: FetchCall | null = null;
	mockFetchOnce(call => {
		captured = call;
		return ok({
			result: {
				content: [{
					type: "text",
					text: JSON.stringify({ success: true, data: { web: [] } }),
				}],
			},
		});
	});

	await searchWithFirecrawl("test", {
		numResults: 5,
		recencyFilter: "week",
		domainFilter: ["example.com", "-reddit.com"],
	});

	expect(captured!.body.params.arguments).toEqual({
		query: "test",
		limit: 5,
		tbs: "week",
		includeDomains: ["example.com"],
		excludeDomains: ["reddit.com"],
	});
});

test("reports rate limit on 429", async () => {
	const fetch429 = async (_input?: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
		new Response("rate limited", { status: 429 });
	// SAFETY: test mock intentionally narrower than Bun's fetch (no preconnect); cast to satisfy assignment
	globalThis.fetch = fetch429 as typeof globalThis.fetch;
	const err = await searchWithFirecrawl("q").then(() => null).catch(e => e);
	expect(err?.message).toContain("429");
});

test("surfaces result.isError message", async () => {
	mockFetchOnce(() => ok({ result: { isError: true, content: [{ type: "text", text: "Search quota exceeded" }] } }));
	const err = await searchWithFirecrawl("oops").then(() => null).catch(e => e);
	expect(err?.message).toContain("Search quota exceeded");
});

test("surfaces keyless error envelope as thrown error", async () => {
	// SAFETY: test doubles the network boundary; each Response is fully constructed and the mock matches fetch's callable shape
	globalThis.fetch = ((_input: string | URL | Request) => Promise.resolve(new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [{ type: "text", text: JSON.stringify({ code: "monthly_cap_reached", message: "Free keyless limit reached." }) }],
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	))) as typeof globalThis.fetch;

	await expect(searchWithFirecrawl("hello")).rejects.toThrow("Firecrawl keyless error: Free keyless limit reached.");
});
