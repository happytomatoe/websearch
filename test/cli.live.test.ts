import { test, expect } from "bun:test";

// Live integration test: spawns the real CLI and hits the real MCP endpoints.
// Skipped unless LIVE=1, so the default `bun test` stays offline and deterministic.
const live = !!process.env.LIVE;

test.skipIf(!live)(
	"live CLI run shows ## Exa and ## Parallel sections",
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
		expect(stdout).toMatch(/^## Exa$/m);
		expect(stdout).toMatch(/^## Parallel$/m);
		expect(stdout.indexOf("## Exa")).toBeLessThan(stdout.indexOf("## Parallel"));
		expect(stdout).toContain("\n\n\n## Parallel");
		expect(stdout).toContain("**Sources:**");
	},
	120_000,
);