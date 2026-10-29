import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("a clip preview renews an expired grant without swapping under a playing clip", async () => {
	// The fixture installs DOM globals, so it runs in its own process.
	const child = Bun.spawn(
		["bun", "test", "./apps/web/app/(app)/projects/[projectId]/clip-video.browser.fixture.tsx"],
		{ cwd: resolve(import.meta.dir, "../../../../../.."), stdout: "pipe", stderr: "pipe" },
	);
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`${out}\n${err}`);
	expect(code).toBe(0);
}, 30000);
