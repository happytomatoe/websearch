# websearch

Keyless web-search CLI that queries the [Exa](https://exa.ai) and [Parallel](https://parallel.ai) MCP servers over plain HTTP JSON-RPC. No API keys, no SDKs — output is compatible with [pi-extension](https://github.com/badlogic/pi-mono) search-result shapes (same `SearchResponse` shape as `pi-web-access`).

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
websearch <query> [options]

Options:
  -n, --num-results <n>                number of results per provider (default: 5, max 20)
      --recency <day|week|month|year>  recency filter
      --domain <d>...                  restrict/exclude domains; prefix "-" to exclude
      --content                        include page content as inlineContent
      --json                           emit JSON instead of human-readable text
  -h, --help                           show this help
```

Examples:

```sh
websearch "bun javascript runtime"
websearch "exa docs" -n 3 --json
websearch "tailscale" --domain tailscale.com          # restrict to one site
websearch "rust vs go" --domain github.com --domain -reddit.com
websearch "gossip protocols" --json | jq '.exa.response.answer'
```

Exit codes: `0` success, `1` runtime/search failure, `2` usage error.

## How it works

Both providers are called with unsigned `tools/call` JSON-RPC requests:

- **Exa** — `POST https://mcp.exa.ai/mcp?tools=web_search_exa` (SSE `data:` lines, with a plain-JSON fallback). Advanced searches (`--domain`, `--content`) use `web_search_advanced_exa` (`includeDomains`/`excludeDomains`, `enableHighlights`) and fall back to the basic tool — filters then degrade into `site:` / `-site:` query text — when the advanced tool errors.
- **Parallel** — `POST https://search.parallel.ai/mcp`, tool `web_search`, args `{ objective, search_queries: [query] }`. Results are taken from `structuredContent.results` when present, else parsed from the text blocks.

Both searches always run concurrently (`Promise.allSettled`); the text output has a `## Exa` and a `## Parallel` section, a merged URL-deduplicated `**Sources:**` footer, and a `## Provider errors` section when a provider fails.

## JSON output

`--json` prints `{ exa: {...}, parallel: {...} }`, where each entry is `{ response, error }` (one of them `null`; `response` is the `{ answer, results, inlineContent? }` object). Each result is `{ title, url, snippet }`. Pipe into `jq`:

```sh
websearch "vector databases" --json | jq -r '.exa.response.results[].url'
```

## Caveats

- **Keyless = shared rate limits.** Both endpoints throttle anonymous traffic aggressively; on `429` the failing provider is reported under `## Provider errors` while the other still renders. Retry later.
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
