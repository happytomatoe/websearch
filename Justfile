default:
    @just --list

# Live smoke test against both providers
test-query query *args:
    bun run src/cli.ts "{{query}}" {{ args }}

# End-to-end: spawns the real CLI and asserts ## Exa / ## Parallel structure (real network)
e2e:
    LIVE=1 bun test test/cli.live.test.ts
