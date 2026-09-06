# Implementation Plan: `websearch` CLI

Standalone CLI for web search via **Exa** and **Parallel** — both accessed **keylessly over MCP** (no registration, no API keys).

Runtime: **Bun + TypeScript** (ESM). Distributed as a self-contained binary via `bun build --compile`.
Location: `/home/l/git/websearch` (new project, separate from `pi-web-access`).

## Decisions (agreed)

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript on Bun | Code shapes proven in `pi-web-access`; Bun compiles to a native binary (user preference over Go) |
| Binary | `bun build --compile --outfile dist/websearch` | Fast startup, single-file distribution, cross-compile targets |
| Output | Same response format as pi-web-access extension; human-readable default, `--json` flag | Compatibility with the format the user already consumes |
| Providers | Exa MCP + Parallel MCP, keyless only | No registration desired; optional keys explicitly out of scope |

## Verified protocol facts (do not re-derive)

### Exa MCP (keyless) — from `pi-web-access/exa.ts` (working reference) + live probe
- Endpoint: `POST https://mcp.exa.ai/mcp?tools=<toolName>`
- Headers: `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `x-exa-source: websearch-cli`
- Body: JSON-RPC 2.0 → `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}}`
- Response is **SSE**: parse `data:` lines, take first payload with `result` or `error`; fall back to parsing whole body as JSON
- Tools:
  - `web_search_exa` — basic; args `{ query, numResults }` (ignores other args)
  - `web_search_advanced_exa` — args `{ query, type:"auto", numResults, includeDomains?, excludeDomains?, startPublishedDate?, enableHighlights:true, textMaxCharacters }`; returns raw Exa JSON `{results:[{title,url,text?,highlights?}]}`
- Strategy: filtered/content searches → advanced first, fall back to basic (filters degrade into query text via `site:`/`-site:` + recency phrases appended to the query)
- `result.isError === true` → the text content is the error message
- 429 → keyless rate limit; plain JSON result blocks parse as `Title:`/`URL:`/`Text:` text
- Live probe 2026-09-06: `GET /mcp` → 405 (endpoint alive, POST-only) ✅

### Parallel MCP (keyless) — from `pi-web-access/parallel.ts` + official docs
- Endpoint: `POST https://search.parallel.ai/mcp`
- Headers: `Content-Type: application/json`, `Accept: application/json` (no auth for keyless)
- Body: JSON-RPC 2.0 `tools/call` with tool name `web_search`, args `{ objective, search_queries: [query] }`
- Response is **plain JSON** (not SSE): prefer `result.structuredContent` (`{search_id, results:[{url,title,excerpts[]}]}`), else parse `result.content[].text`
- Officially documented as **free, no API key required**; anonymous free-tier runs in fast mode; ~25,000-char excerpt cap per call

## Response format (extension-compatible, from `pi-web-access/perplexity.ts:18-28`)

```ts
interface SearchResult { title: string; url: string; snippet: string }
interface SearchResponse {
  answer: string;
  results: SearchResult[];
  inlineContent?: ExtractedContent[]; // { url, title, content, error: null }
}
```

## CLI interface

```
websearch <query> [options]

Options:
  -p, --provider <exa|parallel|both>   default: exa
  -n, --num-results <n>                default: 5
      --recency <day|week|month|year>
      --domain <d>...                  repeatable; "-d" excludes
      --content                        include page content (inlineContent)
      --json                           emit SearchResponse JSON instead of text
  -h, --help
```

- `both`: run both providers concurrently (`Promise.allSettled`); merge results (dedupe by URL), concatenate answers with a `## provider` header per section; `--json` emits `{ exa: <SearchResponse|null>, parallel: <SearchResponse|null> }` with per-provider errors preserved
- Human-readable default: `answer` block, then numbered results `title — url` + first snippet line
- Exit codes: 0 success; 1 total failure (stderr carries the provider error); 2 CLI usage error

## File structure

```
/home/l/git/websearch/
├── package.json            # name "websearch", type module, scripts: build/test
├── tsconfig.json
├── PLAN.md                 # this file
├── src/
│   ├── cli.ts              # entrypoint: arg parsing, dispatch, rendering
│   ├── types.ts            # SearchResult, SearchResponse, ExtractedContent, SearchOptions
│   ├── exa.ts              # Exa MCP client (port of exa.ts MCP paths, no pi deps)
│   ├── parallel.ts         # Parallel MCP client (port of parallel.ts MCP path)
│   └── render.ts           # human-readable + JSON rendering
└── test/
    ├── exa.test.ts
    ├── parallel.test.ts
    └── cli.test.ts
```

Dependencies: **none at runtime** (Node/Bun stdlib `fetch` only). Dev: `@types/node`, `@types/bun`.

## Steps

1. **Scaffold** `package.json` + `tsconfig.json` + `src/types.ts`
   → verify: `bun run src/cli.ts` executes; `bunx tsc --noEmit` clean
2. **Port Parallel MCP client** `src/parallel.ts` (call → parse structuredContent/text → SearchResponse)
   → verify: unit test with a mocked `fetch` asserting request body `{objective, search_queries}` and mapped results
3. **Port Exa MCP client** `src/exa.ts` (SSE parsing, basic/advanced tool strategy, JSON & text result parsing, 429 message)
   → verify: unit tests with mocked `fetch` (SSE fixture, JSON fixture, 429 fixture, advanced→basic fallback)
4. **CLI + rendering** `src/cli.ts`, `src/render.ts` (`--json`, human format, `both` merge, exit codes)
   → verify: cli test asserts exit code 2 on bad args; render test asserts human + json output shapes
5. **Live smoke test** (real network, keyless): `bun run src/cli.ts "bun javascript runtime" --provider both -n 3`
   → verify: non-zero result count from at least one provider; `--json` parses with `jq`
6. **Binary** `bun build src/cli.ts --compile --outfile dist/websearch`
   → verify: `./dist/websearch --help` works; startup < ~100ms; `./dist/websearch "test query" --json | jq .answer` works
7. **README.md** — install, build, usage, keyless notes + rate-limit caveat

## Success criteria

### Automated
- [ ] `bunx tsc --noEmit` — no type errors
- [ ] `bun test` — all unit tests pass (mocked fetch; no network in CI)
- [ ] `bun run src/cli.ts --help` exits 0 and prints usage
- [ ] `bun run src/cli.ts` with no args exits 2
- [ ] `bun build src/cli.ts --compile --outfile dist/websearch` succeeds and binary runs
- [ ] `./dist/websearch "query" --json` output parses as the SearchResponse schema (answer: string, results: [{title,url,snippet}])

### Manual
- [ ] Live keyless Exa search returns real results (or a clear 429 rate-limit message)
- [ ] Live keyless Parallel search returns real results with excerpts
- [ ] `--provider both` shows merged results and isolates a single-provider failure
- [ ] Binary startup feels instant (no perceptible Node-style CLI lag)

## Out of scope
- API-key support (direct REST endpoints, unthrottled access) — keyless only
- Config files, workflows/summaries, curator, fetch_content, PDF/video tools
- npm publishing (binary distribution only, via `bun build --compile`)
