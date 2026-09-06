import { afterEach, test, expect } from "bun:test";
import { searchWithParallel } from "../src/parallel.ts";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; headers: Record<string, string>; body: any };

interface JsonRpcResult {
	content?: Array<{ type?: string; text?: string }>;
	structuredContent?: unknown;
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

test("sends tools/call web_search with objective and search_queries, maps results", async () => {
	let captured: FetchCall | null = null;
	mockFetchOnce(call => {
		captured = call;
		return ok({
			jsonrpc: "2.0",
			id: 1,
			result: {
				structuredContent: {
					search_id: "abc",
					results: [
						{ url: "https://docs.parallel.ai/search", title: "Search Docs", excerpts: ["excerpt one", "excerpt two"] },
						{ url: "https://example.com/x", title: null, excerpts: [] },
					],
				},
			},
		});
	});

	const res = await searchWithParallel("parallel docs", { numResults: 3 });

	expect(captured).not.toBeNull();
	expect(captured!.url).toBe("https://search.parallel.ai/mcp");
	expect(captured!.body.method).toBe("tools/call");
	expect(captured!.body.params.name).toBe("web_search");
	expect(captured!.body.params.arguments).toEqual({ objective: "parallel docs", search_queries: ["parallel docs"] });

	expect(res.results).toHaveLength(2);
	expect(res.results[0]).toEqual({ title: "Search Docs", url: "https://docs.parallel.ai/search", snippet: "excerpt one" });
	expect(res.results[1].title).toBe("Source 2");
	expect(res.answer).toContain("excerpt one");
	expect(res.answer).toContain("https://docs.parallel.ai/search");
});

test("parses text-block response when structuredContent is absent", async () => {
	mockFetchOnce(() => ok({
		result: {
			content: [{ type: "text", text: "Title: A Page\nURL: https://a.example.com\nText: Some body.\n\nTitle: B\nURL: https://b.example.com" }],
		},
	}));

	const res = await searchWithParallel("anything");
	expect(res.results).toHaveLength(2);
	expect(res.results[0]).toEqual({ title: "A Page", url: "https://a.example.com", snippet: "Some body." });
});

test("surfaces result.isError message", async () => {
	mockFetchOnce(() => ok({ result: { isError: true, content: [{ type: "text", text: "No results found" }] } }));
	const err = await searchWithParallel("oops").then(() => null).catch(e => e);
	expect(err?.message).toContain("No results found");
});

test("reports rate limit on 429", async () => {
	const fetch403 = async (_input?: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
		new Response("slow down", { status: 429 });
	// SAFETY: test mock intentionally narrower than Bun's fetch (no preconnect); cast to satisfy assignment
	globalThis.fetch = fetch403 as typeof globalThis.fetch;
	const err = await searchWithParallel("q").then(() => null).catch(e => e);
	expect(err?.message).toContain("429");
});