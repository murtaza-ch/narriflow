import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ApiError } from "@narriflow/api-client";
import { browserFailureFromApiError } from "@/lib/publishing-client";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
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

test("a refused publishing request keeps its plan details for the upgrade dialog", () => {
	const error = new ApiError({
		code: "plan_feature_required",
		message: "Scheduling needs the Creator plan.",
		status: 402,
		details: { currentTier: "free", requiredTier: "creator", feature: "publishing.schedule" },
	});
	expect(upgradePromptFromFailure(browserFailureFromApiError(error))).toMatchObject({ tier: "creator" });
});
