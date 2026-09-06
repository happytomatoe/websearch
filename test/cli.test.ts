import { afterEach, test, expect } from "bun:test";
import { main } from "../src/cli.ts";
import { renderCli, type CliOptions } from "../src/render.ts";

const realFetch = globalThis.fetch;
const realStdoutWrite = process.stdout.write;

function captureStdout(): { read: () => string } {
	let buf = "";
	process.stdout.write = ((chunk: string) => {
		buf += String(chunk);
		return 0;
	}) as unknown as typeof process.stdout.write;
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
	};
	const out = renderCli(res, baseOptions());
	expect(out).toContain("answer\n\n\n## Parallel");
	expect(out).toContain("## Parallel\n\nanswer\n\n\n---\n\n**Sources:**");
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

	globalThis.fetch = ((input: string | URL | Request) => {
		const url = String(input);
		const body = url.includes("exa") ? exaSse : parallelJson;
		return Promise.resolve(new Response(body, {
			status: 200,
			headers: { "Content-Type": url.includes("exa") ? "text/event-stream" : "application/json" },
		}));
	}) as unknown as typeof globalThis.fetch;

	const cap = captureStdout();
	const code = await main(["langchain", "--json"]);
	expect(code).toBe(0);
	const parsed = JSON.parse(cap.read());
	expect(parsed.exa.error).toBeNull();
	expect(parsed.exa.response.results[0].url).toBe("https://a.com");
	expect(parsed.parallel.error).toBeNull();
	expect(parsed.parallel.response.results[0].url).toBe("https://p.com");
});

test("main reports provider errors per provider and still renders the other", async () => {
	globalThis.fetch = ((input: string | URL | Request) => {
		if (String(input).includes("exa")) {
			return Promise.resolve(new Response("slow down", { status: 429 }));
		}
		return Promise.resolve(new Response(
			JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [] } } }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		));
	}) as unknown as typeof globalThis.fetch;

	const cap = captureStdout();
	const code = await main(["langchain"]);
	expect(code).toBe(0);
	const out = cap.read();
	expect(out).toContain("## Provider errors");
	expect(out).toContain("- **Exa:** Exa MCP rate limit reached (429): slow down");
});