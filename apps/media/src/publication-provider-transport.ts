import { guardedFetch } from "./outbound-transport";
import type { PublicationNativeCommand } from "@narriflow/validators/publication-execution";
import type { SocialPlatform } from "@narriflow/validators";
const origins: Record<SocialPlatform, (host: string) => boolean> = {
	youtube_shorts: (h) =>
		[
			"www.googleapis.com",
			"youtube.googleapis.com",
			"upload.youtube.com",
			"www.youtube.com",
		].includes(h),
	instagram_reels: (h) =>
		[
			"graph.facebook.com",
			"graph-video.facebook.com",
			"rupload.facebook.com",
		].includes(h) || h.endsWith(".fbcdn.net"),
	facebook_reels: (h) =>
		[
			"graph.facebook.com",
			"graph-video.facebook.com",
			"rupload.facebook.com",
		].includes(h) || h.endsWith(".fbcdn.net"),
	tiktok: (h) =>
		h === "open.tiktokapis.com" ||
		h.endsWith(".tiktokapis.com") ||
		h.endsWith(".tiktokcdn.com"),
	linkedin: (h) =>
		["api.linkedin.com", "www.linkedin.com"].includes(h) ||
		h.endsWith(".licdn.com"),
	x: (h) => ["api.x.com", "api.twitter.com", "upload.twitter.com"].includes(h),
};
export function classifyPublicationRequest(
	platform: SocialPlatform,
	url: URL,
	method: string,
	body: BodyInit | null | undefined,
	headers?: HeadersInit,
): Extract<PublicationNativeCommand, { kind: "provider_call" }> {
	const purpose =
		url.pathname.includes("thumbnails") || url.pathname.includes("images")
			? "thumbnail"
			: "primary_media";
	if (
		platform === "tiktok" &&
		method === "POST" &&
		/\/(?:status\/fetch|creator_info\/query)\/$/.test(url.pathname)
	)
		return { kind: "provider_call", operation: "read", purpose };
	if (
		platform === "youtube_shorts" &&
		method === "PUT" &&
		(body === undefined ||
			body === null ||
			body === "" ||
			(body instanceof Blob && body.size === 0) ||
			(body instanceof Uint8Array && body.byteLength === 0)) &&
		/^bytes \*\/[1-9][0-9]*$/.test(
			new Headers(headers).get("content-range") ?? "",
		)
	)
		return { kind: "provider_call", operation: "read", purpose };
	if (method === "GET" || method === "HEAD")
		return { kind: "provider_call", operation: "read", purpose };
	if (method === "DELETE")
		return { kind: "provider_call", operation: "cleanup", purpose };
	const text =
		typeof body === "string"
			? body
			: body instanceof URLSearchParams
				? body.toString()
				: "";
	const action =
		url.searchParams.get("action") ?? url.searchParams.get("command");
	if (
		action === "initializeUpload" ||
		action === "INIT" ||
		/\/initialize(?:\/|$)/.test(url.pathname) ||
		(platform === "youtube_shorts" &&
			method === "POST" &&
			url.searchParams.get("uploadType") === "resumable") ||
		(platform === "tiktok" && url.pathname.endsWith("/init/")) ||
		(platform === "facebook_reels" && /upload_phase[=":]+start/.test(text)) ||
		(platform === "instagram_reels" &&
			method === "POST" &&
			url.pathname.endsWith("/media"))
	)
		return { kind: "provider_call", operation: "initialize", purpose };
	if (
		url.pathname.endsWith("/tweets") ||
		url.pathname.endsWith("/posts") ||
		url.pathname.endsWith("/media_publish") ||
		(platform === "facebook_reels" && /upload_phase[=":]+finish/.test(text))
	)
		return { kind: "provider_call", operation: "submit", purpose };
	return { kind: "provider_call", operation: "upload", purpose };
}
/** The adapter owns actual-call accounting. Context.providerCall remains local
 * pacing metadata; every socket request gets a fresh Worker decision here. */
export function createPublicationProviderTransport(options: {
	platform: SocialPlatform;
	command(command: PublicationNativeCommand): Promise<unknown>;
	fetch?: typeof fetch;
}) {
	let lastStatus: number | null = null;
	return {
		get lastStatus() {
			return lastStatus;
		},
		fetch: (async (raw: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(raw, init),
				url = new URL(request.url);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.hash ||
				(url.port && url.port !== "443") ||
				!origins[options.platform](url.hostname)
			)
				throw Error("publication_provider_origin_invalid");
			const method = request.method.toUpperCase();
			if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method))
				throw Error("publication_provider_method_invalid");
			const decision = await options.command(
				classifyPublicationRequest(
					options.platform,
					url,
					method,
					init?.body,
					request.headers,
				),
			);
			if (
				!decision ||
				typeof decision !== "object" ||
				!("kind" in decision) ||
				decision.kind !== "recorded"
			)
				throw Error("publication_provider_authority_lost");
			lastStatus = null;
			let body: string | Uint8Array | Blob | undefined;
			if (
				init?.body instanceof Blob ||
				typeof init?.body === "string" ||
				init?.body instanceof Uint8Array
			)
				body = init.body;
			else if (init?.body instanceof URLSearchParams)
				body = init.body.toString();
			else if (init?.body instanceof FormData) body = await request.blob();
			else if (
				(init?.body !== undefined && init.body !== null) ||
				(raw instanceof Request && raw.body)
			)
				throw Error("publication_provider_body_invalid");
			const response = options.fetch
				? await options.fetch(raw, { ...init, redirect: "error" })
				: await guardedFetch(url, {
						method: method as "GET" | "POST" | "PUT" | "DELETE",
						headers: request.headers,
						body,
						signal: request.signal,
						maxRedirects: 0,
						timeoutMs: 120000,
					});
			lastStatus = response.status;
			if (!response.body) return response;
			const maximum = 16 * 1024 ** 2,
				reader = response.body.getReader();
			let length = 0;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const item = await reader.read();
						if (item.done) {
							reader.releaseLock();
							controller.close();
							return;
						}
						length += item.value.byteLength;
						if (length > maximum) {
							await reader.cancel();
							throw Error("publication_provider_response_oversized");
						}
						controller.enqueue(item.value);
					} catch (error) {
						controller.error(error);
					}
				},
				async cancel(reason) {
					await reader.cancel(reason);
				},
			});
			return new Response(stream, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}) as typeof fetch,
	};
}
