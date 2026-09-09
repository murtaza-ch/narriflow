import { expect, test } from "bun:test";
import { resolve } from "node:path";
test("publishing drawer interactions", async () => {
	const child = Bun.spawn(
		[
			"bun",
			"test",
			"./apps/web/app/(app)/projects/[projectId]/publishing.browser.fixture.tsx",
		],
		{
			cwd: resolve(import.meta.dir, "../../../../../.."),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`${out}\n${err}`);
	expect(code).toBe(0);
}, 30000);
