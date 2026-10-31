import { planPublicationRecoveryPage, planPublicationRestorePage, planStandingGrantExpiryPage, planPublicationReceiptRecoveryPage, planPerformanceCaptureRecoveryPage } from "./publication-maintenance";
import {publishingQueue} from "./publishing-queue.service";
import {acceptProposalUnderGrant} from "./standing-grant-runtime";
import {appendYouTubeReceiptEnrichment,appendPerformanceCapture,trackPublishedVideo,appendPerformanceGuidance,createPublicationObservations} from "./publication-observations";
import {appendPublicationExportWake,appendPublicationGrantWake,appendPublicationGrantExpiry,createPublicationProducers,restorePublication} from "./publication-producers";
import {withExecutionDispatches} from "./execution-dispatch-runtime";
import {
	createPublicationInputBuilder,
	publicationProviderPullReads,
} from "./publication-execution-runtime";
import { createPublicationExecutionControl } from "./publication-execution-control";
import { createExecutionStorage } from "./execution-storage";
import { renderArtifactBindingHash } from "./render-artifact";
import {
	openPublicationPayload,
	derivePublicationPurposeKey,
} from "./publication-checkpoint-blob";
import { publicationInputPayloadSchema } from "@narriflow/validators/publication-input";
import { createCipheriv } from "node:crypto";
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
      confirmedScheduleRevision:1,
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

	async function active(ready = true) {
		const f = await fixture(ready),
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
		const inputBytes = new Map<string, Uint8Array>();
		let inputBuilder:
			| ReturnType<typeof createPublicationInputBuilder>
			| undefined;
		let lostRegisterAck = false;
		let lostPutAck = false,
			beforePut: (() => Promise<void>) | undefined;
		const register = async (ids: readonly string[]) => {
			if(lostRegisterAck && ids.length){lostRegisterAck=false;throw Error("lost_register_ack");}
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
			buildInput: async (snapshot) =>
				inputBuilder
					? inputBuilder(snapshot)
					: {
							bytes: new TextEncoder().encode(
								JSON.stringify({
									postId: snapshot.post.id,
									attemptId: snapshot.attempt.id,
									claimId: snapshot.claim.id,
									nonce: (snapshot.claim.workState as { nonce: string }).nonce,
								}),
							),
							sources: [],
						},
			inputStorage: {
				head: async (plan) => objects.get(plan.storageKey) ?? null,
				put: async (plan, bytes) => {
					await beforePut?.();
					inputBytes.set(plan.storageKey, new Uint8Array(bytes));
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
			inputBytes,
			hooks: {
				lostRegister:()=>{lostRegisterAck=true;},
				buildInput: (
					value: ReturnType<typeof createPublicationInputBuilder>,
				) => {
					inputBuilder = value;
				},
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
	const environment = {
		SOCIAL_PUBLICATION_CHECKPOINT_KEY: Buffer.alloc(32, 3).toString("base64"),
		SOCIAL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
	};
	async function nativeVideo(
		f: Awaited<ReturnType<typeof active>>,
		foreign = false,
		committed = true,
	) {
		const token = crypto.randomUUID(),
			owner = crypto.randomUUID(),
			artifactId = crypto.randomUUID(),
			storageKey = `execution/1/${token}/${owner}/${artifactId}`;
		const d = await db.$transaction((tx) =>
			appendExecutionDispatch(tx, {
				deploymentEpoch: 1,
				generation: 1,
				kind: "modal_execution",
				subject: { kind: "render_group", id: crypto.randomUUID() },
				inputHash: "b".repeat(64),
				dueAt: new Date(),
			}),
		);
		await db.executionAttempt.create({
			data: {
				attemptToken: token,
				owner,
				dispatchId: d.reference.dispatchId,
				deploymentEpoch: 1,
				generation: 1,
				inputHash: "b".repeat(64),
				functionName: "render_group",
				status: "completed",
				operationDeadlineAt: new Date(Date.now() + 600000),
				leaseExpiresAt: new Date(Date.now() + 60000),
				processStartedAt: new Date(),
				finishedAt: new Date(),
			},
		});
		const render = await db.clipRender.create({
			data: {
				clipId: f.post.clipId!,
				exportVariantId: f.variant.id,
				editorRevision: f.post.frozenState!.editorRevision,
				clipSnapshot: {},
				aspectRatio: "ratio_9_16",
				status: "completed",
				storageKey,
				sizeBytes: 1234n,
				durationSec: 30,
			},
		});
		const artifact = await db.executionArtifact.create({
			data: {
				id: artifactId,
				attemptToken: token,
				owner,
				role: "render_variant",
				bindingHash: await renderArtifactBindingHash({
					inputHash: "b".repeat(64),
					renderId: foreign ? crypto.randomUUID() : render.id,
					role: "render_variant",
				}),
				storageKey,
				contentType: "video/mp4",
				maxBytes: 1234n,
				byteLength: 1234n,
				checksumSha256: "c".repeat(64),
				etag: '"source"',
				committedAt: committed ? new Date() : null,
				grantExpiresAt: new Date(Date.now() + 60000),
			},
		});
		await db.$transaction(async (tx) => {
			await tx.clipExportVariant.update({
				where: { id: f.variant.id },
				data: {
					status: "completed",
					storageKey,
					sizeBytes: 1234n,
					durationSec: 30,
				},
			});
			await tx.frozenPublicationState.update({
				where: { socialPostId: f.post.id },
				data: {
					storageKey,
					sizeBytes: 1234n,
					durationSec: 30,
					mediaReadyAt: new Date(),
				},
			});
			await tx.socialPost.update({
				where: { id: f.post.id },
				data: { status: "scheduled" },
			});
		});
		await db.executionDispatch.update({
			where: { id: d.reference.dispatchId },
			data: { acknowledgedAt: new Date() },
		});
		return artifact;
	}
	test("actual runtime builder seals private input and only grants the exact committed frozen render", async () => {
		const f = await active(false),
			artifact = await nativeVideo(f);
		f.hooks.buildInput(createPublicationInputBuilder(db, environment));
		const prepared = await f.domain.prepareExecution(f.reference);
		expect(prepared.kind).toBe("waiting");
		if (prepared.kind !== "waiting") return;
		const snapshot = await f.domain.workSnapshot(
				prepared.deadline.reference,
				prepared.deadline.attemptToken,
			),
			bytes = f.inputBytes.get(snapshot.inputPlan.storageKey)!;
		const envelope = JSON.parse(new TextDecoder().decode(bytes));
		expect(new TextDecoder().decode(bytes)).not.toContain(
			"Frozen private copy",
		);
		const decoded = publicationInputPayloadSchema.parse(
			await openPublicationPayload(
				Buffer.from(envelope.payload, "base64url"),
				await derivePublicationPurposeKey(
					environment.SOCIAL_PUBLICATION_CHECKPOINT_KEY,
					envelope.scope,
					"input_state",
				),
				envelope.scope,
				"input_state",
			),
		);
		expect(decoded.loaded.frozen.storageKey).toBe(artifact.storageKey);
		expect(snapshot.sources).toEqual([
			{
				name: "publication_media",
				storageKey: artifact.storageKey,
				etag: artifact.etag,
				byteLength: 1234,
				sha256: artifact.checksumSha256,
			},
		]);
		let grants = 0;
		expect(
			await publicationProviderPullReads(
				db,
				snapshot,
				{
					signProviderPullRead: async (frozen) => {
						grants++;
						expect(frozen.artifactId).toBe(artifact.id);
						return {
							url: "https://r2.example/exact",
							expiresAt: new Date(Date.now() + 30000),
						};
					},
				},
				{
					leaseExpiresAt: new Date(Date.now() + 60000),
					operationDeadlineAt: new Date(Date.now() + 60000),
				},
			),
		).toHaveProperty("media");
		expect(grants).toBe(1);
		const pending = await active(false);
		await nativeVideo(pending, false, false);
		const own = await claimed(pending);
		const pendingSnapshot = await pending.domain.workSnapshot(
			own.prepared.deadline.reference,
			own.prepared.deadline.attemptToken,
		);
		grants = 0;
		await expect(
			publicationProviderPullReads(
				db,
				pendingSnapshot,
				{
					signProviderPullRead: async () => {
						grants++;
						throw Error("must not grant");
					},
				},
				{
					leaseExpiresAt: new Date(Date.now() + 60000),
					operationDeadlineAt: new Date(Date.now() + 60000),
				},
			),
		).rejects.toMatchObject({ code: "publication_frozen_media_unsealed" });
		expect(grants).toBe(0);
	});
	test("real control and signing factory returns fresh invocation-only access and refuses replay after account revocation", async () => {
		const f = await active(false);
		await nativeVideo(f);
		f.hooks.buildInput(createPublicationInputBuilder(db, environment));
		const key = Buffer.alloc(32, 5),
			iv = Buffer.alloc(12, 2),
			cipher = createCipheriv("aes-256-gcm", key, iv),
			encrypted = Buffer.concat([
				cipher.update("fixture-publication-access", "utf8"),
				cipher.final(),
			]);
		await db.socialAccount.update({
			where: { id: f.post.socialAccountId! },
			data: {
				accessTokenEncrypted: [
					"v1",
					iv.toString("base64url"),
					cipher.getAuthTag().toString("base64url"),
					encrypted.toString("base64url"),
				].join(":"),
				scopes: ["https://www.googleapis.com/auth/youtube.upload"],
			},
		});
		const p = await claimed(f);
		let pulls = 0;
		const storage = createExecutionStorage({
			accountId: "a".repeat(32),
			bucket: "fixture-private",
			accessKeyId: "fixture",
			secretAccessKey: "fixture",
		});
		const wired = createPublicationExecutionControl({
			database: db,
			domain: f.domain,
			storage: {
				...storage,
				signProviderPullRead: async (...args) => {
					pulls++;
					return storage.signProviderPullRead(...args);
				},
			},
			environment,
			artifacts: {
				head: async () => null,
				readBytes: async () => {
					throw Error("No instruction assignment on YouTube");
				},
			},
			deliverWakes: async (ids) => {
				await db.executionDispatch.updateMany({
					where: { id: { in: [...ids] } },
					data: { acknowledgedAt: new Date() },
				});
			},
		});
		const command = { action: "work-package", fence: p.fence },
			deliveryId = crypto.randomUUID(),
			verifiedRequest = {
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
			};
		const context = createDatabaseTestContext();
		context.client = db;
		const execute = () =>
			withServiceEnvironment(
				environment,
				context.bind(() =>
					wired.transfer.execute({ command, verifiedRequest }),
				),
			);
		const result = await execute();
		expect(result.disposition).toBe("work_package");
		if (result.disposition !== "work_package") throw Error("Missing package");
		expect(result.publication?.account?.accessToken).toBe(
			"fixture-publication-access",
		);
		expect(result.publication?.media?.url).toContain(
			"X-Amz-SignedHeaders=host",
		);
		expect(result.sources[0]?.headers).toEqual({ "If-Match": '"source"' });
		expect(result.input.kind).toBe("object");
		if (result.input.kind === "object")
			expect(result.input.headers).toEqual({ "If-Match": '"sealed"' });
		const inbox = await db.executionInboxReceipt.findUniqueOrThrow({
			where: {
				audience_deliveryId: { audience: "executor-control", deliveryId },
			},
		});
		expect(inbox.disposition).toEqual({ disposition: "transfer_granted" });
		expect(JSON.stringify(inbox)).not.toContain("fixture-publication-access");
		expect(JSON.stringify(inbox)).not.toContain("X-Amz");
		expect(pulls).toBe(1);
		await db.socialAccount.update({
			where: { id: f.post.socialAccountId! },
			data: { status: "revoked" },
		});
		await expect(execute()).rejects.toMatchObject({ code: "authority_lost" });
		expect(pulls).toBe(1);
		storage.close();
	});

	test("a foreign render binding cannot obtain an input capsule or downstream grant", async () => {
		const f = await active(false);
		await nativeVideo(f, true);
		f.hooks.buildInput(createPublicationInputBuilder(db, environment));
		expect((await f.domain.prepareExecution(f.reference)).kind).toBe(
			"terminal",
		);
		expect(f.inputBytes.size).toBe(0);
		expect(
			(await db.socialPost.findUniqueOrThrow({ where: { id: f.post.id } }))
				.errorCode,
		).toBe("publication_frozen_media_unsealed");
	});
	test("frozen intent and a filled media tuple cannot change after admission", async () => {
		const f = await fixture();
		await expect(
			db.$transaction((tx) =>
				tx.frozenPublicationState.update({
					where: { socialPostId: f.post.id },
					data: { providerSettings: { replacement: true } },
				}),
			),
		).rejects.toBeDefined();
		await expect(
			db.$transaction((tx) =>
				tx.frozenPublicationState.update({
					where: { socialPostId: f.post.id },
					data: { storageKey: "execution/foreign/key" },
				}),
			),
		).rejects.toBeDefined();
	});

	test("an old generation wake repairs its committed next obligation after scheduler ACK loss",async()=>{
		const f=await active(), p=await claimed(f);
		await db.publicationClaim.update({where:{id:p.fence.attemptToken},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
		f.hooks.lostRegister();
		await expect(f.domain.prepareExecution(f.reference)).rejects.toThrow("lost_register_ack");
		const post=await db.socialPost.findUniqueOrThrow({where:{id:f.post.id}});
		expect(post.generation).toBe(f.reference.generation+1);
		const pending=await db.executionDispatch.findMany({where:{subjectKind:"social_publication",subjectId:post.id,generation:post.generation,acknowledgedAt:null}});
		expect(pending).toHaveLength(1);
		await expect(f.domain.prepareExecution({...f.reference,inputHash:"f".repeat(64)})).resolves.toMatchObject({kind:"superseded"});
		expect((await db.executionDispatch.findUniqueOrThrow({where:{id:pending[0]!.id}})).acknowledgedAt).toBeNull();
		await expect(f.domain.prepareExecution(f.reference)).resolves.toMatchObject({kind:"superseded"});
		expect((await db.executionDispatch.findUniqueOrThrow({where:{id:pending[0]!.id}})).acknowledgedAt).not.toBeNull();
		expect(await db.socialPublicationAttempt.count({where:{socialPostId:post.id}})).toBe(1);
	});

 test("an occupied account confirms its peer deadline and an independent targeted continuation without polling",async()=>{
  const f=await active(),p=await claimed(f);
  const {frozenState,...post}=await db.socialPost.findUniqueOrThrow({where:{id:f.post.id},include:{frozenState:true}});
  const {id:_id,socialPostId:_postId,...frozen}=frozenState!;
  const second=await db.socialPost.create({data:{...post,id:crypto.randomUUID(),clientIdempotencyKey:crypto.randomUUID(),immutableRequestHash:crypto.randomUUID(),frozenState:{create:frozen as never}},include:{frozenState:true}});
  const id=await db.$transaction(tx=>appendPublicationDispatch(tx,second.id));
  await db.executionDispatch.update({where:{id},data:{acknowledgedAt:new Date()}});
  const reference=(await readExecutionDispatch(db,id))!.reference;
  const blocked=await f.domain.prepareExecution(reference);
  expect(blocked.kind).toBe("dependency_wait");if(blocked.kind!=="dependency_wait")throw Error("Expected account dependency");
  expect(blocked.dueAt).toEqual((await db.publicationClaim.findUniqueOrThrow({where:{id:p.fence.attemptToken}})).leaseExpiresAt);
  const timer=await readExecutionDispatch(db,blocked.deadlineDispatchId);
  expect(timer!.reference.subject.id).toBe(f.post.id);expect(timer!.deadlineKind).toBe("lease");expect(timer!.acknowledgedAt).not.toBeNull();
  expect(await db.publicationClaim.count({where:{attempt:{socialPostId:second.id}}})).toBe(0);
  const resume=await db.executionDispatch.findFirstOrThrow({where:{subjectId:second.id,wakeKind:{startsWith:"pub_"}}});expect(resume.dueAt).toEqual(blocked.dueAt);expect(resume.acknowledgedAt).not.toBeNull();
  // Even if the peer's earlier watchdog was abandoned, this exact incoming
  // continuation expires it outside the current Post lock before claiming.
  await db.publicationClaim.update({where:{id:p.fence.attemptToken},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
  expect((await f.domain.prepareExecution(reference)).kind).toBe("waiting");
  expect((await db.publicationClaim.findUniqueOrThrow({where:{id:p.fence.attemptToken}})).releasedAt).not.toBeNull();
  expect(await db.publicationClaim.count({where:{accountSlotKey:f.post.socialAccountId}})).toBe(1);
 });

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

 test("a submission checkpoint does not authorize a first provider mutation after workspace restriction",async()=>{
  const f=await active(),p=await claimed(f);await f.call({action:"process-start",fence:p.fence});
  await p.command({kind:"checkpoint",operation:{kind:"submission_started",state:{providerOperation:"linkedin_post",videoUrn:"urn:li:video:one"}}});
  await db.workspace.update({where:{id:f.post.workspaceId!},data:{status:"restricted"}});
  const refused=await p.command({kind:"provider_call",operation:"submit"});
  expect(refused).toMatchObject({disposition:"publication_recorded",result:{kind:"settled",outcome:"needs_attention",code:"publication_workspace_restricted"}});
  expect((await db.socialPublicationAttempt.findFirstOrThrow({where:{socialPostId:f.post.id}})).providerCallCount).toBe(0);
  expect((await db.socialPost.findUniqueOrThrow({where:{id:f.post.id}})).status).toBe("needs_attention");
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
 async function duplicatePost(postId:string){
  const {frozenState,...post}=await db.socialPost.findUniqueOrThrow({where:{id:postId},include:{frozenState:true}});
  const {id:_id,socialPostId:_postId,...frozen}=frozenState!;
  return db.socialPost.create({data:{...post,id:crypto.randomUUID(),clientIdempotencyKey:crypto.randomUUID(),immutableRequestHash:crypto.randomUUID(),frozenState:{create:frozen as never}}});
 }
 test("export-result pages freeze at32 posts and replay the exact committed continuation after lost registration",async()=>{
  const f=await fixture(false);for(let n=0;n<33;n++)await duplicatePost(f.post.id);
  const id=await db.$transaction(async tx=>{await tx.clipExportVariant.update({where:{id:f.variant.id},data:{status:"completed",storageKey:"test/ready.mp4",sizeBytes:1234n,durationSec:30,completedAt:new Date()}});return (await appendPublicationExportWake(tx,f.variant.id))!;});
  const reference=(await readExecutionDispatch(db,id))!.reference;let lose=true;const deliveries:string[][]=[];
  const producer=createPublicationProducers({database:db,register:async ids=>{deliveries.push([...ids]);if(lose)throw Error("lost_export_page_ack");}});
  await expect(producer.dispatch(reference)).rejects.toThrow("lost_export_page_ack");
  expect(await db.socialPost.count({where:{frozenState:{clipExportVariantId:f.variant.id},status:"scheduled"}})).toBe(32);
  lose=false;const replay=await producer.dispatch(reference);expect(replay.dispatchIds).toEqual(deliveries[0]!);
  expect(await db.socialPost.count({where:{frozenState:{clipExportVariantId:f.variant.id},status:"scheduled"}})).toBe(32);
  const next=await db.executionDispatch.findFirstOrThrow({where:{id:{in:replay.dispatchIds},kind:"maintenance",subjectId:{startsWith:`pub1.e.${f.variant.id}.`}}});
  await producer.dispatch((await readExecutionDispatch(db,next.id))!.reference);
  expect(await db.socialPost.count({where:{frozenState:{clipExportVariantId:f.variant.id},status:"scheduled"}})).toBe(34);
  expect(await db.socialPublicationAttempt.count({where:{socialPost:{frozenState:{clipExportVariantId:f.variant.id}}}})).toBe(0);
 });
 test("a targeted failed export settles its accepted post and never initializes a provider",async()=>{
  const f=await active(false);await db.clipExportVariant.update({where:{id:f.variant.id},data:{status:"failed",errorCode:"fixture_render_failed"}});
  expect((await f.domain.prepareExecution(f.reference)).kind).toBe("terminal");
  expect((await db.socialPost.findUniqueOrThrow({where:{id:f.post.id}})).errorCode).toBe("social_export_failed");
  expect(await db.socialPublicationAttempt.count({where:{socialPostId:f.post.id}})).toBe(0);
 });
 async function publicationGrant(f:Awaited<ReturnType<typeof fixture>>,expiresAt=new Date(Date.now()+86400000)){
  const grant=await db.standingGrant.create({data:{workspaceId:f.post.workspaceId!,kind:"publish",socialAccountId:f.post.socialAccountId,dailyCap:10,weeklyCap:20,expiresAt,ruleFingerprint:"fixture",grantedByUserId:f.post.createdByUserId}});
  await db.socialPost.update({where:{id:f.post.id},data:{standingGrantId:grant.id,standingGrantRevision:1}});return grant;
 }
 test("pause and revoke at one grant revision have distinct pages; expiry first delivery remains valid after a long sleep",async()=>{
  const f=await fixture(),grant=await publicationGrant(f,new Date(Date.now()-1000));
  const expiredId=await db.$transaction(tx=>appendPublicationGrantExpiry(tx,grant));
  await db.executionDispatch.update({where:{id:expiredId},data:{createdAt:new Date(Date.now()-20*86400000)}});
  const producer=createPublicationProducers({database:db,register:async()=>{}});
  await producer.dispatch((await readExecutionDispatch(db,expiredId))!.reference);
  expect((await db.standingGrant.findUniqueOrThrow({where:{id:grant.id}})).status).toBe("expired");
  const expiryPage=await db.executionDispatch.findFirstOrThrow({where:{subjectId:{startsWith:`pub1.g.${grant.id}.`}}});
  await producer.dispatch((await readExecutionDispatch(db,expiryPage.id))!.reference);
  expect((await db.socialPost.findUniqueOrThrow({where:{id:f.post.id}})).status).toBe("draft");
  expect(await db.frozenPublicationState.count({where:{socialPostId:f.post.id}})).toBe(0);
  const paused=await db.$transaction(async tx=>{await tx.standingGrantEvent.create({data:{grantId:grant.id,kind:"paused",revision:1}});return (await appendPublicationGrantWake(tx,grant.id))!;});
  const revoked=await db.$transaction(async tx=>{await tx.standingGrantEvent.create({data:{grantId:grant.id,kind:"revoked",revision:1}});return (await appendPublicationGrantWake(tx,grant.id))!;});
  expect(paused).not.toBe(revoked);
 });
 test("restore preserves uncertain provider identity, charged counters and deadlines while invalidating the old physical claim",async()=>{
  const f=await active(),p=await claimed(f);await f.call({action:"process-start",fence:p.fence});await p.command({kind:"checkpoint",operation:{kind:"upload_prepared",state:{providerOperation:"youtube_resumable_upload",uploadUrl:"https://www.googleapis.com/exact-session"}}});
  const before=await db.socialPublicationAttempt.findFirstOrThrow({where:{socialPostId:f.post.id}});const sentinel=Error("rollback isolated restore proof");
  await expect(db.$transaction(async tx=>{
   await tx.executionEpoch.update({where:{id:1},data:{epoch:2,admissionOpen:false}});
   await restorePublication(tx,f.post.id,2);
   const post=await tx.socialPost.findUniqueOrThrow({where:{id:f.post.id}}),attempt=await tx.socialPublicationAttempt.findUniqueOrThrow({where:{id:before.id}}),claim=await tx.publicationClaim.findUniqueOrThrow({where:{id:p.fence.attemptToken}});
   expect(post.deploymentEpoch).toBe(2);expect(claim.releasedAt).not.toBeNull();expect(claim.accountSlotKey).toBeNull();expect(attempt.currentClaimId).toBeNull();
   expect(attempt.idempotencyKey).toBe(before.idempotencyKey);expect(attempt.checkpointEncrypted).toBe(before.checkpointEncrypted);expect(attempt.nativeStartCount).toBe(before.nativeStartCount);expect(attempt.processingDeadline).toEqual(before.processingDeadline);expect(attempt.reconciliationDeadline).toEqual(before.reconciliationDeadline);
   throw sentinel;
  })).rejects.toBe(sentinel);
 });

 async function observationReceipt(){
  const f=await fixture(),at=new Date();await db.socialPost.update({where:{id:f.post.id},data:{status:"posted",postedAt:at}});
  const attempt=await db.socialPublicationAttempt.create({data:{socialPostId:f.post.id,frozenStateId:f.post.frozenState!.id,attemptNumber:1,idempotencyKey:crypto.randomUUID(),phase:"succeeded",outcome:"accepted",terminalAt:at,nextActionAt:at,processingDeadline:new Date(at.getTime()+3600000),reconciliationDeadline:new Date(at.getTime()+7200000),receipt:{create:{platform:"youtube_shorts",receiptId:crypto.randomUUID(),platformPostId:"verified-youtube-id",providerProcessingStatus:"processing",providerVisibility:"private",enrichmentNextCheckAt:new Date(at.getTime()-1000)}}},include:{receipt:true}});
  const id=await db.$transaction(tx=>appendYouTubeReceiptEnrichment(tx,attempt.receipt!.id));await db.executionDispatch.update({where:{id:id!},data:{acknowledgedAt:new Date()}});return {...f,receipt:attempt.receipt!,reference:(await readExecutionDispatch(db,id!))!.reference};
 }
 const acknowledge=async(ids:readonly string[])=>{await db.executionDispatch.updateMany({where:{id:{in:[...ids]}},data:{acknowledgedAt:new Date()}});};
 test("receipt status reads confirm a watchdog before IO and stale replay repairs a committed retry without another GET",async()=>{
  const f=await observationReceipt();let gets=0,registrations=0;
  const observer=createPublicationObservations({database:db,accounts:{getPublishAccount:async()=>({accessToken:"private-access"})},register:async ids=>{registrations++;if(registrations===2)throw Error("lost_receipt_next_ack");await acknowledge(ids);},fetch:(async()=>{gets++;const watch=await db.executionDispatch.findFirstOrThrow({where:{subjectId:{startsWith:`po1.yw.${f.receipt.id}.`}}});expect(watch.acknowledgedAt).not.toBeNull();return Response.json({items:[{status:{uploadStatus:"uploaded",privacyStatus:"private"}}]});}) as typeof fetch});
  await expect(observer.dispatch(f.reference)).rejects.toThrow("lost_receipt_next_ack");
  expect((await db.providerReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).enrichmentCheckCount).toBe(1);
  expect(gets).toBe(1);await observer.dispatch(f.reference);expect(gets).toBe(1);
  expect(await db.executionDispatch.count({where:{subjectId:{startsWith:`po1.y.${f.receipt.id}.`},acknowledgedAt:null}})).toBe(0);
 });
 test("a disconnect during OAuth lookup opens no status HTTP request",async()=>{
  const f=await observationReceipt();let gets=0;
  const observer=createPublicationObservations({database:db,register:acknowledge,accounts:{getPublishAccount:async()=>{await db.socialAccount.update({where:{id:f.post.socialAccountId!},data:{status:"revoked"}});return {accessToken:"stale-access"};}},fetch:(async()=>{gets++;throw Error("Revoked provider request");}) as typeof fetch});
  await observer.dispatch(f.reference);expect(gets).toBe(0);expect(await db.providerReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).toMatchObject({providerProcessingStatus:"unknown",providerProcessingFailureCode:"social_account_reconnect_required",enrichmentClaimId:null});
 });
 test("a late status response cannot overwrite the newer lease owner's receipt",async()=>{
  const f=await observationReceipt();let release!:()=>void,began!:()=>void;const begin=new Promise<void>(r=>began=r),gate=new Promise<void>(r=>release=r);let gets=0;
  const observer=createPublicationObservations({database:db,register:acknowledge,accounts:{getPublishAccount:async()=>({accessToken:"private-access"})},fetch:(async()=>{gets++;if(gets===1){began();await gate;return Response.json({items:[{status:{uploadStatus:"rejected"}}]});}return Response.json({items:[{status:{uploadStatus:"processed",privacyStatus:"public"}}]});}) as typeof fetch});
  const first=observer.dispatch(f.reference);await begin;
  await db.providerReceipt.update({where:{id:f.receipt.id},data:{enrichmentLeaseExpiresAt:new Date(Date.now()-1000)}});
  await observer.dispatch(f.reference);
  const timer=await db.executionDispatch.findFirstOrThrow({where:{subjectId:{startsWith:`po1.yw.${f.receipt.id}.`},dueAt:{lt:new Date()}},orderBy:{createdAt:"desc"}});
  await observer.dispatch((await readExecutionDispatch(db,timer.id))!.reference);
  const next=await db.executionDispatch.findFirstOrThrow({where:{subjectId:{startsWith:`po1.y.${f.receipt.id}.`},id:{not:f.reference.dispatchId}},orderBy:{createdAt:"desc"}});
  await observer.dispatch((await readExecutionDispatch(db,next.id))!.reference);release();await first;
  expect(gets).toBe(2);expect(await db.providerReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).toMatchObject({providerProcessingStatus:"succeeded",providerVisibility:"public",providerProcessingFailureCode:null,enrichmentClaimId:null});
 });
 test("a verified publication freezes five capture rows atomically and a bounded tracking page replays its exact wake list",async()=>{
  const f=await fixture();const publishedAt=new Date(Date.now()-61*60000);
  const videoId=await db.$transaction(async tx=>{await tx.publishedSocialVideo.create({data:{socialPostId:f.post.id,platformPostId:"public-metrics-id",publishedAt}});return trackPublishedVideo(tx,{socialPostId:f.post.id,platformPostId:"public-metrics-id"});});
  expect(await db.performanceCapture.count({where:{trackedVideoId:videoId!}})).toBe(5);const facts=(await db.trackedVideo.findUniqueOrThrow({where:{id:videoId!}})).clipFacts;await db.clip.update({where:{id:f.post.clipId!},data:{viralityScore:1}});expect((await db.trackedVideo.findUniqueOrThrow({where:{id:videoId!}})).clipFacts).toEqual(facts);
  const tracking=await db.executionDispatch.findFirstOrThrow({where:{subjectId:`po1.t.${videoId}`}});let lose=true,gets=0;const ids:string[][]=[];
  const observer=createPublicationObservations({database:db,accounts:{getPublishAccount:async()=>({accessToken:"private-access"})},register:async values=>{ids.push([...values]);if(lose)throw Error("lost_capture_page_ack");await acknowledge(values);},fetch:(async()=>{gets++;return Response.json({items:[{id:"public-metrics-id",statistics:{viewCount:"120",likeCount:"3"}}]});}) as typeof fetch});
  const reference=(await readExecutionDispatch(db,tracking.id))!.reference;await expect(observer.dispatch(reference)).rejects.toThrow("lost_capture_page_ack");lose=false;await observer.dispatch(reference);expect(ids[1]).toEqual(ids[0]!);expect(ids[0]).toHaveLength(5);
  const capture=await db.performanceCapture.findUniqueOrThrow({where:{trackedVideoId_slot:{trackedVideoId:videoId!,slot:0}}});const due=await db.executionDispatch.findFirstOrThrow({where:{subjectId:{startsWith:`po1.c.${capture.id}.`}}});const captureReference=(await readExecutionDispatch(db,due.id))!.reference;
  await observer.dispatch(captureReference);await observer.dispatch(captureReference);expect(gets).toBe(1);expect(await db.performanceCapture.findUniqueOrThrow({where:{id:capture.id}})).toMatchObject({state:"captured",views:120,likes:3,leaseOwner:null});
 });

 test("known daily capture quota waits for its fixed reset without consuming the failure budget",async()=>{
  const f=await fixture();const video=await db.trackedVideo.create({data:{workspaceId:f.post.workspaceId!,socialAccountId:f.post.socialAccountId,platform:"youtube_shorts",platformPostId:crypto.randomUUID(),publishedAt:new Date()}});const capture=await db.performanceCapture.create({data:{trackedVideoId:video.id,slot:0,dueAt:new Date(Date.now()-1000)}});
  const id=await db.$transaction(tx=>appendPerformanceCapture(tx,capture.id));let gets=0;
  const observer=createPublicationObservations({database:db,register:acknowledge,accounts:{getPublishAccount:async()=>({accessToken:"private-access"})},fetch:(async()=>{gets++;return Response.json({error:{errors:[{reason:"quotaExceeded"}]}},{status:403});}) as typeof fetch});
  const ref=(await readExecutionDispatch(db,id!))!.reference;await observer.dispatch(ref);const after=await db.performanceCapture.findUniqueOrThrow({where:{id:capture.id}});expect(after.state).toBe("scheduled");expect(after.attempts).toBe(0);expect(after.dueAt>new Date()).toBe(true);await observer.dispatch(ref);expect(gets).toBe(1);
 });
 test("nightly guidance commits the next exact Workspace wake and replays it after ACK loss without recomputing",async()=>{
  const f=await fixture();await db.trackedVideo.createMany({data:Array.from({length:30},()=>({workspaceId:f.post.workspaceId!,platform:"youtube_shorts" as const,platformPostId:crypto.randomUUID(),publishedAt:new Date()}))});
  const id=await db.$transaction(tx=>appendPerformanceGuidance(tx,f.post.workspaceId!,new Date(Date.now()-1000)));let lose=true;const deliveries:string[][]=[];
  const observer=createPublicationObservations({database:db,accounts:{getPublishAccount:async()=>{throw Error("Guidance has no provider IO");}},fetch:(async()=>{throw Error("Guidance has no provider IO");}) as typeof fetch,register:async ids=>{deliveries.push([...ids]);if(lose)throw Error("lost_guidance_ack");await acknowledge(ids);}});
  const ref=(await readExecutionDispatch(db,id))!.reference;await expect(observer.dispatch(ref)).rejects.toThrow("lost_guidance_ack");const original=await db.performanceGuidance.findUniqueOrThrow({where:{workspaceId:f.post.workspaceId!}});lose=false;await observer.dispatch(ref);expect(deliveries[1]).toEqual(deliveries[0]!);expect(deliveries[0]).toHaveLength(1);expect((await db.performanceGuidance.findUniqueOrThrow({where:{workspaceId:f.post.workspaceId!}})).computedAt).toEqual(original.computedAt);
 });

 const everyDay={slots:(["mon","tue","wed","thu","fri","sat","sun"] as const).map(weekday=>({weekday,time:"00:00"}))};
 async function queueScope<T>(fn:()=>Promise<T>){const context=createDatabaseTestContext();context.client=db;return withServiceEnvironment({},context.bind(()=>withExecutionDispatches(fn,{database:db,deliver:acknowledge})));}
 async function renewal(grant:{id:string}){return db.$transaction(async tx=>{await tx.standingGrant.update({where:{id:grant.id},data:{revision:{increment:1}}});await tx.standingGrantEvent.create({data:{grantId:grant.id,kind:"renewed",revision:2}});return (await appendPublicationGrantWake(tx,grant.id))!;});}
 test("renewal retires a startup with no provider permission; only a fresh observed approval starts a new linked attempt",async()=>{
  const f=await active(),grant=await publicationGrant(f);await db.socialAccount.update({where:{id:f.post.socialAccountId!},data:{postingSchedule:everyDay}});
  await db.socialPostProposal.create({data:{socialPostId:f.post.id,source:"person",clipExportVariantId:f.variant.id}});
  const currentId=await db.$transaction(tx=>appendPublicationDispatch(tx,f.post.id));const current={...f,reference:(await readExecutionDispatch(db,currentId))!.reference},p=await claimed(current);await f.call({action:"process-start",fence:p.fence});
  const before=await db.socialPublicationAttempt.findFirstOrThrow({where:{socialPostId:f.post.id}}),originalFrozen=f.post.frozenState!.id;
  await expect(db.$transaction(async tx=>{await tx.socialPost.update({where:{id:f.post.id},data:{status:"draft"}});await tx.frozenPublicationState.update({where:{id:originalFrozen},data:{socialPostId:null,retiredForPostId:f.post.id}});})).rejects.toBeDefined();
  const change=await renewal(grant);await createPublicationProducers({database:db,register:acknowledge}).dispatch((await readExecutionDispatch(db,change))!.reference);
  const draft=await db.socialPost.findUniqueOrThrow({where:{id:f.post.id},include:{frozenState:true,retiredPublicationStates:true}});expect(draft.status).toBe("draft");expect(draft.frozenState).toBeNull();expect(draft.retiredPublicationStates.map(row=>row.id)).toContain(originalFrozen);expect(draft.retiredPublicationStates[0]!.confirmedScheduleRevision).toBe(1);
  expect(await db.socialPublicationAttempt.findUniqueOrThrow({where:{id:before.id}})).toMatchObject({phase:"failed",currentClaimId:null,nativeStartCount:1,providerCallCount:0,idempotencyKey:before.idempotencyKey,processingDeadline:before.processingDeadline,reconciliationDeadline:before.reconciliationDeadline});
  expect((await db.executionAttempt.findUniqueOrThrow({where:{attemptToken:p.fence.attemptToken}})).status).toBe("cancelled");
  const scope={actorUserId:f.post.createdByUserId!,workspaceId:f.post.workspaceId!};
  await expect(queueScope(()=>publishingQueue.accept(scope,f.post.id,{expectedScheduleRevision:1}))).rejects.toMatchObject({code:"social_proposal_changed"});expect(await db.socialPublicationAttempt.count({where:{socialPostId:f.post.id}})).toBe(1);
  await queueScope(()=>publishingQueue.accept(scope,f.post.id,{expectedScheduleRevision:draft.scheduleRevision}));
  const accepted=await db.socialPost.findUniqueOrThrow({where:{id:f.post.id},include:{frozenState:true}});expect(accepted.frozenState!.id).not.toBe(originalFrozen);expect(accepted.frozenState!.confirmedScheduleRevision).toBe(draft.scheduleRevision);
  const due=await db.$transaction(async tx=>{await tx.socialPost.update({where:{id:f.post.id},data:{scheduledFor:new Date(Date.now()-1000)}});return appendPublicationDispatch(tx,f.post.id);});expect((await f.domain.prepareExecution((await readExecutionDispatch(db,due))!.reference)).kind).toBe("waiting");
  const next=await db.socialPublicationAttempt.findFirstOrThrow({where:{socialPostId:f.post.id},orderBy:{attemptNumber:"desc"}});expect(next.attemptNumber).toBe(2);expect(next.priorAttemptId).toBe(before.id);expect(next.nativeStartCount).toBe(0);expect((await db.socialPublicationAttempt.findUniqueOrThrow({where:{id:before.id}})).nativeStartCount).toBe(1);
  await expect(Promise.resolve(db.frozenPublicationState.update({where:{id:originalFrozen},data:{socialPostId:f.post.id,retiredForPostId:null}}))).rejects.toBeDefined();
  await expect(Promise.resolve(db.frozenPublicationState.update({where:{id:originalFrozen},data:{caption:"tampered history"}}))).rejects.toBeDefined();
  await db.socialPost.delete({where:{id:f.post.id}});expect(await db.frozenPublicationState.count({where:{id:{in:[originalFrozen,accepted.frozenState!.id]}}})).toBe(0);

 });
 test("a recorded initialize permission prevents grant renewal from retiring its provider lineage",async()=>{
  const f=await active(),grant=await publicationGrant(f),id=await db.$transaction(tx=>appendPublicationDispatch(tx,f.post.id));const current={...f,reference:(await readExecutionDispatch(db,id))!.reference},p=await claimed(current);await f.call({action:"process-start",fence:p.fence});await p.command({kind:"provider_call",operation:"initialize"});
  const before=await db.socialPublicationAttempt.findFirstOrThrow({where:{socialPostId:f.post.id}}),change=await renewal(grant);await createPublicationProducers({database:db,register:acknowledge}).dispatch((await readExecutionDispatch(db,change))!.reference);
  expect((await db.socialPost.findUniqueOrThrow({where:{id:f.post.id},include:{frozenState:true}})).frozenState!.id).toBe(f.post.frozenState!.id);
  const wake=await db.executionDispatch.findFirstOrThrow({where:{subjectId:f.post.id,wakeKind:{startsWith:"pub_"}},orderBy:{createdAt:"desc"}});await f.domain.prepareExecution((await readExecutionDispatch(db,wake.id))!.reference);
  const after=await db.socialPublicationAttempt.findUniqueOrThrow({where:{id:before.id}});expect(after.phase).toBe("needs_attention");expect(after.providerCallCount).toBe(1);expect(after.nativeStartCount).toBe(1);expect(after.idempotencyKey).toBe(before.idempotencyKey);expect(after.processingDeadline).toEqual(before.processingDeadline);expect(await db.frozenPublicationState.count({where:{retiredForPostId:f.post.id}})).toBe(0);
  await expect(db.$transaction(async tx=>{await tx.socialPost.update({where:{id:f.post.id},data:{status:"draft"}});await tx.frozenPublicationState.update({where:{id:f.post.frozenState!.id},data:{socialPostId:null,retiredForPostId:f.post.id}});})).rejects.toBeDefined();
 });
 test("propose replay returns its original observed revision and a stale bulk observation cannot approve an edited draft",async()=>{
  const f=await fixture();await db.socialAccount.update({where:{id:f.post.socialAccountId!},data:{postingSchedule:everyDay}});const scope={workspaceId:f.post.workspaceId!,actorUserId:f.post.createdByUserId!},key=crypto.randomUUID(),input={clipId:f.post.clipId!,exportId:f.post.frozenState!.clipExportId,socialAccountId:f.post.socialAccountId!,caption:"Original proposal"};
  const first=await queueScope(()=>publishingQueue.propose(scope,input,{source:"finishing",mutation:{clientIdempotencyKey:key}}));await queueScope(()=>publishingQueue.updateProposalCaption(scope,first.proposal.proposalId,"Reviewed edit"));const replay=await queueScope(()=>publishingQueue.propose(scope,input,{source:"finishing",mutation:{clientIdempotencyKey:key}}));expect(replay.proposal.scheduleRevision).toBe(first.proposal.scheduleRevision);
  const bulk=await queueScope(()=>publishingQueue.acceptAll(scope,{proposals:[{proposalId:first.proposal.proposalId,expectedScheduleRevision:first.proposal.scheduleRevision}]}));expect(bulk.accepted).toHaveLength(0);expect(bulk.failed[0]!.code).toBe("social_proposal_changed");expect((await db.socialPost.findUniqueOrThrow({where:{id:first.proposal.proposalId}})).status).toBe("draft");
  expect(await queueScope(()=>acceptProposalUnderGrant({workspaceId:scope.workspaceId,projectId:f.post.projectId,finishingId:crypto.randomUUID(),proposalId:first.proposal.proposalId,expectedScheduleRevision:first.proposal.scheduleRevision,expectedGrant:null}))).toBe("social_proposal_changed");
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
  const mutation={clientIdempotencyKey:crypto.randomUUID()};let loseRegistration=true;
  const recheck=()=>withServiceEnvironment({SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET:"1"},context.bind(()=>withExecutionDispatches(()=>socialPublicationRecovery.recheck({workspaceId:f.post.workspaceId!,actorUserId:f.post.createdByUserId!,socialPostId:f.post.id,reason:"Read the original provider operation again",mutation}),{database:db,deliver:async ids=>{if(loseRegistration){loseRegistration=false;throw Error("lost_manual_registration");}await db.executionDispatch.updateMany({where:{id:{in:[...ids]}},data:{acknowledgedAt:new Date()}});}})));
  await expect(recheck()).rejects.toThrow("lost_manual_registration");
  expect(await db.executionDispatch.count({where:{subjectId:f.post.id,generation:f.reference.generation+1,acknowledgedAt:null}})).toBe(1);
  await recheck();
  expect(await db.executionDispatch.count({where:{subjectId:f.post.id,generation:f.reference.generation+1,acknowledgedAt:null}})).toBe(0);
  expect(await db.publicationManualDecision.count({where:{attemptId:attempt.id,kind:"recheck_requested"}})).toBe(1);
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
  const newDispatch=(await db.executionDispatch.findFirstOrThrow({where:{subjectKind:"social_publication",subjectId:f.post.id,generation:f.reference.generation+1,kind:"operation_driver",wakeKind:null}})).id;
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
 test("hourly publication recovery has a strict bounded cutoff and reproduces committed wake identities",async()=>{
  const fixtures=await Promise.all([fixture(),fixture(),fixture()]);
  for(let index=0;index<fixtures.length;index++)await db.socialPost.update({where:{id:fixtures[index]!.post.id},data:{createdAt:new Date(index<2?1000:2000)}});
  const page={deploymentEpoch:1,cutoff:new Date(1500),after:null,limit:1};
  const first=await db.$transaction(tx=>planPublicationRecoveryPage(tx,page));
  expect(first.processed).toBe(1);expect(first.next).not.toBeNull();expect(first.dispatchIds).toHaveLength(1);
  expect(await db.$transaction(tx=>planPublicationRecoveryPage(tx,page))).toEqual(first);
  const second=await db.$transaction(tx=>planPublicationRecoveryPage(tx,{...page,after:first.next}));
  expect(second.processed).toBe(1);expect(second.next).toBeNull();expect(second.dispatchIds).toHaveLength(1);
  const targets=await db.executionDispatch.findMany({where:{id:{in:[...first.dispatchIds!,...second.dispatchIds!]}},select:{subjectId:true}});
  expect(targets.map(row=>row.subjectId).sort()).toEqual(fixtures.slice(0,2).map(f=>f.post.id).sort());
  await expect(db.$transaction(tx=>planPublicationRecoveryPage(tx,{...page,limit:33}))).rejects.toThrow("publication_maintenance_page_invalid");
 });

 test("hourly receipt and capture recovery restores exact expired-owner timers without spending attempts",async()=>{
  const f=await observationReceipt(),owner=crypto.randomUUID(),until=new Date(5000);
  await db.providerReceipt.update({where:{id:f.receipt.id},data:{enrichmentClaimId:owner,enrichmentLeaseExpiresAt:until}});
  const video=await db.trackedVideo.create({data:{workspaceId:f.post.workspaceId!,socialPostId:f.post.id,socialAccountId:f.post.socialAccountId,platform:"youtube_shorts",platformPostId:crypto.randomUUID(),publishedAt:new Date()}});
  const capture=await db.performanceCapture.create({data:{trackedVideoId:video.id,slot:0,dueAt:new Date(1000),leaseOwner:owner,leaseExpiresAt:until}});
  const page={deploymentEpoch:1,cutoff:new Date(6000),after:null,limit:32};
  const receipts=await db.$transaction(tx=>planPublicationReceiptRecoveryPage(tx,page));
  const captures=await db.$transaction(tx=>planPerformanceCaptureRecoveryPage(tx,page));
  expect(receipts.processed).toBe(1);expect(captures.processed).toBe(1);
  const records=await db.executionDispatch.findMany({where:{id:{in:[...receipts.dispatchIds!,...captures.dispatchIds!]}}});
  expect(records.map(row=>row.subjectId).sort()).toEqual([`po1.yw.${f.receipt.id}.${owner}.5000`,`po1.cw.${capture.id}.${owner}.5000`].sort());
  expect(records.every(row=>row.dueAt.getTime()===5000)).toBe(true);
  expect((await db.providerReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).enrichmentCheckCount).toBe(0);
  expect((await db.performanceCapture.findUniqueOrThrow({where:{id:capture.id}})).attempts).toBe(0);
 });

 test("daily grant expiry only restores the matching revision timer and leaves future grants alone",async()=>{
  const due=await publicationGrant(await fixture(),new Date(7000)),future=await publicationGrant(await fixture(),new Date(9000));
  const page={deploymentEpoch:1,cutoff:new Date(8000),after:{at:new Date(6500),id:"00000000-0000-0000-0000-000000000000"},limit:1};
  const planned=await db.$transaction(tx=>planStandingGrantExpiryPage(tx,page));
  expect(planned.processed).toBe(1);expect(planned.next).toBeNull();expect(planned.dispatchIds).toHaveLength(1);
  const timer=await db.executionDispatch.findUniqueOrThrow({where:{id:planned.dispatchIds![0]}});
  expect(timer.subjectId).toBe(`pub1.x.${due.id}.1.7000`);expect(timer.dueAt).toEqual(due.expiresAt);
  expect((await db.standingGrant.findUniqueOrThrow({where:{id:due.id}})).status).toBe("active");
  expect((await db.standingGrant.findUniqueOrThrow({where:{id:future.id}})).status).toBe("active");
  expect(await db.$transaction(tx=>planStandingGrantExpiryPage(tx,page))).toEqual(planned);
 });
 test("restore pages keep accepted provider identity and budgets while respecting the frozen source cutoff",async()=>{
  const f=await active(),physical=await claimed(f),future=await fixture();
  await f.call({action:"process-start",fence:physical.fence});
  await physical.command({kind:"checkpoint",operation:{kind:"upload_prepared",state:{providerOperation:"youtube_resumable_upload",uploadUrl:"https://www.googleapis.com/exact-session"}}});
  await db.socialPost.update({where:{id:f.post.id},data:{createdAt:new Date(10000)}});
  await db.socialPost.update({where:{id:future.post.id},data:{createdAt:new Date(12000)}});
  const before=await db.socialPublicationAttempt.findFirstOrThrow({where:{socialPostId:f.post.id}}),sentinel=Error("rollback publication page proof");
  await expect(db.$transaction(async tx=>{
   await tx.executionEpoch.update({where:{id:1},data:{epoch:2,admissionOpen:false}});
   const page={snapshotEpoch:1,fenceAboveEpoch:1,deploymentEpoch:2,cutoff:new Date(11000),after:{at:new Date(9500),id:"00000000-0000-0000-0000-000000000000"},limit:32};
   const planned=await planPublicationRestorePage(tx,page);
   expect(planned.processed).toBe(1);expect(planned.next).toBeNull();expect(planned.dispatchIds).toHaveLength(2);
   expect(await tx.socialPost.findUniqueOrThrow({where:{id:future.post.id}})).toMatchObject({deploymentEpoch:1});
   expect(await tx.socialPublicationAttempt.findUniqueOrThrow({where:{id:before.id}})).toMatchObject({idempotencyKey:before.idempotencyKey,nativeStartCount:before.nativeStartCount,providerCallCount:before.providerCallCount,checkpointEncrypted:before.checkpointEncrypted,processingDeadline:before.processingDeadline,reconciliationDeadline:before.reconciliationDeadline,currentClaimId:null});
   expect(await tx.publicationClaim.findUniqueOrThrow({where:{id:physical.fence.attemptToken}})).toMatchObject({accountSlotKey:null});
   expect((await tx.socialPost.findUniqueOrThrow({where:{id:f.post.id}})).deploymentEpoch).toBe(2);
   expect((await planPublicationRestorePage(tx,page)).processed).toBe(0);
   throw sentinel;
  })).rejects.toBe(sentinel);
 });

});
