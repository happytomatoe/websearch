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

const PROVIDER_LABELS: Record<ProviderName, string> = { exa: "Exa", parallel: "Parallel", tavily: "Tavily" };
const PROVIDER_ORDER: ProviderName[] = ["exa", "parallel", "tavily"];

function formatSourceList(results: SearchResult[]): string {
	return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
}

// Mirrors pi-web-access gemini-search.ts multi-provider sections
function renderText(providers: CliResult): string {
	const sections: string[] = [];
	const merged: SearchResult[] = [];
	const seenUrls = new Set<string>();
	const failures: string[] = [];

	for (const provider of PROVIDER_ORDER) {
		const entry = providers[provider];
		if (entry.response) {
			sections.push(`## ${PROVIDER_LABELS[provider]}\n\n${(entry.response.answer || "(No answer text returned.)").trimEnd()}`);
			for (const result of entry.response.results) {
				if (seenUrls.has(result.url)) continue;
				seenUrls.add(result.url);
				merged.push(result);
			}
		}
		if (entry.error) failures.push(`- **${PROVIDER_LABELS[provider]}:** ${entry.error}`);
	}
	if (failures.length) sections.push(`## Provider errors\n\n${failures.join("\n")}`);
	if (sections.length === 0) return "No results found.";

	// 2 blank lines between blocks keep provider sections visually distinct in terminal output
	let output = sections.join("\n\n\n");
	if (merged.length) output += `\n\n\n---\n\n**Sources:**\n${formatSourceList(merged)}`;
	return output;
}

export function renderCli(result: CliResult, options: CliOptions): string {
	if (options.json) {
		return JSON.stringify({ exa: result.exa, parallel: result.parallel, tavily: result.tavily }, null, 2);
	}
	return renderText(result);
}