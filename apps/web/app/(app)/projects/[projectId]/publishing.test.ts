import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { PublishingRequestError, publishingRequest } from "./publishing-draft";
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

test("a refused publishing request keeps its plan details for the upgrade dialog", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				error: "plan_feature_required",
				message: "Scheduling needs the Creator plan.",
				details: {
					currentTier: "free",
					requiredTier: "creator",
					feature: "publishing.schedule",
				},
			}),
			{ status: 402 },
		)) as unknown as typeof fetch;
	try {
		const error = await publishingRequest("/api/x", {}).catch((e) => e);
		expect(error).toBeInstanceOf(PublishingRequestError);
		expect(error.status).toBe(402);
		expect(error.code).toBe("plan_feature_required");
		expect(upgradePromptFromFailure(error.failure)).toMatchObject({ tier: "creator" });
	} finally {
		globalThis.fetch = realFetch;
	}
});
