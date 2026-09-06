default:
    @just --list

# Build the standalone binary (dist/websearch)
build:
    bun build src/cli.ts --compile --outfile dist/websearch

# Build and install the binary to ~/.local/bin (symlinked as "websearch")
install: build
    mkdir -p ~/.local/bin
    ln -sf "{{justfile_directory()}}/dist/websearch" ~/.local/bin/websearch
    echo "Installed websearch → ~/.local/bin/websearch"

# Symlink the agent skill into ~/.agent/skills/websearch/SKILL.md
skill:
    mkdir -p ~/.agent/skills/websearch
    ln -sf "{{justfile_directory()}}/src/skill.md" ~/.agent/skills/websearch/SKILL.md
    echo "Installed skill → ~/.agent/skills/websearch/SKILL.md"

# Live smoke test against all three providers
test-query query *args:
    bun run src/cli.ts "{{query}}" {{ args }}

# End-to-end: spawns the real CLI and asserts ## Exa / ## Parallel / ## Tavily structure (real network)
e2e:
    LIVE=1 bun test test/cli.live.test.ts
