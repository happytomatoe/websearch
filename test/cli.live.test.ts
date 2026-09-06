import { test, expect } from "bun:test";

// Live integration test: spawns the real CLI and hits the real MCP endpoints.
// Skipped unless LIVE=1, so the default `bun test` stays offline and deterministic.
const live = !!process.env.LIVE;

test.skipIf(!live)(
	"live CLI run renders Exa/Parallel sections (or provider errors) and Tavily as section or error line",
	async () => {
		const proc = Bun.spawn(["bun", "run", "src/cli.ts", "rust async"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		// Keyless rate limits can legitimately fail Exa/Parallel; accept either
		// a full section or a provider-error line for each.
		const hasExaSection = /^## Exa$/m.test(stdout);
		const hasExaError = /^- \*\*Exa:\*\*/m.test(stdout);
		expect(hasExaSection || hasExaError).toBe(true);
		const hasParallelSection = /^## Parallel$/m.test(stdout);
		const hasParallelError = /^- \*\*Parallel:\*\*/m.test(stdout);
		expect(hasParallelSection || hasParallelError).toBe(true);
		// Tavily's keyless budget is shared per IP; when it is spent the provider
		// is reported under "## Provider errors" instead of its own section.
		const hasTavilySection = /^## Tavily$/m.test(stdout);
		const hasTavilyError = /^- \*\*Tavily:\*\*/m.test(stdout);
		expect(hasTavilySection || hasTavilyError).toBe(true);
		// Firecrawl's keyless budget (1,000/month) is shared per IP; same escape hatch.
		const hasFirecrawlSection = /^## Firecrawl$/m.test(stdout);
		const hasFirecrawlError = /^- \*\*Firecrawl:\*\*/m.test(stdout);
		expect(hasFirecrawlSection || hasFirecrawlError).toBe(true);
		expect(stdout.indexOf("## Exa") !== -1 ? stdout.indexOf("## Exa") : stdout.length).toBeLessThanOrEqual(
			stdout.indexOf("## Parallel") !== -1 ? stdout.indexOf("## Parallel") : stdout.length,
		);
		// Two blank lines separate provider sections when both render.
		if (hasExaSection && hasParallelSection) {
			expect(stdout).toMatch(/## Exa[\s\S]*?\n\n\n## Parallel/);
		}
		expect(stdout).toContain("**Sources:**");
	},
	120_000,
);