import { isObject } from "./guards.ts";
import type { ExtractedContent, SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const SEARCH_TIMEOUT_MS = 10_000;

function isValidHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

interface ParallelMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		structuredContent?: unknown;
	};
	error?: { code?: number; message?: string };
}

interface McpResult {
	url: string;
	title: string | null;
	excerpts: string[];
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeExcerpts(cause: unknown): string[] {
	if (!Array.isArray(cause)) return [];
	return cause.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mapSearchResults(results: McpResult[] | undefined): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (const item of results) {
		if (!item?.url || !isValidHttpUrl(item.url)) continue;
		const excerpts = normalizeExcerpts(item.excerpts);
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: excerpts.length > 0 ? excerpts[0].replace(/\s+/g, " ").trim().slice(0, 200) : "",
		});
	}
	return mapped;
}

function buildAnswerFromExcerpts(results: McpResult[] | undefined): string {
	if (!Array.isArray(results) || results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const excerpts = normalizeExcerpts(item.excerpts);
		if (excerpts.length === 0) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${excerpts.join(" ")}\n\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapInlineContent(results: McpResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results
		.filter((r): r is McpResult & { excerpts: string[] } => !!r?.url && r.excerpts.length > 0)
		.map(r => ({
			url: r.url,
			title: r.title || "",
			content: r.excerpts.join(" "),
			error: null,
		}));
}

/**
 * Calls the Parallel Search MCP `web_search` tool keylessly and normalizes the
 * payload. Prefers `structuredContent` (JSON), falling back to `content[].text`,
 * which may itself be JSON or `Title:`/`URL:`/`Text:` blocks.
 */
interface ParallelMcpArgs {
	objective: string;
	search_queries: string[];
}

async function callParallelMcp(args: ParallelMcpArgs, signal?: AbortSignal): Promise<string> {
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search",
			arguments: args,
		},
	};

	const response = await fetch(PARALLEL_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json",
		},
		body: JSON.stringify(body),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429) {
			throw new Error(`Parallel MCP rate limit (429): ${errorText.slice(0, 200)}`);
		}
		throw new Error(`Parallel MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	// SAFETY: external MCP payload; response.json() gives unknown, shape validated by ParallelMcpRpcResponse fields below
	const data = await response.json() as ParallelMcpRpcResponse;

	if (data.error) {
		const code = data.error.code !== undefined ? ` ${data.error.code}` : "";
		throw new Error(`Parallel MCP error${code}: ${data.error.message || "Unknown error"}`);
	}

	if (data.result?.isError) {
		const message = data.result.content
			?.find(item => item.type === "text" && item.text !== undefined)
			?.text?.trim();
		throw new Error(message || "Parallel MCP returned an error");
	}

	const structured = data.result?.structuredContent;
	if (isObject(structured)) {
		return JSON.stringify(structured);
	}

	const text = data.result?.content
		?.find(item => item.type === "text" && item.text !== undefined && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw new Error("Parallel MCP returned empty content");
	}

	return text;
}

interface ParallelMcpStructuredContent {
	search_id?: string;
	results?: Array<{
		url: string;
		title?: string;
		excerpts?: string[];
	}>;
}

function parseMcpResults(text: string): McpResult[] {
	try {
		// SAFETY: external MCP payload; JSON.parse gives unknown, Array.isArray below validates the shape
		const parsed = JSON.parse(text) as ParallelMcpStructuredContent;
		if (Array.isArray(parsed.results)) {
			return parsed.results
				.filter(r => r.url)
				.map(r => ({ url: r.url, title: r.title ?? null, excerpts: normalizeExcerpts(r.excerpts) }));
		}
	} catch {
		// Not JSON, try text block parsing below.
	}

	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim().length > 0);
	return blocks
		.map(block => {
			const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
			const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
			let excerpts: string[] = [];
			const textStart = block.indexOf("\nText: ");
			if (textStart >= 0) {
				const content = block.slice(textStart + 7).trim();
				if (content) excerpts = [content];
			} else {
				const hlMatch = block.match(/\nHighlights:\s*\n/);
				if (hlMatch?.index != null) {
					const content = block.slice(hlMatch.index + hlMatch[0].length).trim();
					if (content) excerpts = [content];
				}
			}
			return { url, title, excerpts };
		})
		.filter(r => r.url.length > 0 && isValidHttpUrl(r.url));
}

function buildMcpQuery(query: string, options: SearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day": parts.push("past 24 hours"); break;
			case "week": parts.push("past week"); break;
			case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
			case "year": parts.push(String(now.getFullYear())); break;
		}
	}
	return parts.join(" ");
}

export async function searchWithParallel(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const effectiveQuery = buildMcpQuery(query, options);
	const text = await callParallelMcp({ objective: effectiveQuery, search_queries: [effectiveQuery] }, options.signal);

	const results = parseMcpResults(text).slice(0, options.numResults ?? 5);

	const response: SearchResponse = {
		answer: buildAnswerFromExcerpts(results),
		results: mapSearchResults(results),
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(results);
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
	}
	return response;
}