default:
	@just --list

# Build the standalone binary (dist/websearch)
build:
	bun build src/cli.ts --compile --outfile dist/websearch

# Build and install the binary to ~/.local/bin
install: build
	mkdir -p ~/.local/bin
	rm -f ~/.local/bin/websearch
	cp "{{justfile_directory()}}/dist/websearch" ~/.local/bin/websearch
	chmod +x ~/.local/bin/websearch
	echo "Installed websearch → ~/.local/bin/websearch"
	# Create default config.toml if it doesn't exist
	mkdir -p ~/.config/websearch
	test -f ~/.config/websearch/config.toml || (echo "[providers.exa]" > ~/.config/websearch/config.toml && echo "enabled = true" >> ~/.config/websearch/config.toml && echo "timeout = 10000" >> ~/.config/websearch/config.toml && echo "" >> ~/.config/websearch/config.toml && echo "[providers.parallel]" >> ~/.config/websearch/config.toml && echo "enabled = true" >> ~/.config/websearch/config.toml && echo "timeout = 10000" >> ~/.config/websearch/config.toml && echo "" >> ~/.config/websearch/config.toml && echo "[providers.tavily]" >> ~/.config/websearch/config.toml && echo "enabled = false" >> ~/.config/websearch/config.toml && echo "timeout = 10000" >> ~/.config/websearch/config.toml && echo "" >> ~/.config/websearch/config.toml && echo "[providers.firecrawl]" >> ~/.config/websearch/config.toml && echo "enabled = true" >> ~/.config/websearch/config.toml && echo "timeout = 10000" >> ~/.config/websearch/config.toml && echo "Installed default config → ~/.config/websearch/config.toml")

# Symlink the agent skill into ~/.agent/skills/websearch/SKILL.md
skill:
	mkdir -p ~/.agents/skills/websearch
	ln -sf "{{justfile_directory()}}/src/skill.md" ~/.agents/skills/websearch/SKILL.md
	echo "Installed skill → ~/.agent/skills/websearch/SKILL.md"

# Live smoke test against all four providers
test-query query *args:
	bun run src/cli.ts "{{query}}" {{ args }}

# End-to-end: spawns the real CLI and asserts ## Exa / ## Parallel / ## Tavily / ## Firecrawl structure (real network)
e2e:
	LIVE=1 bun test test/cli.live.test.ts
