import { PublicationExecution } from "./publication-execution";
import { createPublicationCheckpointCipher } from "./social-publication-checkpoint-cipher";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { withServiceEnvironment } from "./runtime-environment";
import { socialPublicationRecovery } from "./social-publication-recovery";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import {
	appendPublicationDispatch,
	observePublicationSchedule,
	publicationExecutionInputHash,
} from "./publication-dispatch";
import { createHash } from "node:crypto";
import { createExecutionTransfer } from "./execution-transfer";
import { createExecutorControl } from "./executor-control";
import type { ExecutorDomainControl } from "./executor-domain-control";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite =
	process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url
		? describe
		: describe.skip;
suite("Revision-bound publication execution", () => {
	let db: PrismaClient;
	beforeAll(() => {
		const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
		assertExecutionDatabaseTestTarget(url, schema);
		if (!schema.startsWith("serverless_execution_test_"))
			throw Error("Disposable schema required");
		db = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }),
		});
	});
	afterAll(async () => {
		await db?.$disconnect();
	});
	async function fixture(ready = true) {
		const suffix = crypto.randomUUID(),
			user = await db.user.create({
				data: { clerkId: `publication-execution:${suffix}` },
			});
		const workspace = await db.workspace.create({
			data: {
				name: "Native publication",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
				pricingTier: "business",
			},
		});
		await db.workspaceMember.create({
			data: { workspaceId: workspace.id, userId: user.id, role: "owner" },
		});
		const project = await db.project.create({
			data: {
				workspaceId: workspace.id,
				createdByUserId: user.id,
				title: "Publication",
				sourceMediaUrl: "r2://test/source",
			},
		});
		const run = await db.workflowRun.create({
			data: {
				projectId: project.id,
				idempotencyKey: `publication:${suffix}`,
				stage: "clip_rendering",
				status: "completed",
			},
		});
		const clip = await db.clip.create({
			data: {
				projectId: project.id,
				workflowRunId: run.id,
				index: 0,
				startSec: 0,
				endSec: 30,
				hookText: "Fixture",
				reasoning: "Fixture",
				category: "hook",
				transcriptSlice: [],
				viralityScore: 80,
				hookStrengthScore: 80,
				emotionalIntensityScore: 80,
				pacingScore: 80,
				durationOptimalityScore: 80,
				tiktokScore: 80,
				youtubeScore: 80,
				instagramScore: 80,
				llmProvider: "test",
				llmModel: "test",
			},
		});
		const exp = await db.clipExport.create({
			data: {
				projectId: project.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				clipId: clip.id,
				editorRevision: clip.editorRevision,
				fingerprint: suffix,
				resolution: "1080p",
				watermark: false,
				status: ready ? "ready" : "queued",
			},
		});
		const variant = await db.clipExportVariant.create({
			data: {
				exportId: exp.id,
				aspectRatio: "ratio_9_16",
				resolution: "1080p",
				watermark: false,
				status: ready ? "completed" : "pending",
				...(ready
					? {
							storageKey: `test/${suffix}.mp4`,
							sizeBytes: 1234n,
							durationSec: 30,
						}
					: {}),
			},
		});
		const account = await db.socialAccount.create({
			data: {
				userId: user.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				platform: "youtube_shorts",
				providerAccountId: suffix,
				displayName: "Fixture",
				accessTokenEncrypted: "sealed",
			},
		});
		const due = new Date(Date.now() + 60000);
		const post = await db.socialPost.create({
			data: {
				workspaceId: workspace.id,
				projectId: project.id,
				createdByUserId: user.id,
				clipId: clip.id,
				socialAccountId: account.id,
				platform: "youtube_shorts",
				status: ready ? "scheduled" : "preparing_video",
				clientIdempotencyKey: suffix,
				immutableRequestHash: suffix,
				caption: "Frozen private copy",
				scheduledFor: due,
				frozenState: {
					create: {
						clipExportId: exp.id,
						clipExportVariantId: variant.id,
						socialAccountId: account.id,
						platform: "youtube_shorts",
						editorRevision: clip.editorRevision,
						exportFingerprint: suffix,
						aspectRatio: "ratio_9_16",
						caption: "Frozen private copy",
						providerSettings: { confirmedBy: user.id },
						capabilityVersion: "fixture",
						scheduledFor: due,
						...(ready
							? {
									storageKey: variant.storageKey,
									sizeBytes: variant.sizeBytes,
									durationSec: 30,
									mediaReadyAt: new Date(),
								}
							: {}),
					},
				},
			},
			include: { frozenState: true },
		});
		const id = await db.$transaction((tx) =>
			appendPublicationDispatch(tx, post.id),
		);
		const record = (await readExecutionDispatch(db, id))!;
		await db.executionDispatch.update({
			where: { id },
			data: { acknowledgedAt: new Date() },
		});
		return { post, record, variant };
	}

	async function active() {
		const f = await fixture(),
			due = new Date(Date.now() - 1000);
		const id = await db.$transaction(async (tx) => {
			await tx.socialPost.update({
				where: { id: f.post.id },
				data: { scheduledFor: due },
			});
			return appendPublicationDispatch(tx, f.post.id);
		});
		const reference = (await readExecutionDispatch(db, id))!.reference;
		const objects = new Map<
			string,
			{ etag: string; sha256: string; byteLength: number }
		>();
		let lostPutAck = false,
			beforePut: (() => Promise<void>) | undefined;
		const register = async (ids: readonly string[]) => {
			await db.executionDispatch.updateMany({
				where: { id: { in: [...ids] } },
				data: { acknowledgedAt: new Date() },
			});
		};
		const domain = new PublicationExecution(db, {
			config: {
				operationDeadlineMs: 600000,
				providerCallBudget: 10,
				processingDeadlineMs: 3600000,
				reconciliationDeadlineMs: 7200000,
				retry: {
					maxAttempts: 4,
					maxElapsedMs: 3600000,
					baseDelayMs: 1000,
					maxDelayMs: 60000,
					jitterRatio: 0,
					random: () => 0,
				},
			},
			checkpointCipher: createPublicationCheckpointCipher(
				Buffer.alloc(32, 1).toString("base64"),
			),
			planRefusal: async () => null,
			buildInput: async (snapshot) => ({
				bytes: new TextEncoder().encode(
					JSON.stringify({
						postId: snapshot.post.id,
						attemptId: snapshot.attempt.id,
						claimId: snapshot.claim.id,
						nonce: (snapshot.claim.workState as { nonce: string }).nonce,
					}),
				),
				sources: [],
			}),
			inputStorage: {
				head: async (plan) => objects.get(plan.storageKey) ?? null,
				put: async (plan) => {
					await beforePut?.();
					objects.set(plan.storageKey, {
						etag: '"sealed"',
						sha256: plan.sha256,
						byteLength: plan.byteLength,
					});
					if (lostPutAck) throw Error("lost_put_ack");
				},
			},
			register,
		});
		const control = createExecutorControl({
			database: db,
			domain,
			subjectKind: "social_publication",
			deliverWakes: register,
		});
		const call = (command: unknown, deliveryId = crypto.randomUUID()) =>
			control.execute({
				command,
				verifiedRequest: {
					requestHash: createHash("sha256")
						.update(JSON.stringify(command))
						.digest("hex"),
					metadata: {
						version: 1,
						keyId: "fixture",
						audience: "executor-control",
						method: "POST",
						canonicalTarget: "/api/execution/command",
						bodySha256: "0".repeat(64),
						timestamp: Math.floor(Date.now() / 1000),
						deliveryId,
						signature: "0".repeat(64),
					},
				},
			});
		await register([id]);
		return {
			...f,
			domain,
			control,
			reference,
			call,
			objects,
			hooks: {
				beforePut: (v: () => Promise<void>) => {
					beforePut = v;
				},
				lostPut: () => {
					lostPutAck = true;
				},
			},
		};
	}
	async function claimed(f: Awaited<ReturnType<typeof active>>) {
		const prepared = await f.domain.prepareExecution(f.reference);
		if (prepared.kind !== "waiting")
			throw Error(`Expected native waiting:${prepared.kind}`);
		const fence = {
			reference: prepared.deadline.reference,
			attemptToken: prepared.deadline.attemptToken,
			owner: crypto.randomUUID(),
		};
		await f.call({ action: "acquire", ...fence, leaseSeconds: 120 });
		return {
			fence,
			prepared,
			command: (command: unknown, id?: string) =>
				f.call({ action: "publication-command", fence, command }, id),
		};
	}
	test("targeted native publication seals private input before dispatch and charges only one real start", async () => {
		const f = await active();
		f.hooks.lostPut();
		f.hooks.beforePut(async () => {
			expect(
				await db.mediaCleanupObligation.count({
					where: {
						origin: "publication_execution",
						projectId: f.post.projectId,
						cleanupClass: "publication_private",
					},
				}),
			).toBe(1);
			expect(
				await db.executionDispatch.count({
					where: {
						subjectId: f.post.id,
						wakeKind: "publication_preparation_deadline",
						acknowledgedAt: { not: null },
					},
				}),
			).toBe(1);
			expect(
				await db.executionDispatch.count({
					where: { subjectId: f.post.id, kind: "modal_execution" },
				}),
			).toBe(0);
		});
		const p = await claimed(f);
		await f.call({ action: "process-start", fence: p.fence });
		await f.call({ action: "process-start", fence: p.fence });
		const attempt = await db.socialPublicationAttempt.findFirstOrThrow({
			where: { socialPostId: f.post.id },
		});
		expect(attempt.nativeStartCount).toBe(1);
		expect(attempt.nativeStartCeiling).toBe(14);
		expect(attempt.providerCallCeiling).toBe(10);
		expect(attempt.executionActorUserId).toBe(f.post.createdByUserId);
		expect(
			(
				await db.executionAttempt.findUniqueOrThrow({
					where: { attemptToken: p.fence.attemptToken },
				})
			).inputEtag,
		).toBe('"sealed"');
		const reply = await p.command({
			kind: "accepted",
			receipt: {
				receiptId: `confirmed:${f.post.id}`,
				platformPostId: "video",
				externalUrl: "https://youtube.com/shorts/video",
			},
		});
		expect(reply.disposition).toBe("publication_recorded");
		expect(
			(await db.socialPost.findUniqueOrThrow({ where: { id: f.post.id } }))
				.status,
		).toBe("posted");
		expect(
			await db.providerReceipt.count({ where: { attemptId: attempt.id } }),
		).toBe(1);
		expect(
			(
				await db.publicationClaim.findUniqueOrThrow({
					where: { id: p.fence.attemptToken },
				})
			).releasedAt,
		).not.toBeNull();
	});
	test("unknown initialization never creates another attempt automatically and drops its lease", async () => {
		const f = await active(),
			p = await claimed(f);
		await f.call({ action: "process-start", fence: p.fence });
		await p.command({
			kind: "provider_call",
			operation: "initialize",
			purpose: "primary_media",
		});
		await f.call({
			action: "fail",
			fence: p.fence,
			failureCode: "native_process_unconfirmed",
			retryable: true,
		});
		expect(
			(await db.socialPost.findUniqueOrThrow({ where: { id: f.post.id } }))
				.status,
		).toBe("needs_attention");
		expect(
			await db.socialPublicationAttempt.count({
				where: { socialPostId: f.post.id },
			}),
		).toBe(1);
		expect(
			(
				await db.publicationClaim.findUniqueOrThrow({
					where: { id: p.fence.attemptToken },
				})
			).releasedAt,
		).not.toBeNull();
		expect((await f.domain.prepareExecution(f.reference)).kind).toBe(
			"terminal",
		);
	});
	test("a native safe-retry label cannot create a new attempt after an unconfirmed initialize", async () => {
		const f = await active(),
			p = await claimed(f);
		await f.call({ action: "process-start", fence: p.fence });
		await p.command({
			kind: "provider_call",
			operation: "initialize",
			purpose: "primary_media",
		});
		await p.command({
			kind: "failed",
			failure: {
				code: "publication_transport_unconfirmed",
				phase: "preparation",
				disposition: "safe_retry",
				retryAfterMs: null,
			},
		});
		expect(
			(await db.socialPost.findUniqueOrThrow({ where: { id: f.post.id } }))
				.status,
		).toBe("needs_attention");
		expect(
			await db.socialPublicationAttempt.count({
				where: { socialPostId: f.post.id },
			}),
		).toBe(1);
	});
	test("actor revocation during private input storage commits a refusal before any native dispatch", async () => {
		const f = await active();
		f.hooks.beforePut(async () => {
			await db.workspaceMember.delete({
				where: {
					workspaceId_userId: {
						workspaceId: f.post.workspaceId!,
						userId: f.post.createdByUserId!,
					},
				},
			});
		});
		expect((await f.domain.prepareExecution(f.reference)).kind).toBe(
			"terminal",
		);
		expect(
			await db.executionDispatch.count({
				where: { subjectId: f.post.id, kind: "modal_execution" },
			}),
		).toBe(0);
		expect(
			(await db.socialPost.findUniqueOrThrow({ where: { id: f.post.id } }))
				.status,
		).toBe("failed");
		expect(
			(
				await db.socialPublicationAttempt.findFirstOrThrow({
					where: { socialPostId: f.post.id },
				})
			).currentClaimId,
		).toBeNull();
	});

	test("a confirmed pending operation releases SQL ownership and resumes the same attempt without new initialization", async () => {
		const f = await active(),
			p = await claimed(f);
		await f.call({ action: "process-start", fence: p.fence });
		const operation = {
			kind: "submission_started",
			state: {
				providerOperation: "youtube_resumable_upload",
				uploadUrl: "https://www.googleapis.com/private-resume",
				uploadedBytes: 0,
				totalBytes: 1234,
			},
		};
		await p.command({ kind: "checkpoint", operation });
		await p.command({
			kind: "pending",
			receiptId: "same-upload",
			operation,
			nextCheckAt: new Date(Date.now() + 60000).toISOString(),
			submissionStarted: false,
		});
		const attempt = await db.socialPublicationAttempt.findFirstOrThrow({
				where: { socialPostId: f.post.id },
			}),
			post = await db.socialPost.findUniqueOrThrow({
				where: { id: f.post.id },
			});
		expect(attempt.currentClaimId).toBeNull();
		expect(attempt.phase).toBe("processing");
		expect(post.generation).toBe(p.fence.reference.generation + 1);
		expect(attempt.idempotencyKey).toBe(`publication:${f.post.id}:1`);
		expect(attempt.checkpointEncrypted).not.toContain("private-resume");
		expect(
			(await f.call({ action: "process-start", fence: p.fence })).disposition,
		).toBe("superseded");
		expect(
			await db.socialPublicationAttempt.count({
				where: { socialPostId: f.post.id },
			}),
		).toBe(1);
	});
	test("registration is eligible now while the Workflow sleeps until the frozen due time", async () => {
		const f = await fixture();
		expect(f.record.nextDeliveryAt < f.post.scheduledFor!).toBe(true);
		expect(f.record.dueAt).toEqual(f.post.scheduledFor!);
		expect(await observePublicationSchedule(db, f.record.reference)).toEqual({
			kind: "sleep",
			dueAt: f.post.scheduledFor!,
		});
		expect(
			await db.socialPublicationAttempt.count({
				where: { socialPostId: f.post.id },
			}),
		).toBe(0);
	});
	test("cancellation while asleep atomically fences the old schedule generation", async () => {
		const f = await fixture();
		await db.socialPost.update({
			where: { id: f.post.id },
			data: { status: "cancelled" },
		});
		const post = await db.socialPost.findUniqueOrThrow({
			where: { id: f.post.id },
		});
		expect(post.scheduleRevision).toBe(f.post.scheduleRevision + 1);
		expect(post.generation).toBe(f.post.generation + 1);
		expect(await observePublicationSchedule(db, f.record.reference)).toEqual({
			kind: "superseded",
		});
		expect(
			await db.socialPublicationAttempt.count({
				where: { socialPostId: f.post.id },
			}),
		).toBe(0);
	});
	test("a changed schedule cannot reuse the earlier due wake", async () => {
		const f = await fixture(),
			later = new Date(Date.now() + 120000);
		const id = await db.$transaction(async (tx) => {
			await tx.socialPost.update({
				where: { id: f.post.id },
				data: { scheduledFor: later },
			});
			return appendPublicationDispatch(tx, f.post.id);
		});
		const newer = (await readExecutionDispatch(db, id))!;
		expect(newer.reference.generation).toBe(f.record.reference.generation + 1);
		expect(await observePublicationSchedule(db, f.record.reference)).toEqual({
			kind: "superseded",
		});
		expect(await observePublicationSchedule(db, newer.reference)).toEqual({
			kind: "sleep",
			dueAt: later,
		});
		await db.executionDispatch.update({
			where: { id },
			data: { acknowledgedAt: new Date() },
		});
	});
	test("export readiness preserves the frozen cycle and creates a targeted wake", async () => {
		const f = await fixture(false),
			due = new Date(Date.now() - 1000);
		await db.socialPost.update({
			where: { id: f.post.id },
			data: { scheduledFor: due },
		});
		const id = await db.$transaction((tx) =>
			appendPublicationDispatch(tx, f.post.id),
		);
		const waiting = (await readExecutionDispatch(db, id))!;
		expect(await observePublicationSchedule(db, waiting.reference)).toEqual({
			kind: "waiting_export",
			clipExportVariantId: f.variant.id,
		});
		const readyId = await db.$transaction(async (tx) => {
			await tx.frozenPublicationState.update({
				where: { socialPostId: f.post.id },
				data: {
					storageKey: "test/sealed.mp4",
					sizeBytes: 1234n,
					durationSec: 30,
					mediaReadyAt: new Date(),
				},
			});
			await tx.socialPost.update({
				where: { id: f.post.id },
				data: { status: "scheduled" },
			});
			return appendPublicationDispatch(tx, f.post.id, {
				wakeKind: "export_ready",
				dueAt: due,
			});
		});
		const ready = (await readExecutionDispatch(db, readyId))!;
		expect(ready.reference.inputHash).toBe(waiting.reference.inputHash);
		const observed = await observePublicationSchedule(db, ready.reference);
		expect(observed.kind).toBe("ready");
		if (observed.kind === "ready")
			expect(publicationExecutionInputHash(observed.post)).toBe(
				ready.reference.inputHash,
			);
		await db.executionDispatch.updateMany({
			where: { id: { in: [id, readyId] } },
			data: { acknowledgedAt: new Date() },
		});
	});
	test("publication commands require a started owner and replay one atomic checkpoint plus wake after a lost ACK", async () => {
		const f = await fixture(),
			token = crypto.randomUUID(),
			owner = crypto.randomUUID();
		const attempt = await db.socialPublicationAttempt.create({
			data: {
				socialPostId: f.post.id,
				frozenStateId: f.post.frozenState!.id,
				attemptNumber: 1,
				idempotencyKey: `publication:${f.post.id}:1`,
				phase: "claimed",
				nextActionAt: new Date(),
				processingDeadline: new Date(Date.now() + 3600000),
				reconciliationDeadline: new Date(Date.now() + 7200000),
			},
		});
		const dispatch = await db.$transaction((tx) =>
			appendExecutionDispatch(tx, {
				deploymentEpoch: f.post.deploymentEpoch,
				generation: f.post.generation,
				kind: "modal_execution",
				subject: { kind: "social_publication", id: f.post.id },
				inputHash: publicationExecutionInputHash(f.post),
				dueAt: f.post.createdAt,
			}),
		);
		await db.executionAttempt.create({
			data: {
				attemptToken: token,
				dispatchId: dispatch.reference.dispatchId,
				deploymentEpoch: f.post.deploymentEpoch,
				generation: f.post.generation,
				inputHash: dispatch.reference.inputHash,
				functionName: "publication",
				operationDeadlineAt: new Date(Date.now() + 600000),
			},
		});
		let lostAck = true,
			deliveries = 0;
		const domain: ExecutorDomainControl<{ id: string }> = {
			lockExecution: async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "SocialPost" WHERE "id"=${f.post.id}::uuid FOR UPDATE`;
				return { kind: "current", ref: { id: attempt.id } };
			},
			acquireExecution: async () => undefined,
			renewExecution: async () => undefined,
			startExecution: async (tx) => {
				await tx.socialPublicationAttempt.update({
					where: { id: attempt.id },
					data: { nativeStartCount: { increment: 1 } },
				});
			},
			commitArtifactExecution: async () => undefined,
			failExecution: async () => undefined,
			releaseExecution: async () => undefined,
			progressExecution: async () => undefined,
			publicationCommandExecution: async (tx, ref, _context, command) => {
				if (command.kind !== "provider_call") throw Error("unexpected command");
				await tx.socialPublicationAttempt.update({
					where: { id: ref.id },
					data: { providerCallCount: { increment: 1 } },
				});
				const id = await appendPublicationDispatch(tx, f.post.id, {
					dueAt: f.post.createdAt,
					wakeKind: "provider_call_saved",
				});
				return { reply: { kind: "recorded" }, dispatchIds: [id] };
			},
		};
		const control = createExecutorControl({
			database: db,
			subjectKind: "social_publication",
			domain,
			deliverWakes: async (ids) => {
				deliveries++;
				await db.executionDispatch.updateMany({
					where: { id: { in: [...ids] } },
					data: { acknowledgedAt: new Date() },
				});
				if (lostAck) throw Error("lost_wake_ack");
			},
		});
		const fence = { reference: dispatch.reference, attemptToken: token, owner };
		const execute = (command: unknown, deliveryId = crypto.randomUUID()) =>
			control.execute({
				command,
				verifiedRequest: {
					requestHash: createHash("sha256")
						.update(JSON.stringify(command))
						.digest("hex"),
					metadata: {
						version: 1,
						keyId: "fixture",
						audience: "executor-control",
						method: "POST",
						canonicalTarget: "/api/execution/command",
						bodySha256: "0".repeat(64),
						timestamp: Math.floor(Date.now() / 1000),
						deliveryId,
						signature: "0".repeat(64),
					},
				},
			});
		await execute({
			action: "acquire",
			reference: dispatch.reference,
			attemptToken: token,
			owner,
			leaseSeconds: 120,
		});
		const command = {
			action: "publication-command",
			fence,
			command: { kind: "provider_call", operation: "read" },
		};
		await expect(execute(command)).rejects.toMatchObject({
			code: "authority_lost",
		});
		expect(
			(
				await db.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: attempt.id },
				})
			).providerCallCount,
		).toBe(0);
		await execute({ action: "process-start", fence });
		const deliveryId = crypto.randomUUID();
		await expect(execute(command, deliveryId)).rejects.toThrow("lost_wake_ack");
		lostAck = false;
		expect(await execute(command, deliveryId)).toEqual({
			disposition: "publication_recorded",
			result: { kind: "recorded" },
		});
		expect(
			(
				await db.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: attempt.id },
				})
			).providerCallCount,
		).toBe(1);
		expect(deliveries).toBe(2);
		await expect(
			execute(
				{ ...command, command: { kind: "provider_call", operation: "submit" } },
				deliveryId,
			),
		).rejects.toMatchObject({ code: "replay_conflict" });
		await expect(
			execute({ ...command, fence: { ...fence, owner: crypto.randomUUID() } }),
		).rejects.toMatchObject({ code: "authority_lost" });
		await db.executionAttempt.update({
			where: { attemptToken: token },
			data: { leaseExpiresAt: new Date(Date.now() - 1000) },
		});
		expect((await execute(command)).disposition).toBe("expired");
		expect(
			(
				await db.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: attempt.id },
				})
			).providerCallCount,
		).toBe(1);
		await db.executionDispatch.update({
			where: { id: dispatch.reference.dispatchId },
			data: { acknowledgedAt: new Date() },
		});
	});

	test("publication OAuth and purpose keys remain fresh work-package data and never enter an inbox", async () => {
		const f = await fixture(),
			token = crypto.randomUUID(),
			owner = crypto.randomUUID();
		const dispatch = await db.$transaction((tx) =>
			appendExecutionDispatch(tx, {
				deploymentEpoch: f.post.deploymentEpoch,
				generation: f.post.generation,
				kind: "modal_execution",
				subject: { kind: "social_publication", id: f.post.id },
				inputHash: publicationExecutionInputHash(f.post),
				dueAt: f.post.createdAt,
			}),
		);
		await db.executionAttempt.create({
			data: {
				attemptToken: token,
				dispatchId: dispatch.reference.dispatchId,
				deploymentEpoch: f.post.deploymentEpoch,
				generation: f.post.generation,
				inputHash: dispatch.reference.inputHash,
				functionName: "publication",
				operationDeadlineAt: new Date(Date.now() + 600000),
			},
		});
		const domain: ExecutorDomainControl<string> = {
			lockExecution: async () => ({ kind: "current", ref: f.post.id }),
			acquireExecution: async () => undefined,
			renewExecution: async () => undefined,
			startExecution: async () => undefined,
			commitArtifactExecution: async () => undefined,
			failExecution: async () => undefined,
			releaseExecution: async () => undefined,
			progressExecution: async () => undefined,
		};
		const control = createExecutorControl({
			database: db,
			subjectKind: "social_publication",
			domain,
		});
		const fence = { reference: dispatch.reference, attemptToken: token, owner };
		const verified = (command: unknown, deliveryId = crypto.randomUUID()) => ({
			requestHash: createHash("sha256")
				.update(JSON.stringify(command))
				.digest("hex"),
			metadata: {
				version: 1 as const,
				keyId: "fixture",
				audience: "executor-control" as const,
				method: "POST" as const,
				canonicalTarget: "/api/execution/transfer",
				bodySha256: "0".repeat(64),
				timestamp: Math.floor(Date.now() / 1000),
				deliveryId,
				signature: "0".repeat(64),
			},
		});
		const acquire = {
			action: "acquire",
			reference: dispatch.reference,
			attemptToken: token,
			owner,
			leaseSeconds: 120,
		};
		await control.execute({
			command: acquire,
			verifiedRequest: verified(acquire),
		});
		const scope = {
			deploymentEpoch: f.post.deploymentEpoch,
			socialPostId: f.post.id,
			attemptId: crypto.randomUUID(),
			claimId: token,
			bindingHash: dispatch.reference.inputHash,
		};
		const publication = {
			version: 1 as const,
			inputKey: { key: Buffer.alloc(32, 1).toString("base64url"), scope },
			checkpointKey: { key: Buffer.alloc(32, 2).toString("base64url"), scope },
			account: {
				id: f.post.socialAccountId!,
				userId: f.post.createdByUserId!,
				platform: "youtube_shorts" as const,
				providerAccountId: "fixture",
				displayName: "Fixture",
				handle: null,
				accessToken: "private-ephemeral-oauth",
				scopes: [],
				metadata: null,
			},
		};
		let resolves = 0;
		const transfer = createExecutionTransfer({
			database: db,
			authority: control,
			storage: {} as never,
			resolvePackage: async () => {
				resolves++;
				return {
					input: { kind: "inline", command: { kind: "publication" } },
					sources: [],
					outputs: [],
					publication,
				};
			},
		});
		const command = { action: "work-package", fence },
			deliveryId = crypto.randomUUID(),
			request = verified(command, deliveryId);
		const response = await transfer.execute({
			command,
			verifiedRequest: request,
		});
		expect(response.disposition).toBe("work_package");
		if (response.disposition === "work_package")
			expect(response.publication?.account?.accessToken).toBe(
				"private-ephemeral-oauth",
			);
		const receipt = await db.executionInboxReceipt.findUniqueOrThrow({
			where: {
				audience_deliveryId: { audience: "executor-control", deliveryId },
			},
		});
		expect(receipt.disposition).toEqual({ disposition: "transfer_granted" });
		expect(JSON.stringify(receipt.disposition)).not.toContain(
			"private-ephemeral-oauth",
		);
		await db.executionAttempt.update({
			where: { attemptToken: token },
			data: { revokedAt: new Date() },
		});
		await expect(
			transfer.execute({ command, verifiedRequest: request }),
		).rejects.toMatchObject({ code: "authority_lost" });
		expect(resolves).toBe(1);
		await db.executionDispatch.update({
			where: { id: dispatch.reference.dispatchId },
			data: { acknowledgedAt: new Date() },
		});
	});

	test("only an audited explicit Recheck renews a native start round on the same uncertain attempt", async () => {
		const f = await active();
		await db.socialPost.update({
			where: { id: f.post.id },
			data: { status: "needs_attention" },
		});
		const deadline = new Date(Date.now() - 1000),
			key = `publication:${f.post.id}:1`;
		const attempt = await db.socialPublicationAttempt.create({
			data: {
				socialPostId: f.post.id,
				frozenStateId: f.post.frozenState!.id,
				attemptNumber: 1,
				idempotencyKey: key,
				phase: "needs_attention",
				outcome: "unknown",
				nativeStartCeiling: 2,
				nativeStartCount: 2,
				providerCallCount: 1,
				operationKind: "submission_started",
				checkpointEncrypted: "opaque-existing-provider-checkpoint",
				nextActionAt: new Date(),
				processingDeadline: deadline,
				reconciliationDeadline: deadline,
			},
		});
		await expect(
			db.$transaction((tx) =>
				tx.socialPublicationAttempt.update({
					where: { id: attempt.id },
					data: {
						phase: "reconciling",
						nativeStartRound: 2,
						nativeStartCount: 0,
					},
				}),
			),
		).rejects.toBeDefined();
		expect(
			(
				await db.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: attempt.id },
				})
			).nativeStartCount,
		).toBe(2);
		const context = createDatabaseTestContext();
		context.client = db;
		await withServiceEnvironment(
			{ SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET: "1" },
			context.bind(() =>
				socialPublicationRecovery.recheck({
					workspaceId: f.post.workspaceId!,
					actorUserId: f.post.createdByUserId!,
					socialPostId: f.post.id,
					reason: "Read the original provider operation again",
				}),
			),
		);
		const updated = await db.socialPublicationAttempt.findUniqueOrThrow({
			where: { id: attempt.id },
		});
		expect(updated.nativeStartRound).toBe(2);
		expect(updated.nativeStartCount).toBe(0);
		expect(updated.nativeStartCeiling).toBe(2);
		expect(updated.idempotencyKey).toBe(key);
		expect(updated.checkpointEncrypted).toBe(attempt.checkpointEncrypted);
		expect(updated.processingDeadline).toEqual(deadline);
		const audit = await db.publicationManualDecision.findFirstOrThrow({
			where: { attemptId: attempt.id, kind: "recheck_requested" },
		});
		expect(audit.executionBudgetAudit).toEqual({
			kind: "native_round_renewal",
			previousRound: 1,
			round: 2,
			previousNativeStartCount: 2,
			ceiling: 2,
			previousActorUserId: null,
			actorUserId: f.post.createdByUserId,
		});
		expect(
			(await db.socialPost.findUniqueOrThrow({ where: { id: f.post.id } }))
				.generation,
		).toBe(f.reference.generation + 1);
		const newDispatch = await db.$transaction((tx) =>
			appendPublicationDispatch(tx, f.post.id, { dueAt: new Date() }),
		);
		const prepared = await f.domain.prepareExecution(
			(await readExecutionDispatch(db, newDispatch))!.reference,
		);
		expect(prepared.kind).toBe("waiting");
		if (prepared.kind === "waiting")
			expect(
				(
					await db.publicationClaim.findUniqueOrThrow({
						where: { id: prepared.deadline.attemptToken },
					})
				).executionMode,
			).toBe("reconcile");
	});
	test("actor removal after initial authorization rolls back Recheck before resetting any budget", async () => {
		const f = await fixture();
		await db.socialPost.update({
			where: { id: f.post.id },
			data: { status: "needs_attention" },
		});
		const attempt = await db.socialPublicationAttempt.create({
			data: {
				socialPostId: f.post.id,
				frozenStateId: f.post.frozenState!.id,
				attemptNumber: 1,
				idempotencyKey: `publication:${f.post.id}:1`,
				phase: "needs_attention",
				outcome: "unknown",
				nativeStartCeiling: 2,
				nativeStartCount: 2,
				providerCallCount: 1,
				nextActionAt: new Date(),
				processingDeadline: new Date(Date.now() + 3600000),
				reconciliationDeadline: new Date(Date.now() + 3600000),
			},
		});
		const context = createDatabaseTestContext();
		context.client = new Proxy(db, {
			get(target, property) {
				if (property === "$transaction")
					return async (work: (tx: unknown) => Promise<unknown>) => {
						await db.user.update({
							where: { id: f.post.createdByUserId! },
							data: { deletedAt: new Date() },
						});
						return db.$transaction(work as never);
					};
				return Reflect.get(target, property, target);
			},
		});
		await expect(
			withServiceEnvironment(
				{ SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET: "1" },
				context.bind(() =>
					socialPublicationRecovery.recheck({
						workspaceId: f.post.workspaceId!,
						actorUserId: f.post.createdByUserId!,
						socialPostId: f.post.id,
						reason: "Recheck denied",
					}),
				),
			),
		).rejects.toMatchObject({ code: "social_publication_forbidden" });
		expect(
			(
				await db.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: attempt.id },
				})
			).nativeStartCount,
		).toBe(2);
		expect(
			await db.publicationManualDecision.count({
				where: { attemptId: attempt.id },
			}),
		).toBe(0);
	});
});
