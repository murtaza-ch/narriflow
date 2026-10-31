import { fetchSocialProvider } from "@narriflow/services/social-provider-http";
export default {
	async fetch(
		_request: Request,
		environment: { FIXTURE_PROVIDER_ORIGIN: string },
	) {
		const origin = new URL(environment.FIXTURE_PROVIDER_ORIGIN);
		if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
			throw Error("Invalid local provider fixture");
		try {
			await fetchSocialProvider(
				"https://www.googleapis.com/youtube/v3/videos",
				{ headers: { Authorization: "Bearer isolated-fixture" } },
				((_, init) =>
					fetch(new URL("/redirect", origin), init)) as typeof fetch,
			);
			return Response.json({ code: "unexpected_follow" }, { status: 500 });
		} catch (error) {
			return Response.json({
				code:
					(error as { code?: string }).code ?? "unclassified_transport_failure",
			});
		}
	},
};
