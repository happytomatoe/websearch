import type { ExtractedContent, SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const SEARCH_TIMEOUT_MS = 60_000;

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

function normalizeExcerpts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mapSearchResults(results: McpResult[] | undefined): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (const item of results) {
		if (!item?.url) continue;
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
async function callParallelMcp(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
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

	const data = await response.json() as ParallelMcpRpcResponse;

	if (data.error) {
		const code = typeof data.error.code === "number" ? ` ${data.error.code}` : "";
		throw new Error(`Parallel MCP error${code}: ${data.error.message || "Unknown error"}`);
	}

	if (data.result?.isError) {
		const message = data.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text?.trim();
		throw new Error(message || "Parallel MCP returned an error");
	}

	const structured = data.result?.structuredContent;
	if (structured && typeof structured === "object") {
		return JSON.stringify(structured);
	}

	const text = data.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
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
		.filter(r => r.url.length > 0);
}

export async function searchWithParallel(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const text = await callParallelMcp({ objective: query, search_queries: [query] }, options.signal);

	const results = parseMcpResults(text);

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