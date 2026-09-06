import { afterEach, test, expect } from "bun:test";
import { searchWithParallel } from "../src/parallel.ts";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; headers: Record<string, string>; body: any };

function mockFetchOnce(fn: (call: FetchCall) => Response): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = Object.fromEntries(new Headers((init as RequestInit)?.headers).entries());
		const body = JSON.parse((init as RequestInit)?.body as string);
		return fn({ url, headers, body });
	}) as unknown as typeof globalThis.fetch;
}

function ok(response: Record<string, unknown>): Response {
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
	globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as unknown as typeof globalThis.fetch;
	const err = await searchWithParallel("q").then(() => null).catch(e => e);
	expect(err?.message).toContain("429");
});