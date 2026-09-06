import type { ExtractedContent, RecencyFilter, SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_MCP_ADVANCED_TOOL = "web_search_advanced_exa";
const EXA_MCP_BASIC_TOOL = "web_search_exa";
const SEARCH_TIMEOUT_MS = 60_000;

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code?: number; message?: string };
}

interface ExaSearchResult {
	title?: string;
	url?: string;
	text?: string;
	highlights?: unknown;
}

export interface ExaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

type McpParsedResult = { title: string; url: string; content: string };

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: RecencyFilter): string {
	const now = new Date();
	const offsets = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	} satisfies Record<string, number>;
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): DomainFilter {
	const result: DomainFilter = {};
	if (!domainFilter?.length) return result;
	const includeDomains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	if (includeDomains.length) result.includeDomains = includeDomains;
	if (excludeDomains.length) result.excludeDomains = excludeDomains;
	return result;
}

interface ExaSearchArgs {
	query: string;
	numResults: number;
	type?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
	startPublishedDate?: string;
	enableHighlights?: boolean;
	textMaxCharacters?: number;
}

interface DomainFilter {
	includeDomains?: string[];
	excludeDomains?: string[];
}

function exaSearchArgs(query: string, options: ExaSearchOptions): ExaSearchArgs {
	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
	const args: ExaSearchArgs = {
		query,
		type: "auto",
		numResults: options.numResults ?? 5,
		...mapDomainFilter(options.domainFilter),
	};
	if (startDate) args.startPublishedDate = startDate;
	return args;
}

function normalizeHighlights(cause: unknown): string[] {
	if (!Array.isArray(cause)) return [];
	return cause.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function buildAnswerFromSearchResults(results: ExaSearchResult[] | undefined): string {
	if (!results?.length) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		const content = highlights.length > 0
			? highlights.join(" ")
			: item.text?.trim().slice(0, 1000) ?? "";
		if (!content) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${content}\n\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: ExaSearchResult[] | undefined): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (const item of results) {
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: "",
		});
	}
	return mapped;
}

function mapInlineContent(results: ExaSearchResult[] | undefined): ExtractedContent[] {
	if (!results?.length) return [];
	return results
		.filter((r): r is ExaSearchResult & { url: string; text: string } =>
			!!r?.url && typeof r.text === "string" && r.text.length > 0)
		.map(r => ({
			url: r.url,
			title: r.title || "",
			content: r.text,
			error: null,
		}));
}

function toSearchResponse(
	answer: string,
	results: SearchResult[],
	inlineContent: ExtractedContent[] | null,
): SearchResponse {
	const response: SearchResponse = { answer, results };
	if (inlineContent?.length) response.inlineContent = inlineContent;
	return response;
}
/**
 * Calls one Exa MCP search tool over JSON-RPC. The response is server-sent
 * events; we take the first `data:` payload carrying a `result`/`error` and
 * fall back to parsing the entire body as JSON.
 */
async function callExaMcp(
	toolName: string,
	args: ExaSearchArgs,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(`${EXA_MCP_URL}?tools=${toolName}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
			"x-exa-source": "websearch-cli",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429) {
			throw new Error(
				`Exa MCP rate limit reached (429): ${errorText.slice(0, 200)}`,
			);
		}
		throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();
	const dataLines = body.split("\n").filter(line => line.startsWith("data:"));

	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			// SAFETY: external MCP payload; JSON.parse gives unknown, shape validated by ExaMcpRpcResponse fields below
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
			// Ignore malformed event and keep looking.
		}
	}

	if (!parsed) {
		try {
			// SAFETY: external MCP payload; JSON.parse gives unknown, shape validated by ExaMcpRpcResponse fields below
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
			}
		} catch {
			// Not a plain JSON response either.
		}
	}

	if (!parsed) {
		throw new Error("Exa MCP returned an empty response");
	}

	if (parsed.error) {
		const code = parsed.error.code !== undefined ? ` ${parsed.error.code}` : "";
		const message = parsed.error.message || "Unknown error";
		throw new Error(`Exa MCP error${code}: ${message}`);
	}

	if (parsed.result?.isError) {
		const message = parsed.result.content
			?.find(item => item.type === "text" && item.text !== undefined)
			?.text?.trim();
		throw new Error(message || "Exa MCP returned an error");
	}

	const text = parsed.result?.content
		?.find(item => item.type === "text" && item.text !== undefined && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw new Error("Exa MCP returned empty content");
	}

	return text;
}
function parseJsonMcpResults(text: string): ExaSearchResult[] | null {
	try {
		// SAFETY: external MCP payload; JSON.parse gives unknown, length check below validates the shape
		const results = (JSON.parse(text) as { results?: ExaSearchResult[] }).results;
		return Array.isArray(results) && results.length > 0 ? results : null;
	} catch {
		return null;
	}
}

function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim().length > 0);
	const parsed = blocks.map(block => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			content = block.slice(textStart + 7).trim();
		} else {
			const hlMatch = block.match(/\nHighlights:\s*\n/);
			if (hlMatch?.index != null) {
				content = block.slice(hlMatch.index + hlMatch[0].length).trim();
			}
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title, url, content };
	}).filter(result => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
	if (results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
		if (!snippet) continue;
		const sourceTitle = result.title || `Source ${i + 1}`;
		parts.push(`${snippet}\n\nSource: ${sourceTitle} (${result.url})`);
	}
	return parts.join("\n\n");
}

function mapMcpInlineContent(results: McpParsedResult[]): ExtractedContent[] {
	return results
		.filter(result => result.content.length > 0)
		.map(result => ({
			url: result.url,
			title: result.title,
			content: result.content,
			error: null,
		}));
}

function isAbortMessage(message: string): boolean {
	return message.toLowerCase().includes("abort");
}

/**
 * Normalizes an Exa MCP search payload. The advanced tool returns raw Exa JSON
 * (`{results:[...]}`); the basic tool returns a formatted text block.
 */
async function searchWithExaMcpTool(
	tool: string,
	args: ExaSearchArgs,
	options: ExaSearchOptions,
): Promise<SearchResponse | null> {
	const text = await callExaMcp(tool, args, options.signal);

	const jsonResults = parseJsonMcpResults(text);
	if (jsonResults) {
		return toSearchResponse(
			buildAnswerFromSearchResults(jsonResults),
			mapResults(jsonResults),
			options.includeContent ? mapInlineContent(jsonResults) : null,
		);
	}

	const textResults = parseMcpResults(text);
	if (!textResults) return null;

	return toSearchResponse(
		buildAnswerFromMcpResults(textResults),
		mapResults(textResults),
		options.includeContent ? mapMcpInlineContent(textResults) : null,
	);
}

/**
 * Filtered searches need the advanced tool, which is not always available.
 * Fall back to the basic tool, where filters degrade into query text.
 */
async function searchWithFilteredExaMcp(
	query: string,
	options: ExaSearchOptions,
	basicArgs: ExaSearchArgs,
): Promise<SearchResponse | null> {
	try {
		return await searchWithExaMcpTool(EXA_MCP_ADVANCED_TOOL, {
			...exaSearchArgs(query, options),
			enableHighlights: true,
			textMaxCharacters: options.includeContent ? 50000 : 3000,
		}, options);
	} catch (err) {
		if (err instanceof Error && isAbortMessage(err.message)) throw err;
		return searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs, options);
	}
}

function buildMcpQuery(query: string, options: ExaSearchOptions): string {
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

export async function searchWithExa(query: string, options: ExaSearchOptions = {}): Promise<SearchResponse | null> {
	const basicArgs = { query: buildMcpQuery(query, options), numResults: options.numResults ?? 5 };
	const filtered = !!options.includeContent || !!options.recencyFilter || !!options.domainFilter?.length;

	return filtered
		? await searchWithFilteredExaMcp(query, options, basicArgs)
		: await searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs, options);
}