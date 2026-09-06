# Adding a new keyless search provider

A provider is a keyless MCP endpoint queried with a JSON-RPC `tools/call` request. This guide walks through everything needed to add one, using the real wiring as reference. Work through the checklist in order and commit at the end.

## 1. Verify the protocol against the live endpoint first

Do not write code from blog posts — probe the endpoint with `curl` and record the facts:

```sh
# List tools (SSE response):
curl -s -X POST https://<provider>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call the search tool:
curl -s -X POST https://<provider>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{}}}'
```

Things to capture and add to `PLAN.md` under "Verified protocol facts":

- Endpoint URL, auth headers (none for keyless), whether the reply is SSE (`data:` lines) or plain JSON
- Tool name, argument names, and their exact casing (`numResults` vs `max_results` vs `limit`)
- Where results live in the response: `result.structuredContent`, `result.content[].text` (JSON or text blocks?)
- Error shapes: HTTP 429? `result.isError`? HTTP 200 with an error envelope?
- Whether per-option mappings exist for `--recency`, `--domain`, and `--content`

## 2. Extend the shared types — `src/types.ts`

Add the provider to the `ProviderName` union. Everything else (registry maps, CLI result, JSON output) derives from it, so a missing member shows up as a type error:

```ts
export type ProviderName = "exa" | "parallel" | "tavily" | "firecrawl";
```

## 3. Write the client — `src/<provider>.ts`

Follow the shape of `src/tavily.ts` (the simplest client):

- `<PROVIDER>_MCP_URL`, tool name, and `SEARCH_TIMEOUT_MS = 60_000` as module constants
- `requestSignal(signal?)`: combine the caller's `AbortSignal` with a timeout via `AbortSignal.any`
- A private `call<X>Mcp(args, signal?)` function that POSTs the JSON-RPC body, throws on `!response.ok` (special-case 429 with a "rate limit" message), throws on `data.error` and `result.isError`, then extracts the payload (see `src/mcp.ts` for shared SSE/plain-JSON helpers — do not hand-roll them per provider)
- Mapping helpers normalizing the payload to `SearchResponse`: `answer` built from result content (with `Source: Title (url)` attributions), `results: SearchResult[]` with `title || \`Source N\`` and a whitespace-collapsed snippet, and `inlineContent` when `options.includeContent` is set
- Export `searchWith<Provider>(query: string, options: SearchOptions): Promise<SearchResponse>` — return `null` (not throw) only when the response legitimately contains no results

Conventions enforced in this repo: no comments restating code, type assertions need a safety comment, oxlint anti-slop rules run on every push.

## 4. Wire it into the CLI — `src/cli.ts`

Three touch points: the import, the `Promise.allSettled` array, and the returned `CliResult` record (`firecrawl: unwrap(firecrawlRes, "Firecrawl")`). Update the USAGE text ("Searches the web via the keyless … MCP servers") too.

## 5. Register it in the renderer — `src/render.ts`

Add the provider to both records (typecheck fails if either is missed):

```ts
const PROVIDER_LABELS: Record<ProviderName, string> = { ..., firecrawl: "Firecrawl" };
const PROVIDER_ORDER: ProviderName[] = [..., "firecrawl"];
```

The text renderer picks up the new section, merged `**Sources:**` dedup, and `## Provider errors` entry automatically. `renderCli` emits JSON keys in `PROVIDER_ORDER` order — append the new key there as well.

## 6. Test it

- **Unit** (`test/<provider>.test.ts`): mock `globalThis.fetch` (see `test/parallel.test.ts` for the pattern) and assert the request URL/body and the mapped `SearchResponse`; cover the error paths you probed (429, `isError`, error envelope). Mock URL matching in `test/cli.test.ts` uses `url.includes("<provider>")` — a provider whose URL does not contain its own name needs a distinct substring.
- **JSON wiring** (`test/cli.test.ts`): extend the "runs both providers" test's mock fetch so the new provider gets a fixture, then assert its parsed entry.
- **Live** (`test/cli.live.test.ts` + `Justfile e2e`): assert `^## <Provider>$` appears, with the same section-or-error escape hatch used for Tavily (keyless budgets are shared per IP).
- **Before committing**: `bun test && bun run typecheck && bun run lint && bun run dupcheck` (these also run in the lefthook pre-push hook; jscpd flags copies ≥ 50 tokens, so reuse `src/mcp.ts` instead of duplicating parsing helpers).

## 7. Update docs

- `README.md`: intro sentence, "How it works" bullet (endpoint/tool/args/response shape), keyless caveats, JSON example keys
- `src/skill.md`: description, endpoint list, output sections, JSON example, rate-limit notes
- `Justfile`: comment on the `e2e` recipe
- `PLAN.md`: verified protocol facts from step 1

## 8. Verify end-to-end

```sh
bun run src/cli.ts "<query>" -n 3                 # all sections render
bun run src/cli.ts "<query>" --json | jq 'keys'   # new provider key present
bun build src/cli.ts --compile --outfile dist/websearch
```

## Current registry (for reference)

| Provider | Endpoint | Tool | Notes |
|---|---|---|---|
| Exa | `https://mcp.exa.ai/mcp?tools=<tool>` | `web_search_exa` / `web_search_advanced_exa` | SSE; advanced→basic fallback for filters |
| Parallel | `https://search.parallel.ai/mcp` | `web_search` | Plain JSON; `structuredContent` or text blocks |
| Tavily | `https://mcp.tavily.com/mcp/` | `tavily_search` | Needs `X-Tavily-Access-Mode: keyless` header; SSE or JSON |
| Firecrawl | `https://mcp.firecrawl.dev/v2/mcp` | `firecrawl_search` | SSE; payload JSON in `content[].text`; 1k free/mo |
