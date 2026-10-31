import { createHash, createHmac, randomUUID } from "node:crypto";
import {
	Prisma,
	type OutboundDelivery,
	type PrismaClient,
	type WebhookSubscription,
} from "@prisma/client";
import {
	hasFeature,
	WORKSPACE_EVENT_PUBLISHING_TYPES,
	roleHasWorkspaceCapability,
	workspaceAllowsCapability,
} from "@narriflow/validators";
import {
	NOTIFICATION_BODY_MAX_BYTES,
	notificationReceiptSchema,
	signedNotificationCommandSchema,
	type NotificationReceipt,
} from "@narriflow/validators/outbound-delivery";
import type {
	ExecutionDeadline,
	ExecutionDispatchReference,
} from "@narriflow/validators/execution";
import type { ActorScope } from "./actor-scope";
import {
	buildCallbackPayload,
	CALLBACK_RETRY_DELAYS_MS,
	createCallbackCipher,
	nextAttemptDelayMs,
	type CallbackCipher,
	type CallbackRegistration,
} from "./completion-callback";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
import type {
	ExecutorArtifactCommit,
	ExecutorDomainControl,
	ExecutorDomainLock,
	ExecutorMutationContext,
	ExecutorMutationResult,
	ExecutorExpiryObservation,
	ExecutorExpiryResult,
} from "./executor-domain-control";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { OperationStatusReader } from "./operation-status";
import { uuidV5 } from "./uuid-v5";

type Tx = Prisma.TransactionClient;
const active = ["preparing", "queued", "processing"];
const final = ["completed", "failed", "cancelled"];
const holdMs = 15 * 60_000;
const expiryMs = 30 * 86400_000;
const attemptMs = 120_000;
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const namespace = "c22d9ae5-2920-5c0b-9bfe-72cdf2d8a0b9";
import { webhookSubscriptionExecutionInputHash } from "./notification-identity";
export { webhookSubscriptionExecutionInputHash } from "./notification-identity";
export interface NotificationBodyPlan {
	storageKey: string;
	sha256: string;
	byteLength: number;
}
export interface NotificationBodyStorage {
	put(plan: NotificationBodyPlan, bytes: Uint8Array): Promise<void>;
	head(
		plan: NotificationBodyPlan,
	): Promise<{ etag: string; sha256: string; byteLength: number } | null>;
	read(
		plan: NotificationBodyPlan & { etag: string },
	): Promise<ReadableStream<Uint8Array>>;
}
export interface OutboundDeliveryDependencies {
	body: NotificationBodyStorage;
	register(ids: readonly string[]): Promise<void>;
	cipher?: CallbackCipher;
	readTrusted?: OperationStatusReader["readTrusted"];
	random?: () => number;
}
export class OutboundDeliveryError extends ExpectedDomainFailureError {
	constructor(
		code:
			| "outbound_delivery_missing"
			| "outbound_delivery_conflict"
			| "outbound_delivery_unavailable"
			| "outbound_delivery_invalid"
			| "webhook_test_throttled",
		deliveryId?: string,
	) {
		super({
			code,
			kind:
				code === "outbound_delivery_missing"
					? "missing"
					: code === "outbound_delivery_unavailable"
						? "unavailable"
						: code === "outbound_delivery_invalid"
							? "unprocessable"
							: code === "webhook_test_throttled"
								? "rate_limited"
								: "conflict",
			message: "Notification delivery is unavailable",
			...(deliveryId ? { details: { deliveryId } } : {}),
			...(code === "webhook_test_throttled" ? { retryAfterSeconds: 5 } : {}),
		});
	}
}
export interface OutboundDeliveryReference {
	id: string;
	attemptToken: string;
	generation: number;
	deploymentEpoch: number;
}
export interface NotificationArtifact extends ExecutorArtifactCommit {
	receipt: NotificationReceipt;
}
export type OutboundDeliveryPreparation =
	| { kind: "terminal" | "superseded"; dispatchIds?: readonly string[] }
	| { kind: "sleep"; dueAt: Date; dispatchIds?: readonly string[] }
	| {
			kind: "waiting";
			deadline: ExecutionDeadline;
			deliveryId: string;
			dispatchIds: readonly string[];
	  };
async function clock(tx: Tx) {
	const [row] = await tx.$queryRaw<
		Array<{ now: Date }>
	>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
	if (!row) throw new OutboundDeliveryError("outbound_delivery_unavailable");
	return row.now;
}
const plan = (row: OutboundDelivery): NotificationBodyPlan => ({
	storageKey: row.bodyStorageKey,
	sha256: row.bodySha256,
	byteLength: Number(row.bodyByteLength),
});
const publicJob = (row: OutboundDelivery) => ({
	deliveryId: row.id,
	eventId: row.eventId,
	state:
		row.status === "completed"
			? ("delivered" as const)
			: row.status === "failed" || row.status === "cancelled"
				? ("unconfirmed" as const)
				: ("pending" as const),
	status: row.lastResponseStatus,
	durationMs: row.durationMs,
});

/** Frozen notifications only. URLs, bytes, signing keys and cursor decisions
 * never come from the native command caller. */
export class OutboundDeliveryService
	implements
		ExecutorDomainControl<OutboundDeliveryReference, NotificationArtifact>
{
	constructor(
		private readonly database: PrismaClient,
		private readonly dependencies: OutboundDeliveryDependencies,
	) {}
	private async epoch(tx: Tx) {
		await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
	}
	private cipher() {
		return this.dependencies.cipher ?? createCallbackCipher();
	}
	private async actor(
		tx: Tx,
		scope: ActorScope,
		capability: "api.manage" | "processing.consume" = "api.manage",
	) {
		const workspace = await tx.workspace.findUnique({
			where: { id: scope.workspaceId },
		});
		const user = await tx.user.findUnique({
			where: { id: scope.actorUserId },
			select: { deletedAt: true },
		});
		const member = await tx.workspaceMember.findUnique({
			where: {
				workspaceId_userId: {
					workspaceId: scope.workspaceId,
					userId: scope.actorUserId,
				},
			},
		});
		const role =
			workspace?.ownerUserId === scope.actorUserId ? "owner" : member?.role;
		if (
			!workspace ||
			!user ||
			user.deletedAt ||
			!role ||
			!roleHasWorkspaceCapability(role, capability) ||
			!workspaceAllowsCapability(
				{ role, status: workspace.status },
				capability,
			) ||
			!hasFeature(workspace.pricingTier, "integrations.api")
		)
			throw new OutboundDeliveryError("outbound_delivery_missing");
	}
	private async lockParent(
		tx: Tx,
		row: Pick<OutboundDelivery, "workspaceId" | "targetKind" | "targetId">,
	) {
		await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${row.workspaceId}::uuid FOR SHARE`;
		if (row.targetKind === "completion_callback") {
			const parent = await tx.completionCallback.findUnique({
				where: { id: row.targetId },
				select: { payload: true },
			});
			const projectId = (
				parent?.payload as { data?: { projectId?: string | null } } | null
			)?.data?.projectId;
			if (projectId)
				await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${projectId}::uuid AND "workspaceId"=${row.workspaceId}::uuid FOR SHARE`;
			await tx.$queryRaw`SELECT "id" FROM "CompletionCallback" WHERE "id"=${row.targetId}::uuid FOR UPDATE`;
		} else
			await tx.$queryRaw`SELECT "id" FROM "WebhookSubscription" WHERE "id"=${row.targetId}::uuid FOR UPDATE`;
	}
	private async create(
		tx: Tx,
		input: {
			id?: string;
			workspaceId: string;
			targetKind: string;
			targetId: string;
			eventId: string;
			eventSeq?: bigint;
			actor?: string;
			actorCapability?: "api.manage" | "processing.consume";
			apiKeyId?: string;
			requestFingerprint?: string;
			registration: CallbackRegistration;
			payload: unknown;
			at: Date;
			expiresAt?: Date;
			maxAttempts: number;
		},
	) {
		const bytes = new TextEncoder().encode(JSON.stringify(input.payload));
		if (bytes.byteLength < 1 || bytes.byteLength > NOTIFICATION_BODY_MAX_BYTES)
			throw new OutboundDeliveryError("outbound_delivery_invalid");
		const [epoch] = await tx.$queryRaw<
			Array<{ epoch: number }>
		>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
		if (!epoch)
			throw new OutboundDeliveryError("outbound_delivery_unavailable");
		const id = input.id ?? randomUUID(),
			bodySha256 = createHash("sha256").update(bytes).digest("hex");
		const expiresAt = new Date(
			Math.min(
				input.at.getTime() + expiryMs,
				input.expiresAt?.getTime() ?? Infinity,
			),
		);
		if (expiresAt <= input.at)
			throw new OutboundDeliveryError("outbound_delivery_conflict");
		const bodyStorageKey = `notifications/${input.workspaceId}/${id}/body.json`;
		const inputHash = hash([
			"signed-notification-v1",
			id,
			input.workspaceId,
			input.targetKind,
			input.targetId,
			input.eventId,
			input.eventSeq?.toString() ?? null,
			input.registration.urlFingerprint,
			input.actorCapability ?? null,
			input.apiKeyId ?? null,
			bodyStorageKey,
			bodySha256,
			bytes.byteLength,
			epoch.epoch,
		]);
		const row = await tx.outboundDelivery.create({
			data: {
				id,
				workspaceId: input.workspaceId,
				targetKind: input.targetKind,
				targetId: input.targetId,
				eventId: input.eventId,
				eventSeq: input.eventSeq,
				createdByUserId: input.actor,
				actorCapability: input.actorCapability,
				apiKeyId: input.apiKeyId,
				requestFingerprint: input.requestFingerprint,
				encryptedUrl: input.registration.encryptedUrl,
				urlHost: input.registration.urlHost,
				urlFingerprint: input.registration.urlFingerprint,
				bodyStorageKey,
				bodySha256,
				bodyByteLength: BigInt(bytes.byteLength),
				inputHash,
				deploymentEpoch: epoch.epoch,
				expiresAt,
				maxAttempts: input.maxAttempts,
				createdAt: input.at,
			},
		});
		await tx.mediaCleanupObligation.create({
			data: {
				origin: "outbound_delivery",
				cleanupClass: "notification_body",
				objectKey: bodyStorageKey,
				nextAttemptAt: new Date(expiresAt.getTime() + 86400_000),
			},
		});
		return { row, bytes };
	}
	/** Planned key exists in SQL before PUT. A lost write acknowledgment is
	 * reconciled by exact key/length/full checksum, never an object search. */
	private async seal(row: OutboundDelivery, bytes: Uint8Array) {
		if (row.status !== "preparing") {
			await this.confirm(
				row.id,
				await this.database.$transaction((tx) => this.register(tx, row)),
			);
			return publicJob(row);
		}
		const headBody = async () => {
			try {
				return await this.dependencies.body.head(plan(row));
			} catch {
				throw new OutboundDeliveryError(
					"outbound_delivery_unavailable",
					row.id,
				);
			}
		};
		let head = await headBody();
		if (!head) {
			try {
				await this.dependencies.body.put(plan(row), bytes);
			} catch {
				/* An acknowledgment may be lost after the conditional PUT. */
			}
			head = await headBody();
		}
		if (
			!head ||
			head.sha256 !== row.bodySha256 ||
			head.byteLength !== Number(row.bodyByteLength) ||
			!head.etag ||
			head.etag.length > 160
		)
			throw new OutboundDeliveryError("outbound_delivery_unavailable", row.id);
		const etag = head.etag;
		const admitted = await this.database.$transaction(async (tx) => {
			await this.epoch(tx);
			await this.lockParent(tx, row);
			await tx.$queryRaw`SELECT "id" FROM "OutboundDelivery" WHERE "id"=${row.id}::uuid FOR UPDATE`;
			let current = await tx.outboundDelivery.findUniqueOrThrow({
				where: { id: row.id },
			});
			if (current.status === "preparing")
				current = await tx.outboundDelivery.update({
					where: { id: row.id },
					data: { status: "queued", bodyEtag: etag },
				});
			return { row: current, ids: await this.register(tx, current) };
		});
		await this.confirm(row.id, admitted.ids);
		return publicJob(admitted.row);
	}
	private async bytes(tx: Tx, row: OutboundDelivery) {
		let payload: unknown;
		if (row.targetKind === "completion_callback")
			payload = (
				await tx.completionCallback.findUnique({ where: { id: row.targetId } })
			)?.payload;
		else if (row.targetKind === "webhook_test")
			payload = {
				id: row.eventId,
				seq: 0,
				type: "webhook.test",
				version: 1,
				occurredAt: row.createdAt.toISOString(),
				workspaceId: row.workspaceId,
				subject: {},
			};
		else {
			const event = await tx.workspaceEvent.findUnique({
				where: { id: row.eventId },
			});
			if (event && event.workspaceId === row.workspaceId)
				payload = {
					id: event.id,
					seq: Number(event.seq),
					type: event.type,
					version: event.version,
					occurredAt: event.occurredAt.toISOString(),
					workspaceId: row.workspaceId,
					subject: event.subject,
				};
		}
		const bytes = new TextEncoder().encode(JSON.stringify(payload));
		if (
			createHash("sha256").update(bytes).digest("hex") !== row.bodySha256 ||
			BigInt(bytes.byteLength) !== row.bodyByteLength
		)
			throw new OutboundDeliveryError("outbound_delivery_invalid");
		return bytes;
	}
	async admitTest(
		scope: ActorScope,
		subscriptionId: string,
		intent: string,
		authority: {
			capability: "api.manage" | "processing.consume";
			apiKeyId?: string;
		} = { capability: "api.manage" },
	) {
		if (!intent || intent.length > 256)
			throw new OutboundDeliveryError("outbound_delivery_conflict");
		const fingerprint = hash([
			"webhook-test-v1",
			scope.workspaceId,
			scope.actorUserId,
			subscriptionId,
			intent,
		]);
		const admitted = await this.database.$transaction(async (tx) => {
			await this.epoch(tx);
			await this.lockParent(tx, {
				workspaceId: scope.workspaceId,
				targetKind: "webhook_test",
				targetId: subscriptionId,
			});
			await this.actor(tx, scope, authority.capability);
			const sub = await tx.webhookSubscription.findFirst({
				where: { id: subscriptionId, workspaceId: scope.workspaceId },
			});
			if (!sub) throw new OutboundDeliveryError("outbound_delivery_missing");
			const known = await tx.outboundDelivery.findUnique({
				where: { requestFingerprint: fingerprint },
			});
			if (known)
				return {
					row: known,
					bytes:
						known.status === "preparing"
							? await this.bytes(tx, known)
							: new Uint8Array(),
				};
			const at = await clock(tx);
			if (sub.lastTestedAt && sub.lastTestedAt.getTime() > at.getTime() - 5000)
				throw new OutboundDeliveryError("webhook_test_throttled");
			const id = uuidV5(namespace, fingerprint),
				eventId = uuidV5(namespace, `${id}:event`);
			await tx.webhookSubscription.update({
				where: { id: sub.id },
				data: { lastTestedAt: at },
			});
			return this.create(tx, {
				id,
				workspaceId: scope.workspaceId,
				targetKind: "webhook_test",
				targetId: sub.id,
				eventId,
				actor: scope.actorUserId,
				actorCapability: authority.capability,
				apiKeyId: authority.apiKeyId,
				requestFingerprint: fingerprint,
				registration: sub,
				payload: {
					id: eventId,
					seq: 0,
					type: "webhook.test",
					version: 1,
					occurredAt: at.toISOString(),
					workspaceId: scope.workspaceId,
					subject: {},
				},
				at,
				maxAttempts: 1,
			});
		});
		return this.seal(admitted.row, admitted.bytes);
	}
	async getTest(scope: ActorScope, subscriptionId: string, id: string) {
		return this.database.$transaction(async (tx) => {
			const sub = await tx.webhookSubscription.findFirst({
				where: { id: subscriptionId, workspaceId: scope.workspaceId },
			});
			const row = await tx.outboundDelivery.findFirst({
				where: {
					id,
					workspaceId: scope.workspaceId,
					targetKind: "webhook_test",
					targetId: subscriptionId,
					createdByUserId: scope.actorUserId,
				},
			});
			if (!sub || !row)
				throw new OutboundDeliveryError("outbound_delivery_missing");
			await this.actor(
				tx,
				scope,
				row.actorCapability as "api.manage" | "processing.consume",
			);
			return publicJob(row);
		});
	}
	/** Called by the operation's durable completion wake, with no parent lease. */
	async prepareCompletion(callbackId: string) {
		const initial = await this.database.completionCallback.findUnique({
			where: { id: callbackId },
		});
		if (!initial) return { kind: "terminal" as const };
		// Trusted status may use multiple domain reads; it is never performed under our locks.
		const status = initial.payload
			? null
			: await this.dependencies.readTrusted?.(
					{ workspaceId: initial.workspaceId },
					{
						kind: initial.operationKind as Parameters<
							OperationStatusReader["readTrusted"]
						>[1]["kind"],
						id: initial.operationId,
					},
				);
		const admitted = await this.database.$transaction(async (tx) => {
			await this.epoch(tx);
			await this.lockParent(tx, {
				workspaceId: initial.workspaceId,
				targetKind: "completion_callback",
				targetId: callbackId,
			});
			let callback = await tx.completionCallback.findUniqueOrThrow({
				where: { id: callbackId },
			});
			if (!["waiting", "pending"].includes(callback.state)) return null;
			const known = await tx.outboundDelivery.findFirst({
				where: {
					targetKind: "completion_callback",
					targetId: callbackId,
					status: { in: active },
				},
			});
			if (known)
				return {
					row: known,
					bytes:
						known.status === "preparing"
							? await this.bytes(tx, known)
							: new Uint8Array(),
				};
			const at = await clock(tx);
			if (!callback.payload) {
				if (!status)
					throw new OutboundDeliveryError("outbound_delivery_unavailable");
				const payload = buildCallbackPayload({
					eventId: callback.eventId,
					workspaceId: callback.workspaceId,
					createdAt: at,
					status,
				});
				if (!payload) return null;
				callback = await tx.completionCallback.update({
					where: { id: callbackId },
					data: {
						state: "pending",
						payload: payload as unknown as Prisma.InputJsonValue,
						nextAttemptAt: at,
						leaseOwner: null,
						leaseExpiresAt: null,
					},
				});
			}
			return this.create(tx, {
				workspaceId: callback.workspaceId,
				targetKind: "completion_callback",
				targetId: callback.id,
				eventId: callback.eventId,
				registration: callback,
				payload: callback.payload,
				at,
				maxAttempts: 10,
			});
		});
		if (!admitted)
			return {
				kind:
					initial.state === "waiting"
						? ("waiting" as const)
						: ("terminal" as const),
			};
		const result = await this.seal(admitted.row, admitted.bytes);
		return { kind: "accepted" as const, deliveryId: result.deliveryId };
	}
	/** A targeted subscription wake selects exactly the next matching event.
	 * Caught-up subscriptions own no timer, SQL poller, or renewable lease. */
	async prepareSubscription(
		id: string,
	): Promise<
		| { kind: "idle" | "terminal" }
		| { kind: "sleep"; dueAt: Date }
		| { kind: "accepted"; deliveryId: string }
	> {
		const initial = await this.database.webhookSubscription.findUnique({
			where: { id },
		});
		if (!initial) return { kind: "terminal" };
		const result = await this.database.$transaction(async (tx) => {
			await this.epoch(tx);
			await this.lockParent(tx, {
				workspaceId: initial.workspaceId,
				targetKind: "webhook_event",
				targetId: id,
			});
			const sub = await tx.webhookSubscription.findUniqueOrThrow({
				where: { id },
			});
			const at = await clock(tx);
			if (sub.status !== "active") return { kind: "terminal" as const };
			const known = await tx.outboundDelivery.findFirst({
				where: {
					targetKind: "webhook_event",
					targetId: id,
					status: { in: active },
				},
			});
			if (known)
				return {
					kind: "body" as const,
					row: known,
					bytes:
						known.status === "preparing"
							? await this.bytes(tx, known)
							: new Uint8Array(),
				};
			if (!(await this.entitled(tx, sub.workspaceId))) {
				const dueAt = new Date(at.getTime() + holdMs);
				await tx.webhookSubscription.update({
					where: { id },
					data: {
						nextAttemptAt: dueAt,
						leaseOwner: null,
						leaseExpiresAt: null,
					},
				});
				return { kind: "sleep" as const, dueAt };
			}
			if (sub.nextAttemptAt > at)
				return { kind: "sleep" as const, dueAt: sub.nextAttemptAt };
			const head =
				(
					await tx.workspaceEventCounter.findUnique({
						where: { workspaceId: sub.workspaceId },
					})
				)?.lastSeq ?? 0n;
			const oldest = await tx.workspaceEvent.findFirst({
				where: { workspaceId: sub.workspaceId },
				orderBy: { seq: "asc" },
				select: { seq: true },
			});
			const floor = oldest ? oldest.seq - 1n : head;
			let cursor = sub.lastDeliveredSeq;
			if (sub.skipExpiredOnResume) {
				if (cursor < floor) cursor = floor;
				await tx.webhookSubscription.update({
					where: { id },
					data: { lastDeliveredSeq: cursor, skipExpiredOnResume: false },
				});
			} else if (cursor < floor) {
				await this.disable(tx, sub, "cursor_expired", at);
				return { kind: "terminal" as const };
			}
			const event = await tx.workspaceEvent.findFirst({
				where: {
					workspaceId: sub.workspaceId,
					seq: { gt: cursor, lte: head },
					type: { in: sub.types },
				},
				orderBy: { seq: "asc" },
			});
			if (!event) {
				await tx.webhookSubscription.update({
					where: { id },
					data: {
						lastDeliveredSeq: head,
						leaseOwner: null,
						leaseExpiresAt: null,
					},
				});
				return { kind: "idle" as const };
			}
			const created = await this.create(tx, {
				workspaceId: sub.workspaceId,
				targetKind: "webhook_event",
				targetId: sub.id,
				eventId: event.id,
				eventSeq: event.seq,
				registration: sub,
				payload: {
					id: event.id,
					seq: Number(event.seq),
					type: event.type,
					version: event.version,
					occurredAt: event.occurredAt.toISOString(),
					workspaceId: sub.workspaceId,
					subject: event.subject,
				},
				at,
				expiresAt: new Date(event.createdAt.getTime() + expiryMs),
				maxAttempts: 20,
			});
			return { kind: "body" as const, ...created };
		});
		if (result.kind !== "body") return result;
		const accepted = await this.seal(result.row, result.bytes);
		return { kind: "accepted", deliveryId: accepted.deliveryId };
	}
	private async entitled(tx: Tx, id: string) {
		const w = await tx.workspace.findUnique({
			where: { id },
			select: { status: true, pricingTier: true },
		});
		return (
			w?.status === "active" && hasFeature(w.pricingTier, "integrations.api")
		);
	}
	private async disable(
		tx: Tx,
		sub: WebhookSubscription,
		reason: string,
		at: Date,
	) {
		await tx.webhookSubscription.update({
			where: { id: sub.id },
			data: {
				status: "disabled",
				disabledReason: reason,
				disabledAt: at,
				disabledNotifiedAt: null,
				leaseOwner: null,
				leaseExpiresAt: null,
			},
		});
	}
	private async policy(
		tx: Tx,
		row: OutboundDelivery,
		at: Date,
	): Promise<"current" | "cancel" | "hold"> {
		if (row.expiresAt <= at) return "cancel";
		if (row.targetKind === "completion_callback") {
			const parent = await tx.completionCallback.findUnique({
				where: { id: row.targetId },
			});
			if (
				!parent ||
				parent.workspaceId !== row.workspaceId ||
				parent.urlFingerprint !== row.urlFingerprint ||
				parent.state !== "pending" ||
				parent.eventId !== row.eventId
			)
				return "cancel";
			const payload = parent.payload as {
				data?: { projectId?: string | null };
			} | null;
			if (
				payload?.data?.projectId &&
				!(await tx.project.findFirst({
					where: { id: payload.data.projectId, workspaceId: row.workspaceId },
					select: { id: true },
				}))
			)
				return "cancel";
			return "current";
		}
		const sub = await tx.webhookSubscription.findUnique({
			where: { id: row.targetId },
		});
		if (
			!sub ||
			sub.workspaceId !== row.workspaceId ||
			sub.urlFingerprint !== row.urlFingerprint
		)
			return "cancel";
		if (row.targetKind === "webhook_test") {
			try {
				await this.actor(
					tx,
					{
						workspaceId: row.workspaceId,
						actorUserId: row.createdByUserId!,
					},
					row.actorCapability as "api.manage" | "processing.consume",
				);
				if (row.apiKeyId) {
					await tx.$queryRaw`SELECT "id" FROM "ApiKey" WHERE "id"=${row.apiKeyId}::uuid FOR SHARE`;
					const key = await tx.apiKey.findUnique({
						where: { id: row.apiKeyId },
					});
					if (
						!key ||
						key.revokedAt ||
						key.workspaceId !== row.workspaceId ||
						(key.createdByUserId ?? key.userId) !== row.createdByUserId ||
						!key.scopes.includes("processing:write") ||
						(WORKSPACE_EVENT_PUBLISHING_TYPES.some((type) =>
							sub.types.includes(type),
						) &&
							!key.scopes.includes("publishing:read"))
					)
						return "cancel";
				}
			} catch {
				return "cancel";
			}
			return "current";
		}
		if (sub.status !== "active" || sub.lastDeliveredSeq >= row.eventSeq!)
			return "cancel";
		if (!(await this.entitled(tx, row.workspaceId))) return "hold";
		const event = await tx.workspaceEvent.findUnique({
			where: { id: row.eventId },
		});
		if (
			!event ||
			event.workspaceId !== row.workspaceId ||
			event.seq !== row.eventSeq ||
			!sub.types.includes(event.type)
		) {
			await this.disable(tx, sub, "cursor_expired", at);
			return "cancel";
		}
		return "current";
	}
	private async transitionPolicy(tx: Tx, row: OutboundDelivery, at: Date) {
		const policy = await this.policy(tx, row, at);
		if (policy === "current") return null;
		if (policy === "hold") {
			const dueAt = new Date(at.getTime() + holdMs);
			const updated = await tx.outboundDelivery.update({
				where: { id: row.id },
				data: {
					status: "queued",
					generation: { increment: 1 },
					attemptToken: null,
					executorOwner: null,
					leaseExpiresAt: null,
					operationDeadlineAt: null,
					retryAt: dueAt,
				},
			});
			await tx.webhookSubscription.update({
				where: { id: row.targetId },
				data: { nextAttemptAt: dueAt, leaseOwner: null, leaseExpiresAt: null },
			});
			return {
				kind: "terminal" as const,
				disposition: { disposition: "superseded" as const },
				dispatchIds: await this.register(tx, updated),
			};
		}
		const cancelled = await tx.outboundDelivery.update({
			where: { id: row.id },
			data: {
				status: "cancelled",
				executorOwner: null,
				leaseExpiresAt: null,
				completedAt: at,
				errorCode: "delivery_authority_cancelled",
			},
		});
		if (row.targetKind === "completion_callback")
			await tx.completionCallback.updateMany({
				where: { id: row.targetId, state: "pending" },
				data: { state: "cancelled", leaseOwner: null, leaseExpiresAt: null },
			});
		if (row.targetKind === "webhook_event" && row.expiresAt <= at) {
			const subscription = await tx.webhookSubscription.findUnique({
				where: { id: row.targetId },
			});
			if (subscription?.status === "active")
				await this.disable(tx, subscription, "cursor_expired", at);
		}
		const continuation = await this.terminalWakes(
			tx,
			cancelled,
			at,
			"notification_cancelled",
		);
		return {
			kind: "terminal" as const,
			disposition: { disposition: "cancelled" as const },
			dispatchIds: continuation.dispatchIds,
		};
	}
	async lockExecution(
		tx: Tx,
		reference: ExecutionDispatchReference,
		attemptToken: string,
	): Promise<ExecutorDomainLock<OutboundDeliveryReference>> {
		const initial = await tx.outboundDelivery.findUnique({
			where: { id: reference.subject.id },
		});
		const superseded = () => ({
			kind: "terminal" as const,
			disposition: { disposition: "superseded" as const },
		});
		if (
			!initial ||
			reference.subject.kind !== "outbound_delivery" ||
			reference.kind !== "modal_execution"
		)
			return superseded();
		await this.lockParent(tx, initial);
		await tx.$queryRaw`SELECT "id" FROM "OutboundDelivery" WHERE "id"=${initial.id}::uuid FOR UPDATE`;
		const row = await tx.outboundDelivery.findUniqueOrThrow({
			where: { id: initial.id },
		});
		if (
			row.generation !== reference.generation ||
			row.deploymentEpoch !== reference.deploymentEpoch ||
			row.inputHash !== reference.inputHash ||
			row.attemptToken !== attemptToken
		)
			return superseded();
		if (row.status === "completed")
			return {
				kind: "terminal" as const,
				disposition: { disposition: "completed" as const },
			};
		if (row.status === "failed")
			return {
				kind: "terminal" as const,
				disposition: {
					disposition: "failed" as const,
					failureCode: row.errorCode ?? "notification_unconfirmed",
				},
			};
		if (row.status === "cancelled")
			return {
				kind: "terminal" as const,
				disposition: { disposition: "cancelled" as const },
			};
		const changed = await this.transitionPolicy(tx, row, await clock(tx));
		if (changed) return changed;
		return {
			kind: "current" as const,
			ref: {
				id: row.id,
				attemptToken,
				generation: row.generation,
				deploymentEpoch: row.deploymentEpoch,
			},
		};
	}
	async prepareExecution(
		reference: ExecutionDispatchReference,
	): Promise<OutboundDeliveryPreparation> {
		const prepared = await this.database.$transaction(
			async (tx): Promise<OutboundDeliveryPreparation> => {
				const [epoch] = await tx.$queryRaw<
					Array<{ epoch: number }>
				>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
				if (
					reference.kind !== "operation_driver" ||
					reference.subject.kind !== "outbound_delivery" ||
					epoch?.epoch !== reference.deploymentEpoch
				)
					return { kind: "superseded" };
				const ledger = (await readExecutionDispatch(tx, reference.dispatchId))
					?.reference;
				if (
					!ledger ||
					ledger.inputHash !== reference.inputHash ||
					ledger.subject.id !== reference.subject.id ||
					ledger.subject.kind !== reference.subject.kind ||
					ledger.kind !== reference.kind ||
					ledger.generation !== reference.generation ||
					ledger.deploymentEpoch !== reference.deploymentEpoch
				)
					return { kind: "superseded" };
				const initial = await tx.outboundDelivery.findUnique({
					where: { id: reference.subject.id },
				});
				if (!initial) return { kind: "superseded" };
				await this.lockParent(tx, initial);
				await tx.$queryRaw`SELECT "id" FROM "OutboundDelivery" WHERE "id"=${initial.id}::uuid FOR UPDATE`;
				const row = await tx.outboundDelivery.findUniqueOrThrow({
						where: { id: initial.id },
					}),
					at = await clock(tx);
				if (
					row.generation !== reference.generation ||
					row.deploymentEpoch !== reference.deploymentEpoch ||
					row.inputHash !== reference.inputHash
				)
					return { kind: "superseded" };
				if (final.includes(row.status)) return { kind: "terminal" };
				if (row.status === "queued" && row.chargedAttempts >= row.maxAttempts) {
					const result = await this.exhausted(tx, row, at);
					return { kind: "terminal", dispatchIds: result.dispatchIds };
				}
				const changed = await this.transitionPolicy(tx, row, at);
				if (changed)
					return { kind: "terminal", dispatchIds: changed.dispatchIds };
				if (row.retryAt && row.retryAt > at)
					return { kind: "sleep", dueAt: row.retryAt };
				if (row.status === "preparing")
					throw new OutboundDeliveryError(
						"outbound_delivery_unavailable",
						row.id,
					);
				const keys = await tx.callbackSigningSecret.count({
					where: {
						workspaceId: row.workspaceId,
						OR: [{ retiresAt: null }, { retiresAt: { gt: at } }],
					},
				});
				if (!keys) {
					const failed = await this.settle(
						tx,
						row,
						at,
						null,
						0,
						"signing_secret_missing",
					);
					return { kind: "terminal", dispatchIds: failed?.dispatchIds };
				}
				const token = row.attemptToken ?? randomUUID(),
					until =
						row.operationDeadlineAt ??
						new Date(
							Math.min(at.getTime() + attemptMs, row.expiresAt.getTime()),
						);
				const dispatch = await appendExecutionDispatch(tx, {
					deploymentEpoch: row.deploymentEpoch,
					generation: row.generation,
					kind: "modal_execution",
					subject: { kind: "outbound_delivery", id: row.id },
					inputHash: row.inputHash,
					dueAt: row.retryAt ?? row.createdAt,
				});
				await tx.executionAttempt.upsert({
					where: { attemptToken: token },
					create: {
						attemptToken: token,
						dispatchId: dispatch.reference.dispatchId,
						deploymentEpoch: row.deploymentEpoch,
						generation: row.generation,
						inputHash: row.inputHash,
						functionName: "outbound_delivery",
						operationDeadlineAt: until,
					},
					update: {},
				});
				if (!row.attemptToken)
					await tx.outboundDelivery.update({
						where: { id: row.id },
						data: { attemptToken: token, operationDeadlineAt: until },
					});
				const observed = row.leaseExpiresAt ?? until,
					kind = row.leaseExpiresAt
						? ("lease" as const)
						: ("operation" as const);
				const deadline = {
					reference: dispatch.reference,
					attemptToken: token,
					kind,
					observedDeadlineAt: observed.toISOString(),
				};
				const watch = await appendExecutionDispatch(tx, {
					deploymentEpoch: row.deploymentEpoch,
					generation: row.generation,
					kind: "operation_driver",
					subject: { kind: "outbound_delivery", id: row.id },
					inputHash: row.inputHash,
					dueAt: observed,
					deadlineKind: kind,
					observedDeadlineAt: observed,
				});
				return {
					kind: "waiting",
					deadline,
					deliveryId: watch.reference.dispatchId,
					dispatchIds: [
						watch.reference.dispatchId,
						dispatch.reference.dispatchId,
					],
				};
			},
		);
		if ("dispatchIds" in prepared && prepared.dispatchIds?.length)
			await this.confirm(reference.subject.id, prepared.dispatchIds);
		return prepared;
	}
	private async owned(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
	) {
		const at = await clock(tx);
		const row = await tx.outboundDelivery.findFirst({
			where: {
				id: ref.id,
				status: "processing",
				attemptToken: c.attemptToken,
				executorOwner: c.owner,
				generation: c.reference.generation,
				deploymentEpoch: c.reference.deploymentEpoch,
				leaseExpiresAt: { gt: at },
				operationDeadlineAt: { gt: at },
			},
		});
		if (!row || ref.attemptToken !== c.attemptToken)
			throw new OutboundDeliveryError("outbound_delivery_conflict");
		return { row, at };
	}
	async acquireExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		const row = await tx.outboundDelivery.findUniqueOrThrow({
				where: { id: ref.id },
			}),
			at = await clock(tx);
		if (
			row.status !== "queued" ||
			row.executorOwner ||
			row.chargedAttempts >= row.maxAttempts ||
			!row.operationDeadlineAt ||
			row.operationDeadlineAt <= at ||
			row.operationDeadlineAt.getTime() !== c.operationDeadlineAt.getTime() ||
			(row.retryAt && row.retryAt > at)
		)
			throw new OutboundDeliveryError("outbound_delivery_conflict");
		await tx.outboundDelivery.update({
			where: { id: ref.id },
			data: {
				status: "processing",
				executorOwner: c.owner,
				leaseExpiresAt: c.leaseExpiresAt,
				errorCode: null,
			},
		});
		return this.wake(tx, row, at, "notification_acquired", c.leaseExpiresAt);
	}
	async renewExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		await tx.outboundDelivery.update({
			where: { id: ref.id },
			data: { leaseExpiresAt: c.leaseExpiresAt },
		});
		return undefined;
	}
	async startExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		const { row } = await this.owned(tx, ref, c);
		if (row.chargedAttempts >= row.maxAttempts)
			throw new OutboundDeliveryError("outbound_delivery_conflict");
		await tx.outboundDelivery.update({
			where: { id: row.id },
			data: { chargedAttempts: { increment: 1 } },
		});
		if (row.targetKind === "completion_callback")
			await tx.completionCallback.update({
				where: { id: row.targetId },
				data: { attempts: { increment: 1 } },
			});
		return undefined;
	}
	async progressExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		return undefined;
	}
	async commitArtifactExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
		artifact: NotificationArtifact,
	): Promise<ExecutorMutationResult> {
		const { row, at } = await this.owned(tx, ref, c),
			receipt = notificationReceiptSchema.parse(artifact.receipt);
		if (
			artifact.role !== "outbound_receipt" ||
			artifact.contentType !== "application/json" ||
			artifact.bindingHash !== row.inputHash ||
			artifact.byteLength < 1n ||
			artifact.byteLength > 65536n ||
			receipt.deliveryId !== row.id ||
			receipt.eventId !== row.eventId ||
			receipt.workspaceId !== row.workspaceId ||
			receipt.inputHash !== row.inputHash ||
			receipt.bodySha256 !== row.bodySha256
		)
			throw new OutboundDeliveryError("outbound_delivery_invalid");
		await tx.outboundDelivery.update({
			where: { id: row.id },
			data: { lastReceiptArtifactId: artifact.artifactId },
		});
		return this.settle(
			tx,
			row,
			at,
			receipt.status,
			receipt.durationMs,
			receipt.errorCode,
		);
	}
	/** Cursor/parent result and assigned receipt adoption commit together. A
	 * transport crash remains unconfirmed and retries the same event identity. */
	private async settle(
		tx: Tx,
		row: OutboundDelivery,
		at: Date,
		status: number | null,
		durationMs: number,
		errorCode: string | null,
	): Promise<ExecutorMutationResult> {
		const delivered = status !== null && status >= 200 && status < 300,
			gone = status === 410;
		let failures = row.policyFailures + 1,
			retry = !delivered && !gone,
			delay =
				nextAttemptDelayMs(failures, this.dependencies.random ?? Math.random) ??
				CALLBACK_RETRY_DELAYS_MS.at(-1)!;
		if (row.targetKind === "completion_callback") {
			const parent = await tx.completionCallback.findUniqueOrThrow({
				where: { id: row.targetId },
			});
			retry =
				retry &&
				parent.attempts < 10 &&
				failures < 10 &&
				row.chargedAttempts < row.maxAttempts &&
				row.expiresAt.getTime() > at.getTime() + delay;
			await tx.completionCallback.update({
				where: { id: parent.id },
				data: {
					state: delivered
						? "delivered"
						: gone
							? "cancelled"
							: retry
								? "pending"
								: "failed",
					lastResponseStatus: status,
					deliveredAt: delivered ? at : null,
					nextAttemptAt: retry ? new Date(at.getTime() + delay) : null,
					leaseOwner: null,
					leaseExpiresAt: null,
				},
			});
		} else if (row.targetKind === "webhook_event") {
			const sub = await tx.webhookSubscription.findUniqueOrThrow({
				where: { id: row.targetId },
			});
			failures = sub.consecutiveFailures + 1;
			delay =
				nextAttemptDelayMs(
					Math.min(failures, CALLBACK_RETRY_DELAYS_MS.length),
					this.dependencies.random ?? Math.random,
				) ?? CALLBACK_RETRY_DELAYS_MS.at(-1)!;
			retry =
				retry &&
				failures < 20 &&
				row.chargedAttempts < row.maxAttempts &&
				row.expiresAt.getTime() > at.getTime() + delay;
			await tx.webhookSubscription.update({
				where: { id: sub.id },
				data: {
					lastAttemptAt: at,
					lastResponseStatus: status,
					consecutiveFailures: delivered ? 0 : failures,
					...(delivered
						? { lastDeliveredSeq: row.eventSeq!, lastDeliveredAt: at }
						: {}),
					nextAttemptAt: retry ? new Date(at.getTime() + delay) : at,
					leaseOwner: null,
					leaseExpiresAt: null,
				},
			});
			if (gone || (!delivered && !retry))
				await this.disable(
					tx,
					sub,
					gone
						? "endpoint_gone"
						: failures >= 20
							? "consecutive_failures"
							: row.chargedAttempts >= row.maxAttempts
								? "delivery_attempts_exhausted"
								: "cursor_expired",
					at,
				);
		} else retry = false;
		retry =
			retry &&
			row.chargedAttempts < row.maxAttempts &&
			row.expiresAt.getTime() > at.getTime() + delay;
		const updated = await tx.outboundDelivery.update({
			where: { id: row.id },
			data: {
				status: delivered
					? "completed"
					: gone
						? "cancelled"
						: retry
							? "queued"
							: "failed",
				policyFailures: { increment: delivered ? 0 : 1 },
				lastResponseStatus: status,
				durationMs,
				errorCode: delivered
					? null
					: (errorCode ??
						(status === null ? "notification_unconfirmed" : `http_${status}`)),
				executorOwner: null,
				leaseExpiresAt: null,
				...(retry
					? {
							generation: { increment: 1 },
							attemptToken: null,
							operationDeadlineAt: null,
							retryAt: new Date(at.getTime() + delay),
							completedAt: null,
						}
					: { completedAt: at, retryAt: null }),
			},
		});
		if (retry) return { dispatchIds: await this.register(tx, updated) };
		return this.terminalWakes(
			tx,
			updated,
			at,
			delivered ? "notification_delivered" : "notification_terminal",
		);
	}
	private async terminalWakes(
		tx: Tx,
		row: OutboundDelivery,
		at: Date,
		wakeKind: string,
	) {
		const local = await this.wake(tx, row, at, wakeKind);
		if (row.targetKind === "webhook_event") {
			const subscription = await tx.webhookSubscription.findUnique({
				where: { id: row.targetId },
			});
			if (subscription) {
				const continuation = await appendExecutionDispatch(tx, {
					deploymentEpoch: row.deploymentEpoch,
					generation: 1,
					kind: "operation_driver",
					subject: { kind: "webhook_subscription", id: subscription.id },
					inputHash: webhookSubscriptionExecutionInputHash(subscription),
					dueAt: at,
					wakeKind: `notify_${row.id.replaceAll("-", "")}`,
				});
				return {
					dispatchIds: [
						...local.dispatchIds,
						continuation.reference.dispatchId,
					],
				};
			}
		}
		return local;
	}
	private async exhausted(tx: Tx, row: OutboundDelivery, at: Date) {
		const updated = await tx.outboundDelivery.update({
			where: { id: row.id },
			data: {
				status: "failed",
				completedAt: at,
				executorOwner: null,
				leaseExpiresAt: null,
				retryAt: null,
				errorCode: "delivery_attempts_exhausted",
			},
		});
		if (row.targetKind === "webhook_event") {
			const sub = await tx.webhookSubscription.findUnique({
				where: { id: row.targetId },
			});
			if (sub) await this.disable(tx, sub, "delivery_attempts_exhausted", at);
		} else if (row.targetKind === "completion_callback")
			await tx.completionCallback.updateMany({
				where: { id: row.targetId, state: "pending" },
				data: {
					state: "failed",
					leaseOwner: null,
					leaseExpiresAt: null,
					nextAttemptAt: null,
				},
			});
		return this.terminalWakes(tx, updated, at, "notification_terminal");
	}

	async failExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
		f: { failureCode: string; retryable: boolean },
	): Promise<ExecutorMutationResult> {
		const { row, at } = await this.owned(tx, ref, c);
		return this.settle(tx, row, at, null, 0, f.failureCode);
	}
	async releaseExecution(
		tx: Tx,
		ref: OutboundDeliveryReference,
		c: ExecutorMutationContext,
		r: { reason: string },
	): Promise<ExecutorMutationResult> {
		const { row, at } = await this.owned(tx, ref, c);
		// Parent cancellation is decided by lockExecution. A stopped physical
		// POST with current authority is unconfirmed, so retain this round's budget.
		return this.settle(tx, row, at, null, 0, `notification_${r.reason}`);
	}
	async expireExecution(
		tx: Tx,
		reference: ExecutionDispatchReference,
		token: string,
		observation: ExecutorExpiryObservation,
	): Promise<ExecutorExpiryResult> {
		const locked = await this.lockExecution(tx, reference, token);
		if (locked.kind === "terminal")
			return {
				kind:
					locked.disposition.disposition === "superseded"
						? "superseded"
						: "terminal",
				dispatchIds: "dispatchIds" in locked ? locked.dispatchIds : undefined,
			};
		const row = await tx.outboundDelivery.findUniqueOrThrow({
				where: { id: locked.ref.id },
			}),
			at = await clock(tx),
			due =
				observation.kind === "lease"
					? row.leaseExpiresAt
					: row.operationDeadlineAt;
		if (!due || due.getTime() !== observation.observedDeadlineAt.getTime())
			return { kind: "superseded" };
		if (due > at) return { kind: "sleep", dueAt: due };
		const attempt = await tx.executionAttempt.findUnique({
			where: { attemptToken: token },
			select: { processStartedAt: true },
		});
		const result = await this.settle(
			tx,
			row,
			at,
			null,
			0,
			attempt?.processStartedAt
				? "notification_outcome_unconfirmed"
				: "notification_start_unconfirmed",
		);
		return { kind: "expired", dispatchIds: result?.dispatchIds };
	}
	private async register(tx: Tx, row: OutboundDelivery) {
		if (final.includes(row.status) || row.status === "preparing") return [];
		const d = await appendExecutionDispatch(tx, {
			deploymentEpoch: row.deploymentEpoch,
			generation: row.generation,
			kind: "operation_driver",
			subject: { kind: "outbound_delivery", id: row.id },
			inputHash: row.inputHash,
			dueAt: row.retryAt ?? row.createdAt,
		});
		return [d.reference.dispatchId];
	}
	private async wake(
		tx: Tx,
		row: OutboundDelivery,
		at: Date,
		wakeKind: string,
		lease?: Date,
	) {
		const d = await appendExecutionDispatch(tx, {
			deploymentEpoch: row.deploymentEpoch,
			generation: row.generation,
			kind: "operation_driver",
			subject: { kind: "outbound_delivery", id: row.id },
			inputHash: row.inputHash,
			dueAt: at,
			wakeKind,
			...(lease
				? { deadlineKind: "lease" as const, observedDeadlineAt: lease }
				: {}),
		});
		return { dispatchIds: [d.reference.dispatchId] };
	}
	private async confirm(id: string, ids: readonly string[]) {
		if (!ids.length) return;
		try {
			await this.dependencies.register(ids);
		} catch {
			throw new OutboundDeliveryError("outbound_delivery_unavailable", id);
		}
	}
	/** Full-byte verification and streaming Standard Webhooks HMAC stay in the
	 * Worker. Only the resulting bounded signature headers leave this boundary. */
	async workInput(id: string) {
		const row = await this.database.outboundDelivery.findUnique({
			where: { id },
		});
		if (!row || !row.bodyEtag || !active.includes(row.status))
			throw new OutboundDeliveryError("outbound_delivery_missing");
		const at = new Date(),
			secrets = await this.database.callbackSigningSecret.findMany({
				where: {
					workspaceId: row.workspaceId,
					OR: [{ retiresAt: null }, { retiresAt: { gt: at } }],
				},
				orderBy: { createdAt: "desc" },
				select: { encryptedSecret: true },
			});
		if (!secrets.length)
			throw new OutboundDeliveryError("outbound_delivery_unavailable", id);
		const timestamp = Math.floor(at.getTime() / 1000),
			prefix = `${row.eventId}.${timestamp}.`,
			cipher = this.cipher();
		const signatures = secrets.map((s) =>
			createHmac(
				"sha256",
				Buffer.from(
					cipher.open(s.encryptedSecret).replace(/^whsec_/, ""),
					"base64",
				),
			).update(prefix),
		);
		const digest = createHash("sha256"),
			reader = (
				await this.dependencies.body.read({ ...plan(row), etag: row.bodyEtag })
			).getReader();
		let size = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.byteLength;
				if (
					size > NOTIFICATION_BODY_MAX_BYTES ||
					BigInt(size) > row.bodyByteLength
				)
					throw new OutboundDeliveryError("outbound_delivery_invalid");
				digest.update(next.value);
				for (const signature of signatures) signature.update(next.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		if (
			BigInt(size) !== row.bodyByteLength ||
			digest.digest("hex") !== row.bodySha256
		)
			throw new OutboundDeliveryError("outbound_delivery_invalid");
		const command = signedNotificationCommandSchema.parse({
			kind: "signed_notification",
			deliveryId: row.id,
			eventId: row.eventId,
			workspaceId: row.workspaceId,
			inputHash: row.inputHash,
			url: cipher.open(row.encryptedUrl),
			body: {
				source: "notification_body",
				sha256: row.bodySha256,
				byteLength: Number(row.bodyByteLength),
			},
			headers: {
				"content-type": "application/json",
				"user-agent": "Narriflow-Callbacks/1",
				"webhook-id": row.eventId,
				"webhook-timestamp": String(timestamp),
				"webhook-signature": signatures
					.map((s) => `v1,${s.digest("base64")}`)
					.join(" "),
			},
		});
		return {
			inputHash: row.inputHash,
			command,
			sources: [
				{
					name: "notification_body",
					storageKey: row.bodyStorageKey,
					etag: row.bodyEtag,
					sha256: row.bodySha256,
					byteLength: Number(row.bodyByteLength),
					contentType: "application/json",
				},
			],
			outputs: [
				{
					role: "outbound_receipt" as const,
					contentType: "application/json",
					maxBytes: 65536,
					bindingHash: row.inputHash,
				},
			],
		};
	}
}
