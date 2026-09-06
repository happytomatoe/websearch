export type RecencyFilter = "day" | "week" | "month" | "year";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: null;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	includeContent?: boolean;
	signal?: AbortSignal;
}

export type ProviderName = "exa" | "parallel";

/** Result per provider for `both` mode; errors are captured per provider. */
export interface ProviderOutcome {
	provider: ProviderName;
	response: SearchResponse | null;
	error: string | null;
}