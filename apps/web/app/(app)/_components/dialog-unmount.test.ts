import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The dialogs need a DOM, so they run in the repo's happy-dom fixture subprocess, which keeps browser globals out of this process.
test("dialogs that mount already open leave the page clickable after they close", async () => {
	const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/_components/dialog-unmount.browser.fixture.tsx"], {
		cwd: resolve(import.meta.dir, "../../../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
	expect(exitCode).toBe(0);
}, 30_000);
