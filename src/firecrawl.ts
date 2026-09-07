import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const FIRECRAWL_MCP_URL = "https://mcp.firecrawl.dev/v2/mcp";
const FIRECRAWL_TOOL = "firecrawl_search";

interface FirecrawlMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		structuredContent?: unknown;
	};
	error?: { code?: number; message?: string };
}

interface FirecrawlSearchEnvelope {
	success?: boolean;
	data?: {
		web?: FirecrawlResult[];
	};
	creditsUsed?: number;
	code?: string;
	message?: string;
}

interface FirecrawlResult {
	url: string;
	title: string;
	description: string;
	position?: number;
}

function requestSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs ?? 10_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface FirecrawlSearchArgs {
	query: string;
	limit?: number;
	tbs?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
}

function firecrawlSearchArgs(query: string, options: SearchOptions): FirecrawlSearchArgs {
	const domains = options.domainFilter ?? [];
	const includeDomains = domains
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domains
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);

	const args: FirecrawlSearchArgs = { query, limit: options.numResults ?? 5 };
	if (options.recencyFilter) args.tbs = options.recencyFilter;
	if (includeDomains.length) args.includeDomains = includeDomains;
	if (excludeDomains.length) args.excludeDomains = excludeDomains;
	return args;
}

function extractRpcPayload(body: string): FirecrawlMcpRpcResponse {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice("data:".length).trim();
		if (!payload) continue;
		try {
			// SAFETY: external MCP SSE payload; JSON.parse gives unknown, shape validated by FirecrawlMcpRpcResponse fields
			const candidate = JSON.parse(payload) as FirecrawlMcpRpcResponse;
			if (candidate?.result || candidate?.error) return candidate;
		} catch {
			// Malformed event; keep scanning.
		}
	}
	// SAFETY: external MCP payload; JSON.parse gives unknown, shape validated by FirecrawlMcpRpcResponse fields
	return JSON.parse(body) as FirecrawlMcpRpcResponse;
}

function assertSearchEnvelope(payload: FirecrawlSearchEnvelope): FirecrawlSearchEnvelope {
	if (payload.code && !payload.success) {
		throw new Error(`Firecrawl keyless error: ${payload.message || payload.code}`);
	}
	return payload;
}

async function callFirecrawlMcp(args: FirecrawlSearchArgs, signal?: AbortSignal, timeoutMs?: number): Promise<FirecrawlSearchEnvelope> {
	const response = await fetch(FIRECRAWL_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: FIRECRAWL_TOOL, arguments: args },
		}),
		signal: requestSignal(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429) {
			throw new Error(`Firecrawl MCP rate limit (429): ${errorText.slice(0, 200)}`);
		}
		throw new Error(`Firecrawl MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const data = extractRpcPayload(await response.text());

	if (data.error) {
		const code = data.error.code !== undefined ? ` ${data.error.code}` : "";
		throw new Error(`Firecrawl MCP error${code}: ${data.error.message || "Unknown error"}`);
	}

	if (data.result?.isError) {
		const message = data.result.content
			?.find(item => item.type === "text" && item.text !== undefined)
			?.text?.trim();
		throw new Error(message || "Firecrawl MCP returned an error");
	}

	const text = data.result?.content
		?.find(item => item.type === "text" && item.text !== undefined && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw new Error("Firecrawl MCP returned empty content");
	}

	try {
		// SAFETY: external MCP text payload; JSON.parse gives unknown, assertSearchEnvelope validates the envelope
		return assertSearchEnvelope(JSON.parse(text) as FirecrawlSearchEnvelope);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Firecrawl keyless error:")) throw err;
		throw new Error(`Firecrawl MCP returned unexpected payload: ${text.slice(0, 200)}`);
	}
}

function mapResults(results: FirecrawlResult[] | undefined): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (const item of results) {
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: (item.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
		});
	}
	return mapped;
}

function buildAnswerFromDescriptions(results: FirecrawlResult[] | undefined): string {
	if (!Array.isArray(results) || results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const description = (item.description ?? "").replace(/\s+/g, " ").trim();
		if (!description) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${description}\n\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

/**
 * Calls the Firecrawl remote MCP `firecrawl_search` tool keylessly and
 * normalizes the payload to the shared SearchResponse shape.
 */
export async function searchWithFirecrawl(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const envelope = await callFirecrawlMcp(firecrawlSearchArgs(query, options), options.signal, options.timeoutMs);

	const webResults = envelope.data?.web;
	const results = mapResults(webResults);
	const response: SearchResponse = {
		answer: buildAnswerFromDescriptions(webResults),
		results,
	};
	return response;
}
