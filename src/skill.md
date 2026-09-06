---
name: websearch
description: Keyless web-search CLI that queries the Exa, Parallel, and Tavily AI search MCP servers in parallel and returns per-provider answers with a merged, deduplicated source list. Supports multiple queries per call (repeat -q/--query) for broader research coverage. Use whenever fresh web information is needed - verifying library APIs or versions, researching errors and release notes, checking docs, pricing, or any fact that may have changed after training cutoff.
---

# websearch — keyless web search CLI

Searches the web without API keys by POSTing JSON-RPC `tools/call` requests to the keyless MCP endpoints of Exa (`https://mcp.exa.ai/mcp`), Parallel (`https://search.parallel.ai/mcp`), and Tavily (`https://mcp.tavily.com/mcp/` with the `X-Tavily-Access-Mode: keyless` header). All three providers always run in parallel; one failing (e.g. rate-limited) never blocks the others.

## When to use

- Verifying library APIs, breaking changes, or package versions (training data is stale)
- Researching errors, changelogs, documentation pages, pricing, or comparisons
- Any task needing fresh, citable web facts

## How to run

From the repository root:

    bun run src/cli.ts "<query>"        # human-readable output
    just test-query "<query>"           # same via the Just recipe
    dist/websearch "<query>"            # standalone compiled binary

## Commands

### Run a search

    bun run src/cli.ts "<query>" [options]

Options:

    -q, --query <q>                      search query; repeat to run several queries in sequence
    -n, --num-results <n>                results per provider (default 5, max 20)
        --recency <day|week|month|year>  recency filter
        --domain <d>                     restrict domains; prefix "-" to exclude
        --content                        include page content as inlineContent (JSON mode)
        --json                           machine-readable output
    -h, --help                           show help

Multi-line queries: pass the query as a single quoted argument (newlines are preserved). From a script, use command substitution:

    websearch "$(cat <<'EOF'
    <first line of the question>
    <second line with constraints and context>
    EOF
    )"

### Print the skill file

    bun run src/cli.ts skill

Writes the bundled skill.md document to stdout (also works in the compiled binary).

## Output structure

Text mode (default) prints provider sections separated by two blank lines:

    ## Exa
    <answer text with "Source: Title (url)" attributions>

    ## Parallel
    <answer text with "Source: Title (url)" attributions>

    ## Tavily
    <answer text with "Source: Title (url)" attributions>

    **Sources:**
    1. Title
       https://example.com/

- `## Provider errors` appears instead of a provider section when that provider failed.
- Sources are merged from all providers and deduplicated by exact URL (first provider wins).
- Exit codes: 0 success (even if one provider failed - check `## Provider errors`), 2 usage error, 1 unexpected runtime error.

## JSON mode

With `--json`, output is:

    {
      "exa":      { "response": { "answer": "...", "results": [{ "title": "", "url": "", "snippet": "" }] } | null, "error": null },
      "parallel": { "response": null, "error": "Parallel MCP rate limit (429): ..." },
      "tavily":   { "response": null, "error": null }
    }

`results[].snippet` is truncated to 200 chars. Add `--content` to include `inlineContent: [{ url, title, content, error }]` per provider.

## Multiple queries

Repeat `-q/--query` to run several queries in one call:

    bun run src/cli.ts -q "bun runtime benchmarks" -q "bun vs node performance" --json

Queries run in sequence (each still fans out to all three providers in parallel); a failing query is reported under that query's `## Provider errors` and never blocks the rest. With 2+ queries, text output wraps each query in a `## Query: "<query>"` section, `--json` emits an array of `{ query, exa, parallel, tavily }` objects, and the Sources footer merges and dedupes URLs across all queries (first occurrence wins).

For research tasks prefer 2-4 queries with varied angles, phrasing, and scope instead of near-duplicate rewordings. Good: ["react vs vue performance benchmarks 2026", "react vs vue developer experience comparison"]. Bad: ["react vs vue", "react vs vue comparison"] (too similar, redundant results).

## Interpreting results

- Cite from the merged **Sources:** list; it is the union of all providers.
- `## Exa` answers are synthesized summaries; `## Parallel` and `## Tavily` answers are excerpt-based.
- Keyless endpoints share public rate limits; Tavily reports its spent budget as an HTTP 200 error mentioning the "monthly keyless limit" and Exa/Parallel use HTTP 429. Failed providers appear under `## Provider errors`; retry later or rely on the others.
- Query like a search engine: keywords or short natural-language questions work best.
