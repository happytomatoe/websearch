import { afterEach, test, expect } from "bun:test";
import { searchWithExa } from "../src/exa.ts";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; headers: Record<string, string>; body: any };

const calls: FetchCall[] = [];

function mockFetchResponse(handler: (call: FetchCall) => Response): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = Object.fromEntries(new Headers((init as RequestInit)?.headers).entries());
		const body = JSON.parse((init as RequestInit)?.body as string);
		const call = { url, headers, body };
		calls.push(call);
		return handler(call);
	}) as unknown as typeof globalThis.fetch;
}

function sseEvent(payload: Record<string, unknown>): Response {
	return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

afterEach(() => {
	globalThis.fetch = realFetch;
	calls.length = 0;
});

test("basic search calls web_search_exa via SSE and parses text blocks", async () => {
	mockFetchResponse(() => sseEvent({
		id: 1,
		result: {
			content: [{ type: "text", text: "Title: Bun Docs\nURL: https://bun.com/docs\nText: Bun is fast.\n\n---\n\nTitle: Second\nURL: https://b.example.com\nText: More.\n" }],
		},
	}));

	const res = await searchWithExa("bun runtime");
	expect(res).not.toBeNull();
	expect(calls).toHaveLength(1);
	expect(calls[0].url).toContain("tools=web_search_exa");
	expect(calls[0].body.params.name).toBe("web_search_exa");
	expect(calls[0].body.params.arguments).toEqual({ query: "bun runtime", numResults: 5 });
	expect(calls[0].headers.accept).toBe("application/json, text/event-stream");
	expect(res!.results).toHaveLength(2);
	expect(res!.results[0]).toEqual({ title: "Bun Docs", url: "https://bun.com/docs", snippet: "" });
	expect(res!.answer).toContain("Bun is fast.");
});

test("filtered search uses advanced tool and parses raw JSON results", async () => {
	mockFetchResponse(() => sseEvent({
		id: 1,
		result: {
			content: [{ type: "text", text: JSON.stringify({
				results: [
					{ title: "Rust", url: "https://rust.example.com", text: "Systems language", highlights: ["Rust is compiled"] },
				],
			}) }],
		},
	}));

	const res = await searchWithExa("rust", { domainFilter: ["example.com"], includeContent: true });
	expect(res).not.toBeNull();
	expect(calls[0].url).toContain("tools=web_search_advanced_exa");
	expect(calls[0].body.params.arguments.includeDomains).toEqual(["example.com"]);
	expect(calls[0].body.params.arguments.enableHighlights).toBe(true);
	expect(res!.inlineContent).toBeDefined();
	expect(res!.inlineContent![0].url).toBe("https://rust.example.com");
});

test("falls back from advanced to basic when advanced tool errors", async () => {
	let n = 0;
	mockFetchResponse(() => {
		n++;
		if (n === 1) {
			return sseEvent({ id: 1, error: { code: -32602, message: "tool not found" } });
		}
		return sseEvent({ id: 1, result: { content: [{ type: "text", text: "Title: A\nURL: https://a.example.com\nText: Hi.\n" }] } });
	});

	const res = await searchWithExa("q", { recencyFilter: "week" });
	expect(res).not.toBeNull();
	expect(calls).toHaveLength(2);
	expect(calls[0].url).toContain("tools=web_search_advanced_exa");
	expect(calls[1].url).toContain("tools=web_search_exa");
	expect(res!.results[0].url).toBe("https://a.example.com");
});

test("reports 429 rate limit on basic search", async () => {
	globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof globalThis.fetch;
	const err = await searchWithExa("q").then(() => null).catch(e => e);
	expect(err?.message).toContain("429");
});

test("throws when error field present and result.isError true", async () => {
	mockFetchResponse(() => sseEvent({ id: 1, result: { isError: true, content: [{ type: "text", text: "internal failure" }] } }));
	const err = await searchWithExa("q").then(() => null).catch(e => e);
	expect(err?.message).toContain("internal failure");
});