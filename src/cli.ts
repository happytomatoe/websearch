import { searchWithExa } from "./exa.ts";
import { searchWithFirecrawl } from "./firecrawl.ts";
import { searchWithParallel } from "./parallel.ts";
import { searchWithTavily } from "./tavily.ts";
import { loadConfig } from "./config.ts";
import { renderCli, type CliOptions, type CliResult, type ProviderEntry, type QueryResult } from "./render.ts";
import type { ProviderName, SearchOptions, SearchResponse } from "./types.ts";
import skillDoc from "./skill.md" with { type: "text" };

const USAGE = `usage: websearch [query] [options]

Searches the web via the keyless MCP servers. Providers can be configured in config.toml
(current directory or ~/.config/websearch/config.toml).

Options:
  -q, --query <q>                      search query; repeat to run several queries in sequence
  -n, --num-results <n>                results per query (default: 5, max 20)
      --recency <day|week|month|year>  recency filter
      --domain <d>...                  restrict/exclude domains; prefix "-" to exclude
      --content                        include page content as inlineContent
      --json                           emit JSON instead of human-readable text
  -h, --help                           show this help

A positional query runs first, followed by -q/--query values in order. With multiple
queries, output groups each query under a '## Query' header with one merged source list.

Examples:
  websearch "bun javascript runtime"
  websearch -q "bun runtime benchmarks" -q "bun vs node performance"
  websearch "exa docs" -n 3 --json
  websearch "tailscale" --domain tailscale.com
`;

interface Parsed {
	queries: string[];
	options: CliOptions;
}

class UsageError extends Error {}

class EarlyExitError extends Error {
	constructor(readonly output: string, readonly exitCode: number) {
		super(output);
	}
}

function parseArgs(argv: string[]): Parsed {
	let numResults = 5;
	let recency: CliOptions["recency"];
	const domains: string[] = [];
	let includeContent = false;
	let json = false;

	const queryParts: string[] = [];
	const flagQueries: string[] = [];

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === "skill" && i === 0 && argv.length === 1) {
			throw new EarlyExitError(skillDoc, 0);
		}
		if (arg === "-h" || arg === "--help") {
			throw new EarlyExitError(USAGE, 0);
		}
		if (arg === "-q" || arg === "--query") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) throw new UsageError(`--query requires a value`);
			flagQueries.push(value);
			i += 2;
			continue;
		}
		if (arg.startsWith("--query=")) {
			const value = arg.slice("--query=".length);
			if (!value) throw new UsageError(`--query requires a value`);
			flagQueries.push(value);
			i++;
			continue;
		}
		if (arg === "-n" || arg === "--num-results") {
			const n = Number(argv[i + 1]);
			if (!Number.isInteger(n) || n < 1 || n > 20) {
				throw new UsageError(`invalid num-results "${argv[i + 1]}" (expected integer 1-20)`);
			}
			numResults = n;
			i += 2;
			continue;
		}
		if (arg.startsWith("--num-results=")) {
			const n = Number(arg.slice("--num-results=".length));
			if (!Number.isInteger(n) || n < 1 || n > 20) {
				throw new UsageError(`invalid num-results "${arg.slice("--num-results=".length)}" (expected integer 1-20)`);
			}
			numResults = n;
			i++;
			continue;
		}
		if (arg === "--recency") {
			const value = argv[i + 1];
			if (value !== "day" && value !== "week" && value !== "month" && value !== "year") {
				throw new UsageError(`invalid recency "${value}" (expected day, week, month, or year)`);
			}
			recency = value;
			i += 2;
			continue;
		}
		if (arg.startsWith("--recency=")) {
			const value = arg.slice("--recency=".length);
			if (value !== "day" && value !== "week" && value !== "month" && value !== "year") {
				throw new UsageError(`invalid recency "${value}" (expected day, week, month, or year)`);
			}
			recency = value;
			i++;
			continue;
		}
		if (arg === "--domain") {
			const value = argv[i + 1];
			// A leading "-" is the documented exclude prefix (e.g. -reddit.com), not an option;
			// a "--" token is always a mispositioned option (e.g. --domain --json).
			if (!value || value === "-" || value.startsWith("--")) throw new UsageError(`--domain requires a value`);
			domains.push(value);
			i += 2;
			continue;
		}
		if (arg.startsWith("--domain=")) {
			const value = arg.slice("--domain=".length);
			if (!value) throw new UsageError(`--domain requires a value`);
			domains.push(value);
			i++;
			continue;
		}
		if (arg === "--content") {
			includeContent = true;
			i++;
			continue;
		}
		if (arg === "--json") {
			json = true;
			i++;
			continue;
		}
		if (arg === "--") {
			for (let k = i + 1; k < argv.length; k++) queryParts.push(argv[k]);
			break;
		}
		if (arg.startsWith("-")) {
			throw new UsageError(`unknown option ${arg}`);
		}
		queryParts.push(arg);
		i++;
	}

	const positional = queryParts.join(" ").trim();
	const flagValues = flagQueries.map(q => q.trim()).filter(Boolean);
	const queries = positional ? [positional, ...flagValues] : flagValues;
	if (queries.length === 0) throw new UsageError("missing query argument");

	return { queries, options: { numResults, recency, domains, includeContent, json } };
}
function buildOptions(parsed: Parsed): SearchOptions {
	return {
		numResults: parsed.options.numResults,
		recencyFilter: parsed.options.recency,
		domainFilter: parsed.options.domains.length ? parsed.options.domains : undefined,
		includeContent: parsed.options.includeContent,
	};
}

async function searchOne(query: string, options: SearchOptions): Promise<CliResult> {
	const config = loadConfig();
	const results: Promise<SearchResponse | null>[] = [];
	const providerNames: string[] = [];

	if (config.providers.exa.enabled) {
		results.push(searchWithExa(query, { ...options, timeoutMs: config.providers.exa.timeout }));
		providerNames.push("exa");
	}
	if (config.providers.parallel.enabled) {
		results.push(searchWithParallel(query, { ...options, timeoutMs: config.providers.parallel.timeout }));
		providerNames.push("parallel");
	}
	if (config.providers.tavily.enabled) {
		results.push(searchWithTavily(query, { ...options, timeoutMs: config.providers.tavily.timeout }));
		providerNames.push("tavily");
	}
	if (config.providers.firecrawl.enabled) {
		results.push(searchWithFirecrawl(query, { ...options, timeoutMs: config.providers.firecrawl.timeout }));
		providerNames.push("firecrawl");
	}

	const settledResults = await Promise.allSettled(results);
	const unwrap = (outcome: PromiseSettledResult<SearchResponse | null>, label: string): ProviderEntry => {
		if (outcome.status === "rejected") return { response: null, error: messageOf(outcome.reason) };
		if (!outcome.value) return { response: null, error: `${label} returned no results` };
		return { response: outcome.value, error: null };
	};

	const cliResult: CliResult = {};
	for (let i = 0; i < providerNames.length; i++) {
		// SAFETY: providerNames contains only valid ProviderName values from config
		// SAFETY: providerNames only contains valid ProviderName values from config
		const name = providerNames[i] as ProviderName;
		cliResult[name] = unwrap(settledResults[i], name);
	}
	return cliResult;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export async function main(argv: string[]): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parseArgs(argv);
	} catch (err) {
		if (err instanceof EarlyExitError) {
			process.stdout.write(err.output.endsWith("\n") ? err.output : err.output + "\n");
			return err.exitCode;
		}
		if (err instanceof UsageError) {
			process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
			return 2;
		}
		throw err;
	}

	const options = buildOptions(parsed);
	const results: QueryResult[] = [];
	for (const query of parsed.queries) {
		results.push({ query, providers: await searchOne(query, options) });
	}

	const output = renderCli(results, parsed.options);
	if (output.trim()) process.stdout.write(output + "\n");
	const allFailed = results.every(r =>
		Object.keys(r.providers).length === 0 || Object.values(r.providers).every(p => p.response === null)
	);
	return allFailed ? 1 : 0;
}

if (import.meta.main) {
	const code = await main(process.argv.slice(2)).catch(err => {
		process.stderr.write(`error: ${messageOf(err)}\n`);
		return 1;
	});
	process.exit(code);
}