const SOCIAL_PROVIDER_ORIGINS = new Set([
	"https://open.tiktokapis.com",
	"https://oauth2.googleapis.com",
	"https://www.googleapis.com",
	"https://openidconnect.googleapis.com",
	"https://graph.facebook.com",
	"https://graph.instagram.com",
	"https://api.instagram.com",
	"https://www.linkedin.com",
	"https://api.linkedin.com",
	"https://api.x.com",
	"https://api.twitter.com",
]);
export class SocialProviderTransportError extends Error {
	constructor(
		readonly code:
			| "social_provider_origin_invalid"
			| "social_provider_redirect",
	) {
		super(code);
		this.name = "SocialProviderTransportError";
	}
}
/** Workers accepts manual redirects; its global fetch rejects redirect:error.
 * The fixed provider allowlist and explicit 3xx refusal keep credentials on the
 * selected origin, with no follow-up request or response-body retention. */
export async function fetchSocialProvider(
	input: string | URL | Request,
	init?: RequestInit,
	transport: typeof fetch = fetch,
): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (
		!SOCIAL_PROVIDER_ORIGINS.has(url.origin) ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new SocialProviderTransportError("social_provider_origin_invalid");
	const response = await transport(input, { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		throw new SocialProviderTransportError("social_provider_redirect");
	}
	return response;
}
