import type { ExtractedContent, SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const TAVILY_MCP_URL = "https://mcp.tavily.com/mcp/";
const TAVILY_TOOL = "tavily_search";
const SEARCH_TIMEOUT_MS = 60_000;

interface TavilyMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		structuredContent?: unknown;
	};
	error?: { code?: number; message?: string };
}

interface TavilySearchPayload {
	answer?: string | null;
	results?: TavilyResult[];
}

interface TavilyResult {
	url: string;
	title: string | null;
	content: string | null;
	raw_content: string | null;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function tavilySearchArgs(query: string, options: SearchOptions): Record<string, unknown> {
	const domains = options.domainFilter ?? [];
	const includeDomains = domains
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domains
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);

	const args: Record<string, unknown> = {
		query,
		max_results: options.numResults ?? 5,
		...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
		...(includeDomains.length ? { include_domains: includeDomains } : {}),
		...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
		...(options.includeContent ? { include_raw_content: true } : {}),
	};
	return args;
}

/**
 * Extracts the JSON-RPC payload from the response body. The streamable-HTTP MCP
 * server replies with `event:`/`data:` SSE lines unless it decides to answer
 * with plain JSON.
 */
function extractRpcPayload(body: string): TavilyMcpRpcResponse {
	const dataLine = body.split("\n").find(line => line.startsWith("data:"));
	if (dataLine) {
		try {
			return JSON.parse(dataLine.slice("data:".length).trim()) as TavilyMcpRpcResponse;
		} catch {
			// Fall through to whole-body JSON parsing.
		}
	}
	return JSON.parse(body) as TavilyMcpRpcResponse;
}

function assertSearchPayload(payload: TavilySearchPayload & { code?: string; message?: string }): TavilySearchPayload {
	// Quota/throttle envelopes arrive as HTTP 200 with { code, message } and no results.
	if (payload.code && !Array.isArray(payload.results)) {
		throw new Error(`Tavily keyless error: ${payload.message || payload.code}`);
	}
	return payload;
}

async function callTavilyMcp(args: Record<string, unknown>, signal?: AbortSignal): Promise<TavilySearchPayload> {
	const response = await fetch(TAVILY_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"X-Tavily-Access-Mode": "keyless",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: TAVILY_TOOL,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429) {
			throw new Error(`Tavily MCP rate limit (429): ${errorText.slice(0, 200)}`);
		}
		throw new Error(`Tavily MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = extractRpcPayload(await response.text());

	if (data.error) {
		const code = typeof data.error.code === "number" ? ` ${data.error.code}` : "";
		throw new Error(`Tavily MCP error${code}: ${data.error.message || "Unknown error"}`);
	}

	if (data.result?.isError) {
		const message = data.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text?.trim();
		throw new Error(message || "Tavily MCP returned an error");
	}

	const structured = data.result?.structuredContent;
	if (structured && typeof structured === "object") {
		return assertSearchPayload(structured as TavilySearchPayload & { code?: string; message?: string });
	}

	const text = data.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
		?.text;

	if (text) {
		try {
			return assertSearchPayload(JSON.parse(text) as TavilySearchPayload & { code?: string; message?: string });
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("Tavily keyless error:")) throw err;
			// Not JSON — treated as an unexpected payload below.
		}
	}
	throw new Error("Tavily MCP returned empty content");
}

function mapResults(results: TavilyResult[] | undefined): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (const item of results) {
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: (item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
		});
	}
	return mapped;
}

function buildAnswerFromContent(results: TavilyResult[] | undefined): string {
	if (!Array.isArray(results) || results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const content = (item.content ?? "").replace(/\s+/g, " ").trim();
		if (!content) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${content}\n\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapInlineContent(results: TavilyResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results
		.filter(r => !!r?.url && typeof r.raw_content === "string" && r.raw_content.length > 0)
		.map(r => ({
			url: r.url,
			title: r.title || "",
			content: r.raw_content as string,
			error: null,
		}));
}

/**
 * Calls the Tavily remote MCP `tavily_search` tool with the keyless access
 * header and normalizes the payload to the shared SearchResponse shape.
 */
export async function searchWithTavily(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const payload = await callTavilyMcp(tavilySearchArgs(query, options), options.signal);

	const results = mapResults(payload.results);
	const response: SearchResponse = {
		answer: typeof payload.answer === "string" && payload.answer.trim().length > 0
			? payload.answer
			: buildAnswerFromContent(payload.results),
		results,
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(payload.results);
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
	}
	return response;
}