import type { ProviderName, SearchResult } from "./types.ts";

export interface CliOptions {
	numResults: number;
	recency?: "day" | "week" | "month" | "year";
	domains: string[];
	includeContent: boolean;
	json: boolean;
}

export interface ProviderEntry {
	response: import("./types.ts").SearchResponse | null;
	error: string | null;
}

export type CliResult = Record<ProviderName, ProviderEntry>;

export interface QueryResult {
	query: string;
	providers: CliResult;
}

const PROVIDER_LABELS = { exa: "Exa", parallel: "Parallel", tavily: "Tavily", firecrawl: "Firecrawl" } satisfies Record<ProviderName, string>;
const PROVIDER_ORDER: ProviderName[] = ["exa", "parallel", "tavily", "firecrawl"];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g; // eslint-disable-line no-control-regex -- intentional: strip remote provider control characters from terminal output

function sanitizeText(text: string): string {
	return text.replace(CONTROL_CHARS, "");
}

function formatSourceList(results: SearchResult[]): string {
	return results.map((r, i) => `${i + 1}. ${sanitizeText(r.title)}\n   ${r.url}`).join("\n\n");
}

// Mirrors pi-web-access gemini-search.ts multi-provider sections
function renderQuerySections(providers: CliResult, seenUrls: Set<string>, merged: SearchResult[]): string[] {
	const sections: string[] = [];
	const failures: string[] = [];

	for (const provider of PROVIDER_ORDER) {
		const entry = providers[provider];
		if (entry.response) {
			sections.push(`## ${PROVIDER_LABELS[provider]}\n\n${sanitizeText((entry.response.answer || "(No answer text returned.)").trimEnd())}`);
			for (const result of entry.response.results) {
				if (seenUrls.has(result.url)) continue;
				seenUrls.add(result.url);
				merged.push(result);
			}
		}
		if (entry.error) failures.push(`- **${PROVIDER_LABELS[provider]}:** ${sanitizeText(entry.error)}`);
	}
	if (failures.length) sections.push(`## Provider errors\n\n${failures.join("\n")}`);
	return sections;
}

// Per-query headers only when multiple queries ran, mirroring pi-web-access buildSearchReturn
function renderText(queries: QueryResult[]): string {
	const merged: SearchResult[] = [];
	const seenUrls = new Set<string>();
	const multi = queries.length > 1;

	const blocks: string[] = [];
	for (const { query, providers } of queries) {
		const body = renderQuerySections(providers, seenUrls, merged).join("\n\n\n") || "No results found.";
		blocks.push(multi ? `## Query: "${query}"\n\n${body}` : body);
	}
	if (blocks.length === 0) return "No results found.";

	// 2 blank lines between blocks keep provider sections visually distinct in terminal output
	let output = blocks.join("\n\n\n");
	if (merged.length) output += `\n\n\n---\n\n**Sources:**\n${formatSourceList(merged)}`;
	return output;
}

export function renderCli(results: QueryResult[], options: CliOptions): string {
	if (options.json) {
		if (results.length === 1) {
			const [{ providers }] = results;
			return JSON.stringify({ exa: providers.exa, parallel: providers.parallel, tavily: providers.tavily, firecrawl: providers.firecrawl }, null, 2);
		}
		return JSON.stringify(
			results.map(({ query, providers }) => ({ query, exa: providers.exa, parallel: providers.parallel, tavily: providers.tavily, firecrawl: providers.firecrawl })),
			null,
			2,
		);
	}
	return renderText(results);
}