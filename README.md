# websearch

Keyless web-search CLI that queries the [Exa](https://exa.ai), [Parallel](https://parallel.ai), and [Tavily](https://tavily.com) MCP servers over plain HTTP JSON-RPC. No API keys, no SDKs — output is compatible with [pi-extension](https://github.com/badlogic/pi-mono) search-result shapes (same `SearchResponse` shape as `pi-web-access`).

## Install / build

Requires [Bun](https://bun.com) 1.4+.

```sh
bun install
bun build src/cli.ts --compile --outfile dist/websearch   # single static binary
```

Run from source or from the binary:

```sh
bun run src/cli.ts --help
./dist/websearch "bun javascript runtime"
```

## Usage

```sh
websearch [query] [options]

Options:
  -q, --query <q>                      search query; repeat to run several queries in sequence
  -n, --num-results <n>                number of results per provider (default: 5, max 20)
      --recency <day|week|month|year>  recency filter
      --domain <d>...                  restrict/exclude domains; prefix "-" to exclude
      --content                        include page content as inlineContent
      --json                           emit JSON instead of human-readable text
  -h, --help                           show this help
```

`websearch skill` prints the bundled agent skill document (`src/skill.md`) to stdout — handy for wiring this CLI into agent tooling.

Examples:

```sh
websearch "bun javascript runtime"
websearch -q "bun runtime benchmarks" -q "bun vs node performance"
websearch "exa docs" -n 3 --json
websearch "tailscale" --domain tailscale.com          # restrict to one site
websearch "rust vs go" --domain github.com --domain -reddit.com
websearch "gossip protocols" --json | jq '.exa.response.answer'
```

### Multiple queries

Repeat `-q/--query` to run several queries in one call (a positional query runs first). Each query runs sequentially — all three providers still fan out in parallel within a query — and one query failing never blocks the rest. With multiple queries, text output groups each query under a `## Query: "<query>"` header and merges/dedupes all sources into a single footer list; `--json` emits an array of `{ query, exa, parallel, tavily }` objects instead of the single-query object.

For research, prefer 2–4 varied angles over near-duplicate phrasings — each query gets its own per-provider answers, so varying phrasing, scope, and angle gives much broader coverage. Good: `["react vs vue performance benchmarks 2026", "react vs vue developer experience comparison"]`. Bad: `["react vs vue", "react vs vue comparison"]` (too similar, redundant results).

Exit codes: `0` success, `1` runtime/search failure, `2` usage error.

## How it works

All three providers are called with unsigned `tools/call` JSON-RPC requests:

- **Exa** — `POST https://mcp.exa.ai/mcp?tools=web_search_exa` (SSE `data:` lines, with a plain-JSON fallback). Advanced searches (`--domain`, `--content`) use `web_search_advanced_exa` (`includeDomains`/`excludeDomains`, `enableHighlights`) and fall back to the basic tool — filters then degrade into `site:` / `-site:` query text — when the advanced tool errors.
- **Parallel** — `POST https://search.parallel.ai/mcp`, tool `web_search`, args `{ objective, search_queries: [query] }`. Results are taken from `structuredContent.results` when present, else parsed from the text blocks.
- **Tavily** — `POST https://mcp.tavily.com/mcp/`, tool `tavily_search`, with the `X-Tavily-Access-Mode: keyless` header (required, selects the free keyless tier). Args: `query`, `max_results`, `time_range`, `include_domains`/`exclude_domains`, `include_raw_content`. The keyless search payload arrives via `structuredContent`; `answer` is usually `null`, so the answer text is built from result content.

All three searches always run concurrently (`Promise.allSettled`); the text output has `## Exa`, `## Parallel`, and `## Tavily` sections, a merged URL-deduplicated `**Sources:**` footer, and a `## Provider errors` section when a provider fails.

## JSON output

`--json` prints `{ exa: {...}, parallel: {...}, tavily: {...} }`, where each entry is `{ response, error }` (one of them `null`; `response` is the `{ answer, results, inlineContent? }` object). Each result is `{ title, url, snippet }`. Pipe into `jq`:

```sh
websearch "vector databases" --json | jq -r '.exa.response.results[].url'
```

## Caveats

- **Keyless = shared rate limits.** All three endpoints throttle anonymous traffic aggressively; the failing provider is reported under `## Provider errors` while the others still render. Exa/Parallel answer `429`; Tavily answers HTTP 200 with an error payload mentioning its "monthly keyless limit" (bucketed, so it can clear within minutes). Retry later. Tavily documents an upgrade path (free API key, 1,000 credits/month) that works without code changes via an `Authorization: Bearer` header.
- Domain/recency/content filters are best-effort on Parallel (folded into query text); Exa honors them natively on the advanced tool.
- Results and answer text come straight from the providers — expect different output between `exa` and `parallel` for the same query.

## Development

```sh
bun test          # unit tests (mocked fetch, no network)
bun run typecheck # tsc --noEmit
just test-query "bun javascript runtime"   # live CLI smoke test via just
just e2e         # spawns the CLI and asserts ## Exa / ## Parallel output structure
```

Layout: `src/types.ts` (shared types) · `src/exa.ts` · `src/parallel.ts` · `src/render.ts` (text/JSON rendering) · `src/cli.ts` (arg parsing + main). Protocol details and captured request/response fixtures live in `PLAN.md`.
