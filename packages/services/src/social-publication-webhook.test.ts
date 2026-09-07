import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, test } from "bun:test";
import {
	createFetchPublicationWebhookTransport,
	createPublicationWebhookPlatform,
	type PublicationWebhookRequest,
	type PublicationWebhookTransport,
} from "./social-publication-webhook";

const input = {
	attemptId: "attempt-1",
	idempotencyKey: "publication-attempt-1",
	socialPostId: "post-1",
	projectId: "project-1",
	platform: "youtube_shorts" as const,
	caption: "Approved caption",
	scheduledFor: new Date("2026-08-28T10:00:00.000Z"),
	providerSettings: { privacy: "public" },
	account: null,
	media: {
		storageKey: "private/export.mp4",
		fileName: "export.mp4",
		contentType: "video/mp4" as const,
		sizeBytes: 1024,
		aspectRatio: "9:16" as const,
	},
};

function response(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
) {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function createHarness(
	responses: Response[],
	transportOverride?: PublicationWebhookTransport,
) {
	const requests: PublicationWebhookRequest[] = [];
	const transport: PublicationWebhookTransport = {
		async send(request, context) {
			requests.push(request);
			await context.onRequestCommitted();
			return responses.shift() ?? response({}, 500);
		},
	};
	const platform = createPublicationWebhookPlatform({
		config: {
			url: "https://receiver.example/narriflow",
			signingSecret: "test-webhook-secret-with-at-least-32-characters",
			deadlineMs: 10_000,
			maxResponseBytes: 65_536,
			redirectPolicy: "error",
			reconciliationMaxMs: 3_600_000,
		},
		transport: transportOverride ?? transport,
		media: {
			createScopedAccess: async () => ({
				url: "https://media.example/scoped/export.mp4?grant=short",
				expiresAt: new Date("2026-08-28T10:15:00.000Z"),
			}),
		},
		clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
	});
	return { platform, requests };
}

describe("publication webhook contract", () => {
	test("the production transport checkpoints only after connection and before request bytes", async () => {
		const transport = createFetchPublicationWebhookTransport();
		const probe = createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const probeAddress = probe.address();
		if (!probeAddress || typeof probeAddress === "string") {
			throw new Error("expected TCP probe address");
		}
		await new Promise<void>((resolve, reject) =>
			probe.close((error) => (error ? reject(error) : resolve())),
		);

		let preConnectCommitted = false;
		await expect(
			transport.send(
				{
					url: `http://127.0.0.1:${probeAddress.port}/publish`,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: '{"attempt":"before-connect"}',
					signal: AbortSignal.timeout(2_000),
					redirect: "error",
					maxResponseBytes: 65_536,
				},
				{
					onRequestCommitted: async () => {
						preConnectCommitted = true;
					},
				},
			),
		).rejects.toBeDefined();
		expect(preConnectCommitted).toBe(false);

		const received: string[] = [];
		const receiver = createServer((incoming) => {
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk) => received.push(String(chunk)));
			incoming.on("end", () => incoming.socket.destroy());
		});
		receiver.listen(0, "127.0.0.1");
		await once(receiver, "listening");
		const receiverAddress = receiver.address();
		if (!receiverAddress || typeof receiverAddress === "string") {
			throw new Error("expected receiver address");
		}
		let connectedCommitted = false;
		try {
			await expect(
				transport.send(
					{
						url: `http://127.0.0.1:${receiverAddress.port}/publish`,
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": String('{"attempt":"connected"}'.length),
						},
						body: '{"attempt":"connected"}',
						signal: AbortSignal.timeout(2_000),
						redirect: "error",
						maxResponseBytes: 65_536,
					},
					{
						onRequestCommitted: async () => {
							connectedCommitted = true;
						},
					},
				),
			).rejects.toBeDefined();
		} finally {
			receiver.closeAllConnections();
			if (receiver.listening) {
				await new Promise<void>((resolve, reject) =>
					receiver.close((error) => (error ? reject(error) : resolve())),
				);
			}
		}
		expect(connectedCommitted).toBe(true);
		expect(received.join("")).toBe('{"attempt":"connected"}');
	}, 10_000);

	test("signs intended content and normalizes an accepted durable receipt", async () => {
		const { platform, requests } = createHarness([
			response({
				status: "accepted",
				receipt: {
					id: "receiver-operation-1",
					externalPostId: "receiver-post-1",
					externalUrl: "https://receiver.example/posts/1",
					metrics: { views: 10, likes: 2, comments: 0, shares: 0, saves: 0 },
				},
			}),
		]);
		const checkpoints: string[] = [];

		await expect(
			platform.publish(input, {
				signal: new AbortController().signal,
				checkpoint: async (checkpoint) => checkpoints.push(checkpoint.kind),
			}),
		).resolves.toEqual({
			kind: "accepted",
			receipt: {
				receiptId: "receiver-operation-1",
				platformPostId: "receiver-post-1",
				externalUrl: "https://receiver.example/posts/1",
				metrics: {
					views: 10,
					likes: 2,
					comments: 0,
					shares: 0,
					saves: 0,
				},
			},
		});
		expect(checkpoints).toEqual(["submission_started"]);
		expect(requests).toHaveLength(1);
		const sent = requests[0]!;
		expect(sent.headers["Idempotency-Key"]).toBe("publication-attempt-1");
		expect(sent.headers["X-Narriflow-Attempt-Id"]).toBe("attempt-1");
		expect(sent.headers["X-Narriflow-Signature"]).toBe(
			`sha256=${createHmac(
				"sha256",
				"test-webhook-secret-with-at-least-32-characters",
			)
				.update(sent.body)
				.digest("hex")}`,
		);
		const payload = JSON.parse(sent.body);
		expect(payload).toMatchObject({
			attemptId: "attempt-1",
			idempotencyKey: "publication-attempt-1",
			socialPostId: "post-1",
			platform: "youtube_shorts",
			caption: "Approved caption",
			media: {
				url: "https://media.example/scoped/export.mp4?grant=short",
				byteLength: 1024,
			},
		});
		expect(sent.body).not.toContain("private/export.mp4");
	});

	test("treats bare 2xx and conflicting or malformed receipts as unknown", async () => {
		for (const body of ["", { status: "accepted" }, { ok: true }]) {
			const { platform } = createHarness([response(body)]);
			await expect(
				platform.publish(input, {
					signal: new AbortController().signal,
					checkpoint: async () => undefined,
				}),
			).resolves.toMatchObject({
				kind: "unknown",
				code: "publication_webhook_response_invalid",
				phase: "submission",
			});
		}
	});

	test("stores authenticated pending evidence and reconciles the same operation", async () => {
		const { platform, requests } = createHarness([
			response({
				status: "pending",
				receipt: { id: "receiver-operation-1" },
				nextCheckAfterSeconds: 30,
				reconciliation: {
					url: "https://receiver.example/narriflow/operations/1",
					token: "receiver-reconciliation-token",
				},
			}),
			response({
				status: "accepted",
				receipt: { id: "receiver-operation-1", externalPostId: "post-1" },
			}),
		]);

		const pending = await platform.publish(input, {
			signal: new AbortController().signal,
			checkpoint: async () => undefined,
		});
		expect(pending).toMatchObject({
			kind: "pending",
			receiptId: "receiver-operation-1",
			operation: { kind: "publication_webhook_reconciliation" },
			nextCheckAt: new Date("2026-08-28T10:00:30.000Z"),
		});
		if (pending.kind !== "pending") throw new Error("expected pending");

		await expect(
			platform.reconcile!(input, pending.operation, {
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			}),
		).resolves.toMatchObject({
			kind: "accepted",
			receipt: { receiptId: "receiver-operation-1", platformPostId: "post-1" },
		});
		expect(requests[1]).toMatchObject({
			method: "GET",
			url: "https://receiver.example/narriflow/operations/1",
			headers: { Authorization: "Bearer receiver-reconciliation-token" },
		});
	});

	test("rejects a reconciliation URL outside the configured receiver origin", async () => {
		const { platform, requests } = createHarness([
			response({
				status: "pending",
				receipt: { id: "receiver-operation-ssrf" },
				nextCheckAfterSeconds: 30,
				reconciliation: {
					url: "https://169.254.169.254/latest/meta-data",
					token: "receiver-reconciliation-token",
				},
			}),
		]);

		await expect(
			platform.publish(input, {
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			}),
		).resolves.toMatchObject({
			kind: "unknown",
			code: "publication_webhook_response_invalid",
		});
		expect(requests).toHaveLength(1);
	});

	test("preserves Retry-After only when the receiver definitively rejected before acceptance", async () => {
		const { platform } = createHarness([
			response(
				{
					status: "failed",
					code: "receiver_busy",
					disposition: "safe_retry",
				},
				429,
				{ "Retry-After": "120" },
			),
		]);

		await expect(
			platform.publish(input, {
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			}),
		).resolves.toEqual({
			kind: "failed",
			failure: {
				code: "receiver_busy",
				phase: "submission",
				disposition: "safe_retry",
				retryAfterMs: 120_000,
			},
		});
	});

	test("distinguishes failure before request commitment from a lost response", async () => {
		const beforeCommit: PublicationWebhookTransport = {
			async send() {
				throw new Error("connection refused");
			},
		};
		const afterCommit: PublicationWebhookTransport = {
			async send(_request, context) {
				await context.onRequestCommitted();
				throw new Error("connection reset after body");
			},
		};

		await expect(
			createHarness([], beforeCommit).platform.publish(input, {
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			}),
		).resolves.toEqual({
			kind: "failed",
			failure: {
				code: "publication_webhook_transport_unavailable",
				phase: "submission",
				disposition: "safe_retry",
				retryAfterMs: null,
			},
		});
		await expect(
			createHarness([], afterCommit).platform.publish(input, {
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			}),
		).resolves.toMatchObject({
			kind: "unknown",
			code: "publication_webhook_response_lost",
			operation: { kind: "submission_started" },
		});
	});

	test("rejects oversized, redirected, authentication, and server responses as acceptance evidence", async () => {
		const cases = [
			{
				response: new Response("x".repeat(65_537), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
				code: "publication_webhook_response_oversized",
			},
			{
				response: response({ status: "accepted", receipt: { id: "r" } }, 302),
				code: "publication_webhook_response_invalid",
			},
			{
				response: response({ error: "unauthorized" }, 401),
				code: "publication_webhook_response_invalid",
			},
			{
				response: response({ error: "unavailable" }, 503),
				code: "publication_webhook_response_invalid",
			},
		];
		for (const scenario of cases) {
			const { platform } = createHarness([scenario.response]);
			await expect(
				platform.publish(input, {
					signal: new AbortController().signal,
					checkpoint: async () => undefined,
				}),
			).resolves.toMatchObject({ kind: "unknown", code: scenario.code });
		}
	});

	test("replays a checkpointed submission with the identical key and intended bytes", async () => {
		const { platform, requests } = createHarness([
			response({ status: "accepted", receipt: { id: "operation-1" } }),
		]);
		const operation = {
			kind: "submission_started",
			state: {
				receiverUrl: "https://receiver.example/narriflow",
				attemptId: input.attemptId,
				idempotencyKey: input.idempotencyKey,
			},
		};
		await platform.reconcile!(input, operation, {
			signal: new AbortController().signal,
			checkpoint: async () => undefined,
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]!.headers["Idempotency-Key"]).toBe(input.idempotencyKey);
		expect(JSON.parse(requests[0]!.body)).toMatchObject({
			attemptId: input.attemptId,
			idempotencyKey: input.idempotencyKey,
			caption: input.caption,
		});
	});

	test("a concurrent idempotent receiver creates one operation for duplicate requests", async () => {
		const operations = new Map<string, { id: string }>();
		let createdOperations = 0;
		const receiver: PublicationWebhookTransport = {
			async send(request, context) {
				await context.onRequestCommitted();
				const key = request.headers["Idempotency-Key"]!;
				await Promise.resolve();
				let operation = operations.get(key);
				if (!operation) {
					operation = { id: "receiver-operation-1" };
					operations.set(key, operation);
					createdOperations += 1;
				}
				return response({ status: "accepted", receipt: operation });
			},
		};
		const platform = createHarness([], receiver).platform;
		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () =>
				platform.publish(input, {
					signal: new AbortController().signal,
					checkpoint: async () => undefined,
				}),
			),
		);
		expect(createdOperations).toBe(1);
		expect(outcomes.every((outcome) => outcome.kind === "accepted")).toBe(true);
		expect(
			new Set(
				outcomes.map((outcome) =>
					outcome.kind === "accepted" ? outcome.receipt.receiptId : null,
				),
			),
		).toEqual(new Set(["receiver-operation-1"]));
	});

	test("request snapshots exclude credentials, private storage, and signing secrets", async () => {
		const { platform, requests } = createHarness([
			response({
				status: "failed",
				code: "manual_review",
				disposition: "attention",
			}),
		]);
		await expect(
			platform.publish(input, {
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			}),
		).resolves.toMatchObject({
			kind: "failed",
			failure: { disposition: "attention" },
		});
		const serialized = JSON.stringify(requests);
		expect(serialized).not.toContain(input.media.storageKey);
		expect(serialized).not.toContain(
			"test-webhook-secret-with-at-least-32-characters",
		);
		expect(serialized).not.toContain("accessToken");
		expect(serialized).not.toContain("refreshToken");
	});
});
