import { describe, test, expect } from "bun:test";
import { fetchSocialProvider } from "./social-provider-http";
describe("Worker social provider transport", () => {
	test("uses manual and cancels a 3xx without following its credential-bearing request", async () => {
		let calls = 0,
			cancelled = false;
		await expect(
			fetchSocialProvider(
				"https://www.googleapis.com/youtube/v3/videos",
				{ headers: { Authorization: "Bearer private-fixture" } },
				(async (_url, init) => {
					calls++;
					expect(init?.redirect).toBe("manual");
					expect(new Headers(init?.headers).get("authorization")).toBe(
						"Bearer private-fixture",
					);
					return new Response(
						new ReadableStream({
							cancel() {
								cancelled = true;
							},
						}),
						{
							status: 302,
							headers: { location: "https://foreign.invalid/private" },
						},
					);
				}) as typeof fetch,
			),
		).rejects.toMatchObject({ code: "social_provider_redirect" });
		expect(calls).toBe(1);
		expect(cancelled).toBe(true);
	});
	test("refuses foreign/userinfo/nonstandard-port targets before transport", async () => {
		let calls = 0;
		const transport = (async () => {
			calls++;
			return Response.json({});
		}) as typeof fetch;
		for (const url of [
			"https://foreign.invalid/",
			"https://secret@www.googleapis.com/",
			"https://www.googleapis.com:444/",
			"http://www.googleapis.com/",
		])
			await expect(
				fetchSocialProvider(url, {}, transport),
			).rejects.toMatchObject({ code: "social_provider_origin_invalid" });
		expect(calls).toBe(0);
	});
});
