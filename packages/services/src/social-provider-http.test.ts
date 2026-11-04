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
	test("bounds every request with a timeout unless the caller brings its own signal", async () => {
		const seen: Array<AbortSignal | null | undefined> = [];
		const transport = (async (_url, init) => {
			seen.push(init?.signal);
			return Response.json({});
		}) as typeof fetch;
		await fetchSocialProvider("https://graph.facebook.com/v24.0/me", {}, transport);
		const own = new AbortController();
		await fetchSocialProvider("https://graph.facebook.com/v24.0/me", { signal: own.signal }, transport);
		expect(seen[0]).toBeInstanceOf(AbortSignal);
		expect(seen[0]).not.toBe(own.signal);
		expect(seen[1]).toBe(own.signal);
	});
});
