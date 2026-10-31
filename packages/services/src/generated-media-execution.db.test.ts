import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { GeneratedMediaExecution, generatedMediaObjectIsHeld } from "./generated-media-execution";
import { createExecutorControl } from "./executor-control";
import { readExecutionDispatch } from "./execution-dispatch";
const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite =
	process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url
		? describe
		: describe.skip;
suite("Native generated media authority and atomic usage", () => {
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
			data: { clerkId: `native-generated:${crypto.randomUUID()}` },
		});
		const workspace = await db.workspace.create({
			data: {
				name: "Generated execution",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
				pricingTier: "business",
			},
		});
		const project = await db.project.create({
			data: {
				workspaceId: workspace.id,
				title: "Generated",
				sourceMediaUrl: "r2://gate/source",
				ingestStatus: "ready",
			},
		});
		const scope = {
			actorUserId: user.id,
			workspaceId: workspace.id,
			workspaceOwnerUserId: user.id,
			role: "owner" as const,
			status: "active" as const,
			pricingTier: "business",
			isPersonalWorkspace: true,
		};
		const objects = new Map<string, { bytes: Uint8Array; etag: string }>(),
			dispatches: string[] = [];
		let missingRecovery = false;
		const hooks: { beforePut?: () => Promise<void>; lostPutAck?: boolean; lostRegisterAck?: boolean } = {};
		const confirm = async (ids: readonly string[]) => {
			dispatches.push(...ids);
			if (hooks.lostRegisterAck) throw new Error("registration ACK lost");
			await db.executionDispatch.updateMany({where:{id:{in:[...ids]}},data:{acknowledgedAt:new Date()}});
		};
		const domain = new GeneratedMediaExecution(db, {
			model: "native-test",
			quality: "medium",
			maxOutputBytes: 100000000,
			maxAttempts: 4,
			maxPromptCharacters: 20000,
			promptProtection: {
				protect: (s) => `sealed:${s}`,
				reveal: (s) => s.slice(7),
				fingerprint: (s) => createHash("sha256").update(s).digest("hex"),
			},
			register: confirm,
			inputStorage: {
				put: async (plan, bytes) => {
					await hooks.beforePut?.();
					objects.set(plan.storageKey, { bytes, etag: '"input"' });
					if (hooks.lostPutAck) throw new Error("PUT ACK lost");
				},
				head: async (plan) =>
					objects.has(plan.storageKey)
						? {
								etag: '"input"',
								byteLength: plan.byteLength,
								sha256: plan.sha256,
							}
						: null,
			},
			headArtifact: async (row) =>
				missingRecovery
					? null
					: {
							etag: '"sealed"',
							byteLength: row.byteLength ?? row.uploadByteLength ?? 1234n,
							contentType: row.contentType,
							sha256: row.checksumSha256 ?? "a".repeat(64),
						},
			assetUrl: async () => "https://assigned.example/image",
		});
		const input = {
			projectId: project.id,
			idempotencyKey: crypto.randomUUID(),
			prompt: "A native generated frame",
			promptOrigin: "manual" as const,
			aspectRatio: "9:16" as const,
			style: "editorial" as const,
		};
		return {
			domain,
			hooks,
			confirm,
			scope,
			project,
			input,
			objects,
			dispatches,
			setMissingRecovery: (v: boolean) => {
				missingRecovery = v;
			},
		};
	}
	async function prepare(f: Awaited<ReturnType<typeof fixture>>, id: string) {
		const row = await db.generatedMediaJob.findUniqueOrThrow({ where: { id } });
		const d = await db.executionDispatch.findFirstOrThrow({
			where: {
				kind: "operation_driver",
				subjectKind: "generated_media",
				subjectId: id,
				generation: row.generation,
				wakeKind: null,
				deadlineKind: null,
			},
		});
		const p = await f.domain.prepareExecution(
			(await readExecutionDispatch(db, d.id))!.reference,
		);
		if (p.kind !== "waiting")
			throw new Error("Expected waiting native attempt");
		const { reference, attemptToken } = p.deadline,
			owner = crypto.randomUUID(),
			fence = { reference, attemptToken, owner };
		let evidence: unknown;
		const control = createExecutorControl({
			database: db,
			subjectKind: "generated_media",
			domain: f.domain,
			deliverWakes: f.confirm,
			artifacts: {
				head: async (a) => ({
					etag: '"sealed"',
					contentType: a.contentType,
					byteLength: a.role === "probe" ? 512n : 1234n,
					sha256: a.role === "probe" ? "b".repeat(64) : "a".repeat(64),
				}),
				prepare: async (_a, artifact) => ({
					...artifact,
					...(artifact.role === "probe" ? { evidence } : {}),
				}),
			},
		});
		const execute = (command: unknown, deliveryId = crypto.randomUUID()) =>
			control.execute({
				command,
				verifiedRequest: {
					requestHash: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
					metadata: {
						version: 1,
						keyId: "gate",
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
			reference,
			attemptToken,
			owner,
			leaseSeconds: 120,
		});
		const binary = await db.executionArtifact.create({
			data: {
				attemptToken,
				owner,
				role: "validated_asset",
				bindingHash: reference.inputHash,
				storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/image.png`,
				contentType: "image/png",
				maxBytes: 100000000n,
				grantExpiresAt: new Date(Date.now() + 60000),
			},
		});
		const probe = await db.executionArtifact.create({
			data: {
				attemptToken,
				owner,
				role: "probe",
				bindingHash: reference.inputHash,
				storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/probe.json`,
				contentType: "application/json",
				maxBytes: 65536n,
				grantExpiresAt: new Date(Date.now() + 60000),
			},
		});
		const completed = {
			version: 1,
			kind: "generated_image",
			jobId: id,
			requestId: attemptToken,
			inputHash: reference.inputHash,
			outcome: "completed",
			providerRef: "accepted-provider",
			usageImages: 1,
			binaryArtifactId: binary.id,
			image: {
				kind: "visual",
				sha256: "a".repeat(64),
				byteLength: 1234,
				contentType: "image/png",
				mediaKind: "image",
				width: 32,
				height: 24,
				durationSec: null,
			},
		};
		evidence = completed;
		const commit = (artifact: typeof binary) =>
			execute({
				action: "commit-artifact",
				fence,
				artifact: {
					artifactId: artifact.id,
					role: artifact.role,
					bindingHash: reference.inputHash,
					contentType: artifact.contentType,
					byteLength: artifact.role === "probe" ? 512 : 1234,
					sha256: artifact.role === "probe" ? "b".repeat(64) : "a".repeat(64),
					etag: '"sealed"',
				},
			});
		return {
			control,
			execute,
			commit,
			reference,
			attemptToken,
			owner,
			fence,
			binary,
			probe,
			completed,
			evidence: (v: unknown) => {
				evidence = v;
			},
		};
	}
	test("admission reserves and schedules once; only two sealed outputs atomically publish and finalize usage", async () => {
		const f = await fixture(),
			job = await f.domain.create(f.scope, f.input);
		expect(job.status).toBe("queued");
		expect((await f.domain.create(f.scope, f.input)).id).toBe(job.id);
		expect(
			await db.generatedMediaUsageReservation.count({
				where: { workspaceId: f.scope.workspaceId },
			}),
		).toBe(1);
		const p = await prepare(f, job.id);
		const attempt = await db.executionAttempt.findUniqueOrThrow({
			where: { attemptToken: p.attemptToken },
		});
		expect(attempt.functionName).toBe("generated_image");
		expect(attempt.inputChecksumSha256).not.toBeNull();
		expect(f.objects.size).toBe(1);
		await p.execute({ action: "process-start", fence: p.fence });
		await p.execute({ action: "process-start", fence: p.fence });
		expect(
			(await db.generatedMediaJob.findUniqueOrThrow({ where: { id: job.id } }))
				.chargedAttempts,
		).toBe(1);
		await p.commit(p.probe);
		expect(
			await db.visualAsset.count({
				where: { createdByUserId: f.scope.actorUserId },
			}),
		).toBe(0);
		await p.commit(p.binary);
		const final = await f.domain.get(f.scope, job.id);
		expect(final.status).toBe("completed");
		expect(final.resultAsset?.provenance).toBe("generated");
		const usage = await db.generatedMediaUsageReservation.findUniqueOrThrow({
			where: { jobId: job.id },
		});
		expect(usage.status).toBe("finalized");
		expect(usage.actualUnits).toBe(1);
	});
	test("an interrupted POST holds its reservation without a lease and no automatic new provider attempt", async () => {
		const f = await fixture(),
			job = await f.domain.create(f.scope, f.input),
			p = await prepare(f, job.id);
		await p.execute({ action: "process-start", fence: p.fence });
		await p.execute({
			action: "fail",
			fence: p.fence,
			failureCode: "media_execution_failed",
			retryable: true,
		});
		let row = await db.generatedMediaJob.findUniqueOrThrow({
			where: { id: job.id },
		});
		expect(row.status).toBe("waiting");
		expect(row.outcomeUnknown).toBe(true);
		expect(row.executorOwner).toBeNull();
		expect(row.claimExpiresAt).toBeNull();
		expect(
			(
				await db.generatedMediaUsageReservation.findUniqueOrThrow({
					where: { jobId: job.id },
				})
			).status,
		).toBe("reserved");
		await expect(f.domain.cancel(f.scope, job.id)).rejects.toMatchObject({
			code: "generated_media_reconciliation_required",
		});
		await expect(
			f.domain.reconcile(f.scope.workspaceId, job.id, {
				kind: "completed",
				providerRef: "accepted-provider",
			}),
		).rejects.toMatchObject({
			code: "generated_media_provider_result_unavailable",
		});
		await f.domain.reconcile(f.scope.workspaceId, job.id, { kind: "retry" });
		row = await db.generatedMediaJob.findUniqueOrThrow({
			where: { id: job.id },
		});
		expect(row.generation).toBe(2);
		expect(row.chargedAttempts).toBe(1);
		expect(row.outcomeUnknown).toBe(false);
		expect(row.usageStatus).toBe("reserved");
	});
	test("cancel before provider start refunds once and rejects a late native start", async () => {
		const f = await fixture(),
			job = await f.domain.create(f.scope, f.input),
			p = await prepare(f, job.id);
		await f.domain.cancel(f.scope, job.id);
		expect(
			(await p.execute({ action: "process-start", fence: p.fence }))
				.disposition,
		).toBe("cancelled");
		expect(
			(await db.generatedMediaJob.findUniqueOrThrow({ where: { id: job.id } }))
				.chargedAttempts,
		).toBe(0);
		expect(
			(
				await db.generatedMediaUsageReservation.findUniqueOrThrow({
					where: { jobId: job.id },
				})
			).status,
		).toBe("released");
	});
	test("after start cancellation stays pending until a known result; cancellation and final adoption serialize", async () => {
		const f = await fixture(),
			job = await f.domain.create(f.scope, f.input),
			p = await prepare(f, job.id);
		await p.execute({ action: "process-start", fence: p.fence });
		await expect(f.domain.cancel(f.scope, job.id)).rejects.toMatchObject({
			code: "generated_media_cancellation_pending",
		});
		await p.commit(p.probe);
		await Promise.allSettled([
			p.commit(p.binary),
			f.domain.cancel(f.scope, job.id),
		]);
		const row = await db.generatedMediaJob.findUniqueOrThrow({
				where: { id: job.id },
			}),
			usage = await db.generatedMediaUsageReservation.findUniqueOrThrow({
				where: { jobId: job.id },
			});
		if (row.status === "completed") {
			expect(usage.status).toBe("finalized");
			expect(row.resultAssetId).not.toBeNull();
		} else {
			expect(row.status).toBe("cancelled");
			expect(usage.status).toBe("released");
			expect(row.resultAssetId).toBeNull();
		}
	});
	test("lost registration and input PUT ACKs replay one reservation; no execution is visible before sealing", async () => {
		const f = await fixture();
		f.hooks.lostRegisterAck = true;
		await expect(f.domain.create(f.scope, f.input)).rejects.toMatchObject({code:"generated_media_provider_result_unavailable"});
		f.hooks.lostRegisterAck = false;
		const job = await f.domain.create(f.scope, f.input);
		let writes = 0;
		f.hooks.beforePut = async () => {
			writes++;
			expect(await db.executionDispatch.count({where:{subjectId:job.id,kind:"modal_execution"}})).toBe(0);
			expect(await db.executionAttempt.count({where:{dispatch:{subjectId:job.id}}})).toBe(0);
			const row = await db.generatedMediaJob.findUniqueOrThrow({where:{id:job.id}});
			const key = (row.resultState as {inputPlan:{storageKey:string}}).inputPlan.storageKey;
			expect(await generatedMediaObjectIsHeld(db,key)).toBe(true);
		};
		f.hooks.lostPutAck = true;
		await prepare(f, job.id);
		expect(writes).toBe(1);
		expect(await db.generatedMediaUsageReservation.count({where:{jobId:job.id}})).toBe(1);
		expect(await db.executionDispatch.count({where:{subjectId:job.id,kind:"modal_execution"}})).toBe(1);
	});
	test("binary-first and duplicate final commit publish one asset, usage charge, and analytics settlement", async () => {
		const f = await fixture(),job = await f.domain.create(f.scope,f.input),p = await prepare(f,job.id);
		await p.execute({action:"process-start",fence:p.fence});
		await p.commit(p.binary);
		expect((await f.domain.get(f.scope,job.id)).status).toBe("running");
		await p.commit(p.probe);
		await p.commit(p.probe);
		expect(await db.visualAsset.count({where:{createdByUserId:f.scope.actorUserId}})).toBe(1);
		expect(await db.programAnalyticsEvent.count({where:{workspaceId:f.scope.workspaceId,type:"generated_asset_settled"}})).toBe(1);
		expect(await db.programAnalyticsEvent.count({where:{workspaceId:f.scope.workspaceId,type:"generated_asset_completed"}})).toBe(1);
		expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{jobId:job.id}})).actualUnits).toBe(1);
	});
	test("known rate limits schedule a bounded retry, while rejected content releases usage", async () => {
		const f = await fixture(),job=await f.domain.create(f.scope,f.input),p=await prepare(f,job.id);
		await p.execute({action:"process-start",fence:p.fence});
		p.evidence({version:1,kind:"generated_image",jobId:job.id,requestId:p.attemptToken,inputHash:p.reference.inputHash,outcome:"failed",code:"generated_media_provider_rate_limited",retryable:true,retryAfterMs:60000,providerRef:null});
		await p.commit(p.probe);
		const row=await db.generatedMediaJob.findUniqueOrThrow({where:{id:job.id}});
		expect(row.status).toBe("queued");expect(row.generation).toBe(2);expect(row.chargedAttempts).toBe(1);expect(row.executorOwner).toBeNull();
		expect(row.retryAt!.getTime()).toBeGreaterThan(Date.now()+50000);
		const retry=await db.executionDispatch.findFirstOrThrow({where:{subjectId:job.id,generation:2,kind:"operation_driver",deadlineKind:null,wakeKind:null}});
		expect((await f.domain.prepareExecution((await readExecutionDispatch(db,retry.id))!.reference)).kind).toBe("sleep");
		const other=await fixture(),rejected=await other.domain.create(other.scope,other.input),r=await prepare(other,rejected.id);
		await r.execute({action:"process-start",fence:r.fence});
		r.evidence({version:1,kind:"generated_image",jobId:rejected.id,requestId:r.attemptToken,inputHash:r.reference.inputHash,outcome:"rejected",code:"generated_media_safety_rejected",retryable:false,retryAfterMs:null,providerRef:null});
		await r.commit(r.probe);
		expect((await other.domain.get(other.scope,rejected.id)).status).toBe("rejected");
		expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{jobId:rejected.id}})).status).toBe("released");
	});
	test("lost binary complete ACK recovers only the original sealed assignment without another provider attempt", async () => {
		const f=await fixture(),job=await f.domain.create(f.scope,f.input),p=await prepare(f,job.id);
		await p.execute({action:"process-start",fence:p.fence});
		await p.commit(p.probe);
		await db.executionArtifact.update({where:{id:p.binary.id},data:{uploadByteLength:1234n,multipartUploadId:"lost-complete-ack",checksumSha256:"a".repeat(64),multipartCompleteIntentAt:new Date()}});
		await p.execute({action:"fail",fence:p.fence,failureCode:"media_execution_failed",retryable:true});
		expect(await generatedMediaObjectIsHeld(db,p.binary.storageKey)).toBe(true);
		f.setMissingRecovery(true);
		await expect(f.domain.reconcile(f.scope.workspaceId,job.id,{kind:"completed",providerRef:"accepted-provider"})).rejects.toMatchObject({code:"generated_media_provider_result_unavailable"});
		f.setMissingRecovery(false);
		await f.domain.reconcile(f.scope.workspaceId,job.id,{kind:"completed",providerRef:"accepted-provider"});
		const r=await prepare(f,job.id),input=await f.domain.workInput(job.id);
		expect(input.sources).toEqual([{name:"generated_result",storageKey:p.binary.storageKey,etag:'"sealed"',sha256:"a".repeat(64),byteLength:1234}]);
		const staged=JSON.parse(new TextDecoder().decode([...f.objects.values()][1]!.bytes));
		expect(staged.mode).toBe("recover");expect(staged).not.toHaveProperty("prompt");
		expect((await p.execute({action:"process-start",fence:p.fence})).disposition).toBe("superseded");
		await r.execute({action:"process-start",fence:r.fence});
		await r.commit(r.probe);await r.commit(r.binary);
		const row=await db.generatedMediaJob.findUniqueOrThrow({where:{id:job.id}});
		expect(row.status).toBe("completed");expect(row.attempt).toBe(1);expect(row.chargedAttempts).toBe(2);
		expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{jobId:job.id}})).actualUnits).toBe(1);
	});
	test("current workspace restriction after start holds ambiguous usage and forbids publication", async () => {
		const f=await fixture(),job=await f.domain.create(f.scope,f.input),p=await prepare(f,job.id);
		await p.execute({action:"process-start",fence:p.fence});
		await db.workspace.update({where:{id:f.scope.workspaceId},data:{status:"restricted"}});
		await p.commit(p.probe);
		const row=await db.generatedMediaJob.findUniqueOrThrow({where:{id:job.id}});
		expect(row.outcomeUnknown).toBe(true);expect(row.executorOwner).toBeNull();
		expect(await db.visualAsset.count({where:{createdByUserId:f.scope.actorUserId}})).toBe(0);
		expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{jobId:job.id}})).status).toBe("reserved");
	});

	test("fresh watchdog expires a started lease into unknown; a stale observation cannot end a renewed lease", async () => {
		const f=await fixture(),job=await f.domain.create(f.scope,f.input),p=await prepare(f,job.id);
		await p.execute({action:"process-start",fence:p.fence});
		const expired=new Date(Date.now()-1000),deadline={reference:p.reference,attemptToken:p.attemptToken,kind:"lease" as const,observedDeadlineAt:expired.toISOString()};
		expect((await p.control.expireDeadline({deadline,deliveryId:crypto.randomUUID()})).kind).toBe("sleep");
		await db.$transaction(async tx=>{
			await tx.generatedMediaJob.update({where:{id:job.id},data:{claimExpiresAt:expired}});
			await tx.executionAttempt.update({where:{attemptToken:p.attemptToken},data:{leaseExpiresAt:expired}});
		});
		const deliveryId=crypto.randomUUID();
		expect((await p.control.expireDeadline({deadline,deliveryId})).kind).toBe("expired");
		expect((await p.control.expireDeadline({deadline,deliveryId})).kind).toBe("expired");
		const row=await db.generatedMediaJob.findUniqueOrThrow({where:{id:job.id}});
		expect(row.outcomeUnknown).toBe(true);expect(row.executorOwner).toBeNull();expect(row.claimExpiresAt).toBeNull();expect(row.chargedAttempts).toBe(1);
		expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{jobId:job.id}})).status).toBe("reserved");
		await f.domain.reconcile(f.scope.workspaceId,job.id,{kind:"failed",code:"operator_confirmed_failure"});
		expect(await generatedMediaObjectIsHeld(db,p.binary.storageKey)).toBe(false);
	});

});
