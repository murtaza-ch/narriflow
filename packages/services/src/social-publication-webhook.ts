import { createHmac } from "node:crypto";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { connect as connectTcp } from "node:net";
import { Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { socialPostMetricsSchema } from "@narriflow/validators";
import type {
	PublicationPlatform,
	PublicationPlatformContext,
	PublicationPlatformInput,
	PublicationPlatformResult,
	PublicationProviderOperation,
} from "./social-publication-platform";

export type PublicationWebhookConfig = {
	url: string;
	signingSecret: string;
	deadlineMs: number;
	maxResponseBytes: number;
	redirectPolicy: "error";
	reconciliationMaxMs: number;
};

export type PublicationWebhookRequest = {
	url: string;
	method: "POST" | "GET";
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
	redirect: "error";
	maxResponseBytes: number;
};

export interface PublicationWebhookTransport {
	send(
		request: PublicationWebhookRequest,
		context: { onRequestCommitted(): Promise<void> },
	): Promise<Response>;
}

export type PublicationWebhookMedia = {
	createScopedAccess(input: {
		storageKey: string;
		fileName: string;
		sizeBytes: number;
		expiresInSeconds: number;
	}): Promise<{ url: string; expiresAt: Date }>;
};

function hmac(secret: string, body: string) {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function retryAfterMs(response: Response, now: Date): number | null {
	const raw = response.headers.get("retry-after");
	if (!raw) return null;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.round(seconds * 1000);
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
}

async function readBoundedText(response: Response, maximumBytes: number) {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
		throw new Error("publication_webhook_response_oversized");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maximumBytes) {
				await reader.cancel();
				throw new Error("publication_webhook_response_oversized");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeExternalUrl(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

function safeReconciliationUrl(
	value: unknown,
	receiverUrl: string,
): URL | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		const receiver = new URL(receiverUrl);
		return url.protocol === "https:" &&
			url.origin === receiver.origin &&
			!url.username &&
			!url.password &&
			!url.hash
			? url
			: null;
	} catch {
		return null;
	}
}

function parseReceiverResult(
	response: Response,
	parsed: unknown,
	now: Date,
	config: PublicationWebhookConfig,
): PublicationPlatformResult {
	const body = object(parsed);
	const status = nonEmptyString(body?.status);
	if (status === "accepted" && response.ok) {
		const receipt = object(body?.receipt);
		const receiptId = nonEmptyString(receipt?.id);
		if (!receiptId) {
			return {
				kind: "unknown",
				code: "publication_webhook_response_invalid",
				phase: "submission",
				operation: null,
			};
		}
		const metrics = socialPostMetricsSchema.safeParse(receipt?.metrics);
		return {
			kind: "accepted",
			receipt: {
				receiptId,
				platformPostId: nonEmptyString(receipt?.externalPostId),
				externalUrl: safeExternalUrl(receipt?.externalUrl),
				metrics: metrics.success ? metrics.data : null,
			},
		};
	}
	if (status === "pending" && response.ok) {
		const receipt = object(body?.receipt);
		const reconciliation = object(body?.reconciliation);
		const receiptId = nonEmptyString(receipt?.id);
		const token = nonEmptyString(reconciliation?.token);
		const seconds = Number(body?.nextCheckAfterSeconds);
		const url = safeReconciliationUrl(reconciliation?.url, config.url);
		if (
			!receiptId ||
			!token ||
			!url ||
			!Number.isFinite(seconds) ||
			seconds < 1 ||
			seconds * 1000 > config.reconciliationMaxMs
		) {
			return {
				kind: "unknown",
				code: "publication_webhook_response_invalid",
				phase: "submission",
				operation: null,
			};
		}
		return {
			kind: "pending",
			receiptId,
			operation: {
				kind: "publication_webhook_reconciliation",
				state: {
					receiptId,
					url: url.toString(),
					token,
					deadline: new Date(
						now.getTime() + config.reconciliationMaxMs,
					).toISOString(),
				},
			},
			nextCheckAt: new Date(now.getTime() + seconds * 1000),
		};
	}
	if (status === "failed") {
		const code = nonEmptyString(body?.code);
		const disposition = body?.disposition;
		if (
			code &&
			/^[a-z0-9_]{3,120}$/.test(code) &&
			(disposition === "safe_retry" ||
				disposition === "permanent" ||
				disposition === "attention")
		) {
			return {
				kind: "failed",
				failure: {
					code,
					phase: "submission",
					disposition,
					retryAfterMs:
						disposition === "safe_retry" ? retryAfterMs(response, now) : null,
				},
			};
		}
	}
	if (status === "unknown" && response.ok) {
		return {
			kind: "unknown",
			code:
				nonEmptyString(body?.code) ?? "publication_webhook_receiver_unknown",
			phase: "submission",
			operation: null,
		};
	}
	return {
		kind: "unknown",
		code: "publication_webhook_response_invalid",
		phase: "submission",
		operation: null,
	};
}

async function receiverResponse(
	response: Response,
	config: PublicationWebhookConfig,
	now: Date,
) {
	try {
		const text = await readBoundedText(response, config.maxResponseBytes);
		const parsed = text ? JSON.parse(text) : null;
		return parseReceiverResult(response, parsed, now, config);
	} catch (error) {
		return {
			kind: "unknown" as const,
			code:
				error instanceof Error &&
				error.message === "publication_webhook_response_oversized"
					? "publication_webhook_response_oversized"
					: "publication_webhook_response_invalid",
			phase: "submission" as const,
			operation: null,
		};
	}
}

export function createFetchPublicationWebhookTransport(): PublicationWebhookTransport {
	return {
		async send(request, context) {
			return new Promise<Response>((resolve, reject) => {
				const url = new URL(request.url);
				const tls = url.protocol === "https:";
				let outbound: ReturnType<typeof requestHttp> | null = null;
				let settled = false;
				const socket = tls
					? connectTls({
							host: url.hostname,
							port: Number(url.port || 443),
							servername: url.hostname,
						})
					: connectTcp({
							host: url.hostname,
							port: Number(url.port || 80),
						});
				const fail = (error: Error) => {
					if (settled) return;
					settled = true;
					reject(error);
				};
				const abort = () => {
					const error = new DOMException("Aborted", "AbortError");
					outbound?.destroy(error);
					socket.destroy(error);
				};
				socket.once("error", fail);
				request.signal.addEventListener("abort", abort, { once: true });
				if (request.signal.aborted) abort();
				socket.once(tls ? "secureConnect" : "connect", async () => {
					try {
						await context.onRequestCommitted();
					} catch (error) {
						socket.destroy();
						fail(error instanceof Error ? error : new Error(String(error)));
						return;
					}
					if (request.signal.aborted) return;
					const start = tls ? requestHttps : requestHttp;
					outbound = start(
						{
							protocol: url.protocol,
							hostname: url.hostname,
							port: url.port || (tls ? 443 : 80),
							path: `${url.pathname}${url.search}`,
							method: request.method,
							headers: request.headers,
							agent: false,
							createConnection: () => socket,
						},
						(incoming) => {
						const headers = new Headers();
						for (const [name, value] of Object.entries(incoming.headers)) {
							if (Array.isArray(value)) {
								for (const entry of value) headers.append(name, entry);
							} else if (value !== undefined) {
								headers.set(name, value);
							}
						}
						const status = incoming.statusCode ?? 502;
						const body =
							status === 204 || status === 304
								? null
								: (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
							settled = true;
							incoming.once("close", () =>
								request.signal.removeEventListener("abort", abort),
							);
							resolve(new Response(body, { status, headers }));
						},
					);
					outbound.once("error", fail);
					outbound.end(request.method === "POST" ? request.body : undefined);
				});
			});
		},
	};
}

function deadlineSignal(signal: AbortSignal, deadlineMs: number) {
	return AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
}

export function createPublicationWebhookPlatform(dependencies: {
	config: PublicationWebhookConfig;
	transport: PublicationWebhookTransport;
	media: PublicationWebhookMedia;
	clock: { now(): Date };
}): PublicationPlatform {
	async function send(
		request: Omit<
			PublicationWebhookRequest,
			"signal" | "redirect" | "maxResponseBytes"
		>,
		context: PublicationPlatformContext,
		checkpoint: PublicationProviderOperation,
	) {
		let committed = false;
		try {
			await context.providerCall?.();
			const response = await dependencies.transport.send(
				{
					...request,
					signal: deadlineSignal(
						context.signal,
						dependencies.config.deadlineMs,
					),
					redirect: dependencies.config.redirectPolicy,
					maxResponseBytes: dependencies.config.maxResponseBytes,
				},
				{
					onRequestCommitted: async () => {
						if (committed) return;
						await context.checkpoint(checkpoint);
						committed = true;
					},
				},
			);
			return receiverResponse(
				response,
				dependencies.config,
				dependencies.clock.now(),
			);
		} catch (error) {
			if (
				error !== null &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "publication_provider_call_budget_exhausted"
			) {
				throw error;
			}
			return committed
				? {
						kind: "unknown" as const,
						code: "publication_webhook_response_lost",
						phase: "submission" as const,
						operation: checkpoint,
					}
				: {
						kind: "failed" as const,
						failure: {
							code: "publication_webhook_transport_unavailable",
							phase: "submission" as const,
							disposition: "safe_retry" as const,
							retryAfterMs: null,
						},
					};
		}
	}

	return {
		capabilities: {
			recovery: "exact",
			asynchronous: true,
			idempotency: "narriflow",
			requiredScopes: [],
			apiVersion: "publication-webhook-v1",
			maxProviderCalls: 20,
		},

		async publish(input: PublicationPlatformInput, context) {
			const scoped = await dependencies.media.createScopedAccess({
				storageKey: input.media.storageKey,
				fileName: input.media.fileName,
				sizeBytes: input.media.sizeBytes,
				expiresInSeconds:
					Math.ceil(dependencies.config.deadlineMs / 1000) + 900,
			});
			const payload = {
				contractVersion: 1,
				event: "social.post.publish",
				attemptId: input.attemptId,
				idempotencyKey: input.idempotencyKey,
				socialPostId: input.socialPostId,
				projectId: input.projectId,
				platform: input.platform,
				caption: input.caption,
				scheduledFor: input.scheduledFor.toISOString(),
				providerSettings: input.providerSettings,
				media: {
					url: scoped.url,
					expiresAt: scoped.expiresAt.toISOString(),
					contentType: input.media.contentType,
					fileName: input.media.fileName,
					byteLength: input.media.sizeBytes,
					aspectRatio: input.media.aspectRatio,
				},
			};
			const body = JSON.stringify(payload);
			const operation: PublicationProviderOperation = {
				kind: "submission_started",
				state: {
					receiverUrl: dependencies.config.url,
					attemptId: input.attemptId,
					idempotencyKey: input.idempotencyKey,
				},
			};
			return send(
				{
					url: dependencies.config.url,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "Narriflow-SocialPublisher/2.0",
						"Idempotency-Key": input.idempotencyKey,
						"X-Narriflow-Attempt-Id": input.attemptId,
						"X-Narriflow-Signature": hmac(
							dependencies.config.signingSecret,
							body,
						),
					},
					body,
				},
				context,
				operation,
			);
		},

		async reconcile(input, operation, context) {
			if (operation.kind === "submission_started") {
				return this.publish(input, context);
			}
			if (operation.kind !== "publication_webhook_reconciliation") {
				return {
					kind: "unknown",
					code: "publication_webhook_reconciliation_invalid",
					phase: "reconciliation",
					operation: null,
				};
			}
			const url = nonEmptyString(operation.state.url);
			const token = nonEmptyString(operation.state.token);
			const deadline = Date.parse(String(operation.state.deadline ?? ""));
			if (
				!url ||
				!token ||
				!Number.isFinite(deadline) ||
				deadline <= dependencies.clock.now().getTime()
			) {
				return {
					kind: "unknown",
					code: "publication_webhook_reconciliation_expired",
					phase: "reconciliation",
					operation: null,
				};
			}
			return send(
				{
					url,
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${token}`,
						"Idempotency-Key": input.idempotencyKey,
						"X-Narriflow-Attempt-Id": input.attemptId,
					},
					body: "",
				},
				context,
				operation,
			);
		},
	};
}
