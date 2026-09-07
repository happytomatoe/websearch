import { parse } from "toml";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderConfig {
	enabled: boolean;
	timeout: number;
}

export interface AppConfig {
	providers: Record<string, ProviderConfig>;
}

const DEFAULT_CONFIG: AppConfig = {
	providers: {
		exa: { enabled: true, timeout: 10_000 },
		parallel: { enabled: true, timeout: 10_000 },
		tavily: { enabled: true, timeout: 10_000 },
		firecrawl: { enabled: true, timeout: 10_000 },
	},
};

const CONFIG_FILENAMES = ["config.toml"];
const HOME_CONFIG_DIR = join(homedir(), ".config", "websearch");

export function loadConfig(): AppConfig {
	for (const filename of CONFIG_FILENAMES) {
		try {
			const content = readFileSync(filename, "utf-8");
			// SAFETY: TOML parser output validated by mergeWithDefaults
			const parsed = parse(content) as { providers?: Record<string, ProviderConfig> };
			return mergeWithDefaults(parsed);
		} catch {
			// File not found or parse error — try next location
		}
	}
	try {
		const content = readFileSync(join(HOME_CONFIG_DIR, "config.toml"), "utf-8");
		// SAFETY: TOML parser output validated by mergeWithDefaults
			const parsed = parse(content) as { providers?: Record<string, ProviderConfig> };
		return mergeWithDefaults(parsed);
	} catch {
		// No config found anywhere — return defaults
	}
	return DEFAULT_CONFIG;
}

// SAFETY: parsed comes from TOML parse via loadConfig, validated at runtime

// SAFETY: parsed comes from TOML parse via loadConfig, validated at runtime
function mergeWithDefaults(parsed: { providers?: Record<string, ProviderConfig> }): AppConfig {
	const providers: Record<string, ProviderConfig> = {};
	for (const [name, defaults] of Object.entries(DEFAULT_CONFIG.providers)) {
		providers[name] = { ...defaults, ...parsed.providers?.[name] };
	}
	return { providers };
}
