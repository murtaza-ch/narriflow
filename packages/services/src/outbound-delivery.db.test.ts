import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import {
	createCallbackCipher,
	prepareCallbackRegistration,
	signCallback,
} from "./completion-callback";
import { OutboundDeliveryService } from "./outbound-delivery";
import { readExecutionDispatch } from "./execution-dispatch";
import { createExecutorControl } from "./executor-control";
import { appendCompletionCallbackDispatch, appendWebhookSubscriptionDispatch } from "./notification-dispatch";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite =
	process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url
		? describe
		: describe.skip;
suite("Fenced notification deliveries", () => {
	let db: PrismaClient;
	beforeAll(() => {
		const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
		assertExecutionDatabaseTestTarget(url, schema);
		if (!schema.startsWith("serverless_execution_test_"))
			throw new Error("Disposable schema required");
		db = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }),
		});
	});
	afterAll(async () => {
		await db?.$disconnect();
	});
	async function fixture() {
		const user = await db.user.create({
			data: { clerkId: `notification:${crypto.randomUUID()}` },
		});
		const workspace = await db.workspace.create({
			data: {
				name: "Notification gate",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
				pricingTier: "pro",
			},
		});
		const cipher = createCallbackCipher("notification-gate-material");
		const registration = prepareCallbackRegistration(
			new URL("https://receiver.example/notify?private=hidden"),
			cipher,
		);
		await db.callbackSigningSecret.create({
			data: {
				workspaceId: workspace.id,
				encryptedSecret: cipher.seal(
					`whsec_${Buffer.alloc(32, 1).toString("base64")}`,
				),
			},
		});
		const bodies = new Map<string, { bytes: Uint8Array; etag: string }>();
		let puts = 0;
		let loseAck = false;
		let losePutAck = false;
		const registered: string[] = [];
		const service = new OutboundDeliveryService(db, {
			cipher,
			register: async (ids) => {
				registered.push(...ids);
				if (loseAck) throw new Error("lost ACK");
			},
			body: {
				put: async (plan, bytes) => {
					puts++;
					if (!bodies.has(plan.storageKey))
						bodies.set(plan.storageKey, { bytes, etag: '"frozen"' });
					if (losePutAck) throw new Error("lost PUT ACK");
				},
				head: async (plan) => {
					const o = bodies.get(plan.storageKey);
					return o
						? {
								etag: o.etag,
								byteLength: o.bytes.byteLength,
								sha256: createHash("sha256").update(o.bytes).digest("hex"),
							}
						: null;
				},
				read: async (plan) => {
					const o = bodies.get(plan.storageKey);
					if (!o || o.etag !== plan.etag) throw new Error("changed");
					return new ReadableStream({
						start(c) {
							c.enqueue(o.bytes);
							c.close();
						},
					});
				},
			},
		});
		const scope = { workspaceId: workspace.id, actorUserId: user.id };
		const sub = await db.webhookSubscription.create({
			data: {
				workspaceId: workspace.id,
				createdByUserId: user.id,
				...registration,
				types: ["operation.finished"],
				lastDeliveredSeq: 0n,
			},
		});
		return {
			service,
			scope,
			sub,
			cipher,
			registration,
			bodies,
			registered,
			puts: () => puts,
			loseAck: (v: boolean) => {
				loseAck = v;
			},
			losePutAck: (v: boolean) => {
				losePutAck = v;
			},
		};
	}
	async function executeFixture(
		f: Awaited<ReturnType<typeof fixture>>,
		id: string,
		responseStatus: number | null = 204,
	) {
		const driver = (await readExecutionDispatch(db, f.registered.at(-1)!))!
			.reference;
		const prepared = await f.service.prepareExecution(driver);
		if (prepared.kind !== "waiting")
			throw new Error("Expected native execution");
		const reference = prepared.deadline.reference,
			attemptToken = prepared.deadline.attemptToken,
			owner = crypto.randomUUID(),
			fence = { reference, attemptToken, owner };
		const control = createExecutorControl({
			database: db,
			subjectKind: "outbound_delivery",
			domain: f.service,
			deliverWakes: async (ids) => {
				f.registered.push(...ids);
			},
			artifacts: {
				head: async () => ({
					etag: '"receipt"',
					byteLength: 512n,
					contentType: "application/json",
					sha256: "a".repeat(64),
				}),
				prepare: async (_a, artifact) => ({
					...artifact,
					receipt: {
						version: 1 as const,
						kind: "signed_notification" as const,
						deliveryId: id,
						eventId: (
							await db.outboundDelivery.findUniqueOrThrow({ where: { id } })
						).eventId,
						workspaceId: f.scope.workspaceId,
						inputHash: reference.inputHash,
						bodySha256: (
							await db.outboundDelivery.findUniqueOrThrow({ where: { id } })
						).bodySha256,
						status: responseStatus,
						durationMs: 3,
						errorCode: null,
					},
				}),
			},
		});
		const command = async (command: unknown) =>
			control.execute({
				command,
				verifiedRequest: {
					requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
					metadata: {
						version: 1,
						keyId: "gate",
						audience: "executor-control",
						method: "POST",
						canonicalTarget: "/api/execution/command",
						bodySha256: "0".repeat(64),
						timestamp: Math.floor(Date.now() / 1000),
						deliveryId: crypto.randomUUID(),
						signature: "0".repeat(64),
					},
				},
			});
		await command({
			action: "acquire",
			reference,
			attemptToken,
			owner,
			leaseSeconds: 120,
		});
		return { command, control, fence, reference, attemptToken, owner };
	}
	test("Workflow preparation requires its exact live immutable notification reference", async () => {
		const f = await fixture();
		const id = await db.$transaction(tx => appendWebhookSubscriptionDispatch(tx, f.sub));
		const reference = (await readExecutionDispatch(db, id))!.reference;
		expect(await f.service.prepareSubscription(f.sub.id, { ...reference, inputHash: "0".repeat(64) })).toEqual({ kind: "terminal" });
		expect(await f.service.prepareSubscription(f.sub.id, reference)).toEqual({ kind: "idle" });
		await db.webhookSubscription.update({ where: { id: f.sub.id }, data: { types: ["finishing.finished"] } });
		expect(await f.service.prepareSubscription(f.sub.id, reference)).toEqual({ kind: "terminal" });
		expect(await db.outboundDelivery.count({ where: { targetId: f.sub.id } })).toBe(0);
	});
	test("callback preparation rechecks its immutable reference after remote-free status reads and before publication", async () => {
		const f = await fixture();
		const callback = await db.completionCallback.create({ data: { workspaceId: f.scope.workspaceId, operationKind: "generation", operationId: crypto.randomUUID(),
			receiptId: crypto.randomUUID(), eventId: crypto.randomUUID(), ...f.registration } });
		const id = await db.$transaction(tx => appendCompletionCallbackDispatch(tx, callback));
		const reference = (await readExecutionDispatch(db, id))!.reference;
		const service = new OutboundDeliveryService(db, { cipher: f.cipher, register: async () => { throw new Error("Unexpected registration"); },
			body: { put: async () => { throw new Error("Unexpected PUT"); }, head: async () => null, read: async () => { throw new Error("Unexpected body read"); } },
			readTrusted: async () => {
				await db.completionCallback.update({ where: { id: callback.id }, data: { urlFingerprint: "changed-during-status-read" } });
				return { kind: "generation", id: callback.operationId, state: "unavailable" };
			},
		});
		expect(await service.prepareCompletion(callback.id, reference)).toEqual({ kind: "terminal" });
		expect(await db.outboundDelivery.count({ where: { targetId: callback.id } })).toBe(0);
		expect((await db.completionCallback.findUniqueOrThrow({ where: { id: callback.id } })).payload).toBeNull();
	});
	test("test admission freezes before PUT, reconciles both lost ACKs, and replays the same event without another POST", async () => {
		const f = await fixture();
		f.losePutAck(true);
		f.loseAck(true);
		await expect(
			f.service.admitTest(f.scope, f.sub.id, "intent-1"),
		).rejects.toMatchObject({ code: "outbound_delivery_unavailable" });
		const known = await db.outboundDelivery.findFirstOrThrow({
			where: { targetId: f.sub.id },
		});
		expect(known.status).toBe("queued");
		expect(known.bodyEtag).toBe('"frozen"');
		expect(f.puts()).toBe(1);
		f.loseAck(false);
		const replay = await f.service.admitTest(f.scope, f.sub.id, "intent-1");
		expect(replay.deliveryId).toBe(known.id);
		expect(replay.eventId).toBe(known.eventId);
		expect(f.puts()).toBe(1);
		await expect(
			f.service.admitTest(f.scope, f.sub.id, "intent-2"),
		).rejects.toMatchObject({ code: "webhook_test_throttled" });
		const work = await f.service.workInput(known.id);
		expect(work.command.kind).toBe("signed_notification");
		expect(work.command.headers["webhook-id"]).toBe(known.eventId);
		expect(work.sources[0]?.name).toBe("notification_body");
		expect(JSON.stringify(work.command)).not.toContain("whsec_");
		await expect(
			(async () =>
				await db.outboundDelivery.update({
					where: { id: known.id },
					data: { bodySha256: "f".repeat(64) },
				}))(),
		).rejects.toThrow();
		const x = await executeFixture(f, known.id);
		await x.command({ action: "process-start", fence: x.fence });
		await x.command({ action: "process-start", fence: x.fence });
		expect(
			(await db.outboundDelivery.findUniqueOrThrow({ where: { id: known.id } }))
				.chargedAttempts,
		).toBe(1);
		const a = await db.executionArtifact.create({
			data: {
				attemptToken: x.attemptToken,
				owner: x.owner,
				role: "outbound_receipt",
				bindingHash: x.reference.inputHash,
				storageKey: `execution/${x.reference.deploymentEpoch}/${x.attemptToken}/${x.owner}/receipt.json`,
				contentType: "application/json",
				maxBytes: 65536n,
				grantExpiresAt: new Date(Date.now() + 60000),
			},
		});
		await x.command({
			action: "commit-artifact",
			fence: x.fence,
			artifact: {
				artifactId: a.id,
				role: "outbound_receipt",
				bindingHash: x.reference.inputHash,
				contentType: "application/json",
				byteLength: 512,
				sha256: "a".repeat(64),
				etag: '"receipt"',
			},
		});
		expect((await f.service.getTest(f.scope, f.sub.id, known.id)).state).toBe(
			"delivered",
		);
		expect(
			(
				await db.webhookSubscription.findUniqueOrThrow({
					where: { id: f.sub.id },
				})
			).lastDeliveredSeq,
		).toBe(0n);
	});
	test("subscription preparation preserves one ordered event, durable plan holds, and a fresh authority generation", async () => {
		const f = await fixture();
		await db.workspaceEventCounter.create({
			data: { workspaceId: f.scope.workspaceId, lastSeq: 2n },
		});
		for (const seq of [1n, 2n])
			await db.workspaceEvent.create({
				data: {
					workspaceId: f.scope.workspaceId,
					seq,
					type: "operation.finished",
					subject: { projectId: crypto.randomUUID() },
					occurredAt: new Date(),
					dedupeKey: crypto.randomUUID(),
				},
			});
		const first = await f.service.prepareSubscription(f.sub.id);
		if (first.kind !== "accepted") throw new Error("Expected event");
		const again = await f.service.prepareSubscription(f.sub.id);
		expect(again).toEqual(first);
		const x = await executeFixture(f, first.deliveryId);
		await x.command({ action: "process-start", fence: x.fence });
		await db.workspace.update({
			where: { id: f.scope.workspaceId },
			data: { status: "restricted" },
		});
		const held = await x.command({
			action: "read-disposition",
			fence: x.fence,
		});
		expect(held.disposition).toBe("superseded");
		const row = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: first.deliveryId },
		});
		expect(row.status).toBe("queued");
		expect(row.generation).toBe(2);
		expect(row.executorOwner).toBeNull();
		expect(row.retryAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60000);
		expect(row.policyFailures).toBe(0);
		const sub = await db.webhookSubscription.findUniqueOrThrow({
			where: { id: f.sub.id },
		});
		expect(sub.lastDeliveredSeq).toBe(0n);
		expect(sub.consecutiveFailures).toBe(0);
	});
	async function commitReceipt(x: Awaited<ReturnType<typeof executeFixture>>) {
		const a = await db.executionArtifact.create({
			data: {
				attemptToken: x.attemptToken,
				owner: x.owner,
				role: "outbound_receipt",
				bindingHash: x.reference.inputHash,
				storageKey: `execution/${x.reference.deploymentEpoch}/${x.attemptToken}/${x.owner}/receipt.json`,
				contentType: "application/json",
				maxBytes: 65536n,
				grantExpiresAt: new Date(Date.now() + 60000),
			},
		});
		await x.command({
			action: "commit-artifact",
			fence: x.fence,
			artifact: {
				artifactId: a.id,
				role: "outbound_receipt",
				bindingHash: x.reference.inputHash,
				contentType: "application/json",
				byteLength: 512,
				sha256: "a".repeat(64),
				etag: '"receipt"',
			},
		});
	}
	async function events(f: Awaited<ReturnType<typeof fixture>>, count = 2) {
		await db.workspaceEventCounter.create({
			data: { workspaceId: f.scope.workspaceId, lastSeq: BigInt(count) },
		});
		for (let n = 1; n <= count; n++)
			await db.workspaceEvent.create({
				data: {
					workspaceId: f.scope.workspaceId,
					seq: BigInt(n),
					type: "operation.finished",
					subject: { projectId: crypto.randomUUID() },
					occurredAt: new Date(),
					dedupeKey: crypto.randomUUID(),
				},
			});
	}
	test("sealed receipts move the cursor atomically, wake the next event, and 410 disables without advancing", async () => {
		const f = await fixture();
		await events(f);
		const first = await f.service.prepareSubscription(f.sub.id);
		if (first.kind !== "accepted") throw new Error("Missing first event");
		const x = await executeFixture(f, first.deliveryId);
		await x.command({ action: "process-start", fence: x.fence });
		await commitReceipt(x);
		let sub = await db.webhookSubscription.findUniqueOrThrow({
			where: { id: f.sub.id },
		});
		expect(sub.lastDeliveredSeq).toBe(1n);
		expect(sub.consecutiveFailures).toBe(0);
		expect(
			await db.executionDispatch.count({
				where: {
					subjectKind: "webhook_subscription",
					subjectId: sub.id,
					wakeKind: { startsWith: "notify_" },
				},
			}),
		).toBe(1);
		const next = await f.service.prepareSubscription(f.sub.id);
		if (next.kind !== "accepted") throw new Error("Missing second event");
		expect(next.deliveryId).not.toBe(first.deliveryId);
		const second = await executeFixture(f, next.deliveryId, 410);
		await second.command({ action: "process-start", fence: second.fence });
		await commitReceipt(second);
		sub = await db.webhookSubscription.findUniqueOrThrow({
			where: { id: f.sub.id },
		});
		expect(sub.lastDeliveredSeq).toBe(1n);
		expect(sub.status).toBe("disabled");
		expect(sub.disabledReason).toBe("endpoint_gone");
		expect((await f.service.prepareSubscription(sub.id)).kind).toBe("terminal");
	});
	test("missing secrets retain the existing 20-failure policy without charging native starts or advancing cursor", async () => {
		const f = await fixture();
		await events(f, 1);
		await db.callbackSigningSecret.deleteMany({
			where: { workspaceId: f.scope.workspaceId },
		});
		const admitted = await f.service.prepareSubscription(f.sub.id);
		if (admitted.kind !== "accepted") throw new Error("Missing event");
		for (let n = 1; n <= 20; n++) {
			const row = await db.outboundDelivery.findUniqueOrThrow({
				where: { id: admitted.deliveryId },
			});
			const d = await db.executionDispatch.findFirstOrThrow({
				where: {
					subjectKind: "outbound_delivery",
					subjectId: row.id,
					kind: "operation_driver",
					generation: row.generation,
					wakeKind: null,
					deadlineKind: null,
				},
			});
			if (row.retryAt)
				await db.outboundDelivery.update({
					where: { id: row.id },
					data: { retryAt: new Date(Date.now() - 1000) },
				});
			const result = await f.service.prepareExecution(
				(await readExecutionDispatch(db, d.id))!.reference,
			);
			expect(result.kind).toBe("terminal");
			const sub = await db.webhookSubscription.findUniqueOrThrow({
				where: { id: f.sub.id },
			});
			expect(sub.consecutiveFailures).toBe(n);
			expect(sub.lastDeliveredSeq).toBe(0n);
		}
		const row = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: admitted.deliveryId },
		});
		expect(row.status).toBe("failed");
		expect(row.chargedAttempts).toBe(0);
		expect(row.policyFailures).toBe(20);
		const sub = await db.webhookSubscription.findUniqueOrThrow({
			where: { id: f.sub.id },
		});
		expect(sub.status).toBe("disabled");
		expect(sub.disabledReason).toBe("consecutive_failures");
	});
	test("streaming signing covers the immutable full body with both overlap keys and rejects changed bytes", async () => {
		const f = await fixture();
		const admitted = await f.service.admitTest(f.scope, f.sub.id, "rotation");
		const row = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: admitted.deliveryId },
		});
		await db.callbackSigningSecret.updateMany({
			where: { workspaceId: f.scope.workspaceId },
			data: { retiresAt: new Date(Date.now() + 3600000) },
		});
		await db.callbackSigningSecret.create({
			data: {
				workspaceId: f.scope.workspaceId,
				encryptedSecret: f.cipher.seal(
					`whsec_${Buffer.alloc(32, 2).toString("base64")}`,
				),
			},
		});
		const work = await f.service.workInput(row.id);
		expect(work.command.headers["webhook-signature"].split(" ")).toHaveLength(
			2,
		);
		const body = f.bodies.get(row.bodyStorageKey)!;
		const expected = signCallback({
			eventId: row.eventId,
			timestamp: Number(work.command.headers["webhook-timestamp"]),
			body: new TextDecoder().decode(body.bytes),
			secrets: [
				`whsec_${Buffer.alloc(32, 1).toString("base64")}`,
				`whsec_${Buffer.alloc(32, 2).toString("base64")}`,
			],
		})
			.split(" ")
			.sort();
		expect(work.command.headers["webhook-signature"].split(" ").sort()).toEqual(
			expected,
		);
		body.bytes = new TextEncoder().encode(" ".repeat(body.bytes.byteLength));
		await expect(f.service.workInput(row.id)).rejects.toMatchObject({
			code: "outbound_delivery_invalid",
		});
	});
	test("callbacks preserve frozen payload and ten-attempt budget; explicit redelivery creates another authority UUID", async () => {
		const f = await fixture(),
			eventId = crypto.randomUUID();
		const callback = await db.completionCallback.create({
			data: {
				workspaceId: f.scope.workspaceId,
				operationKind: "generation",
				operationId: crypto.randomUUID(),
				receiptId: crypto.randomUUID(),
				...f.registration,
				eventId,
				state: "pending",
				payload: {
					id: eventId,
					type: "operation.completed",
					version: 1,
					createdAt: new Date().toISOString(),
					workspaceId: f.scope.workspaceId,
					data: {
						operationId: "generation:test",
						kind: "generation",
						state: "completed",
						projectId: null,
						clipIds: [crypto.randomUUID()],
					},
				},
			},
		});
		await db.workspace.update({
			where: { id: f.scope.workspaceId },
			data: { status: "restricted" },
		});
		const first = await f.service.prepareCompletion(callback.id);
		if (first.kind !== "accepted") throw new Error("Missing callback");
		for (let n = 1; n <= 10; n++) {
			const x = await executeFixture(f, first.deliveryId, 503);
			await x.command({ action: "process-start", fence: x.fence });
			await commitReceipt(x);
			const row = await db.outboundDelivery.findUniqueOrThrow({
				where: { id: first.deliveryId },
			});
			expect(row.chargedAttempts).toBe(n);
			if (row.retryAt)
				await db.outboundDelivery.update({
					where: { id: row.id },
					data: { retryAt: new Date(Date.now() - 1000) },
				});
		}
		let parent = await db.completionCallback.findUniqueOrThrow({
			where: { id: callback.id },
		});
		expect(parent.state).toBe("failed");
		expect(parent.attempts).toBe(10);
		const frozen = JSON.stringify(parent.payload);
		await db.completionCallback.update({
			where: { id: parent.id },
			data: {
				state: "pending",
				attempts: 0,
				nextAttemptAt: new Date(),
				deliveredAt: null,
			},
		});
		const replay = await f.service.prepareCompletion(parent.id);
		if (replay.kind !== "accepted") throw new Error("Missing redelivery");
		expect(replay.deliveryId).not.toBe(first.deliveryId);
		const next = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: replay.deliveryId },
		});
		expect(next.eventId).toBe(eventId);
		expect(next.chargedAttempts).toBe(0);
		expect(
			(
				await db.outboundDelivery.findUniqueOrThrow({
					where: { id: first.deliveryId },
				})
			).chargedAttempts,
		).toBe(10);
		parent = await db.completionCallback.findUniqueOrThrow({
			where: { id: callback.id },
		});
		expect(JSON.stringify(parent.payload)).toBe(frozen);
	});
	test("physical attempt exhaustion after plan holds preserves the actual failure counter until explicit re-enable", async () => {
		const f = await fixture();
		await events(f, 1);
		const admitted = await f.service.prepareSubscription(f.sub.id);
		if (admitted.kind !== "accepted") throw new Error("Missing event");
		await db.outboundDelivery.update({
			where: { id: admitted.deliveryId },
			data: { chargedAttempts: 20 },
		});
		await db.webhookSubscription.update({
			where: { id: f.sub.id },
			data: { consecutiveFailures: 2 },
		});
		const row = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: admitted.deliveryId },
		});
		const d = await db.executionDispatch.findFirstOrThrow({
			where: {
				subjectKind: "outbound_delivery",
				subjectId: row.id,
				kind: "operation_driver",
				generation: row.generation,
				wakeKind: null,
				deadlineKind: null,
			},
		});
		expect(
			(
				await f.service.prepareExecution(
					(await readExecutionDispatch(db, d.id))!.reference,
				)
			).kind,
		).toBe("terminal");
		const sub = await db.webhookSubscription.findUniqueOrThrow({
			where: { id: f.sub.id },
		});
		expect(sub.status).toBe("disabled");
		expect(sub.disabledReason).toBe("delivery_attempts_exhausted");
		expect(sub.consecutiveFailures).toBe(2);
		expect(sub.lastDeliveredSeq).toBe(0n);
		expect((await f.service.prepareSubscription(sub.id)).kind).toBe("terminal");
		await db.webhookSubscription.update({
			where: { id: sub.id },
			data: {
				status: "active",
				disabledReason: null,
				disabledAt: null,
				consecutiveFailures: 0,
				skipExpiredOnResume: true,
				nextAttemptAt: new Date(),
			},
		});
		const next = await f.service.prepareSubscription(sub.id);
		if (next.kind !== "accepted") throw new Error("Missing explicit new round");
		expect(next.deliveryId).not.toBe(row.id);
		expect(
			(await db.outboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
				.chargedAttempts,
		).toBe(20);
	});
	test("an API-key test keeps processing admission and loses native authority immediately when that key is revoked", async () => {
		const f = await fixture();
		const editor = await db.user.create({
			data: { clerkId: `rest-test:${crypto.randomUUID()}` },
		});
		await db.workspaceMember.create({
			data: {
				workspaceId: f.scope.workspaceId,
				userId: editor.id,
				role: "editor",
			},
		});
		const key = await db.apiKey.create({
			data: {
				workspaceId: f.scope.workspaceId,
				userId: f.scope.actorUserId,
				createdByUserId: editor.id,
				name: "Native test",
				prefix: `gate_${crypto.randomUUID()}`,
				hashedSecret: "gate",
				scopes: ["processing:write"],
			},
		});
		const scope = { workspaceId: f.scope.workspaceId, actorUserId: editor.id };
		const accepted = await f.service.admitTest(scope, f.sub.id, "rest-editor", {
			capability: "processing.consume",
			apiKeyId: key.id,
		});
		const x = await executeFixture(f, accepted.deliveryId);
		await x.command({ action: "process-start", fence: x.fence });
		await db.apiKey.update({
			where: { id: key.id },
			data: { revokedAt: new Date() },
		});
		await expect(x.control.authorize(x.fence)).rejects.toMatchObject({
			code: "authority_lost",
		});
		expect(
			(
				await db.outboundDelivery.findUniqueOrThrow({
					where: { id: accepted.deliveryId },
				})
			).status,
		).toBe("processing");
		expect(
			(await x.command({ action: "read-disposition", fence: x.fence }))
				.disposition,
		).toBe("cancelled");
		expect(
			(
				await db.outboundDelivery.findUniqueOrThrow({
					where: { id: accepted.deliveryId },
				})
			).status,
		).toBe("cancelled");
	});
	test("a sealed active body does not depend on retained event bytes during replay; expiry cancels before any native start", async () => {
		const f = await fixture();
		await events(f, 1);
		const first = await f.service.prepareSubscription(f.sub.id);
		if (first.kind !== "accepted") throw new Error("Missing delivery");
		await db.workspaceEvent.deleteMany({
			where: { workspaceId: f.scope.workspaceId },
		});
		expect(await f.service.prepareSubscription(f.sub.id)).toEqual(first);
		const row = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: first.deliveryId },
		});
		const dispatch = await db.executionDispatch.findFirstOrThrow({
			where: {
				kind: "operation_driver",
				subjectKind: "outbound_delivery",
				subjectId: row.id,
				generation: row.generation,
				wakeKind: null,
				deadlineKind: null,
			},
		});
		expect(
			(
				await f.service.prepareExecution(
					(await readExecutionDispatch(db, dispatch.id))!.reference,
				)
			).kind,
		).toBe("terminal");
		const current = await db.outboundDelivery.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(current.status).toBe("cancelled");
		expect(current.chargedAttempts).toBe(0);
		const sub = await db.webhookSubscription.findUniqueOrThrow({
			where: { id: f.sub.id },
		});
		expect(sub.disabledReason).toBe("cursor_expired");
		expect(sub.lastDeliveredSeq).toBe(0n);
	});
	test.each([
		"social_post.proposed",
		"social_post.finished",
	])("a current key that loses publishing:read cannot authorize a %s test", async (type) => {
		const f = await fixture();
		await db.webhookSubscription.update({
			where: { id: f.sub.id },
			data: { types: [type] },
		});
		const key = await db.apiKey.create({
			data: {
				workspaceId: f.scope.workspaceId,
				userId: f.scope.actorUserId,
				createdByUserId: f.scope.actorUserId,
				name: "Publishing test",
				prefix: `gate_${crypto.randomUUID()}`,
				hashedSecret: "gate",
				scopes: ["processing:write", "publishing:read"],
			},
		});
		const accepted = await f.service.admitTest(
			f.scope,
			f.sub.id,
			"publishing-scope",
			{ capability: "processing.consume", apiKeyId: key.id },
		);
		const x = await executeFixture(f, accepted.deliveryId);
		await x.command({ action: "process-start", fence: x.fence });
		await db.apiKey.update({
			where: { id: key.id },
			data: { scopes: ["processing:write"] },
		});
		await expect(x.control.authorize(x.fence)).rejects.toMatchObject({
			code: "authority_lost",
		});
		expect(
			(await x.command({ action: "read-disposition", fence: x.fence }))
				.disposition,
		).toBe("cancelled");
	});
});
