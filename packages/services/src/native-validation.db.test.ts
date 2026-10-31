import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { NativeValidationService } from "./native-validation";
import { createExecutorControl } from "./executor-control";
import { readExecutionDispatch } from "./execution-dispatch";
import { nativeRestoreFixtureInput,prepareNativeRestoreFixture } from "../scripts/gates/qualified-restore-native-fixture";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Native validation admission and fenced publication", () => {
  let db: PrismaClient;
  const users: string[] = [], subjects: string[] = [], receipts: string[] = [];
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 60_000 } });
  });
  afterAll(async () => {
    const ids = (await db.executionDispatch.findMany({ where: { subjectId: { in: subjects } }, select: { id: true } })).map(row => row.id);
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: ids } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: ids } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: ids } } });
    await db.nativeValidationJob.deleteMany({ where: { createdByUserId: { in: users } } });
    await db.brandFont.deleteMany({ where: { licenseConfirmedByUserId: { in: users } } });
    await db.visualAsset.deleteMany({ where: { createdByUserId: { in: users } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }, 60_000);
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `native-validation:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Native validation gate", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "business" } });
    const scope = { actorUserId: user.id, workspaceId: workspace.id, workspaceOwnerUserId: user.id, isPersonalWorkspace: true, role: "owner" as const, status: "active" as const, pricingTier: "business" };
    const registered: string[] = []; let heads = 0;
    const service = new NativeValidationService(db, { head: async () => { heads++; return { contentType: "font/ttf", sizeBytes: 170812, etag: '"uploaded-font"' }; }, register: async ids => { registered.push(...ids); } });
    return { service, scope, registered, heads: () => heads, input: { kind: "font" as const, key: `brand-fonts/${user.id}/input.ttf`, contentType: "font/ttf" as const, sizeBytes: 170812, fingerprint: "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab", licenseConfirmed: true as const } };
  }
  test("admission persists pending work and confirms its scheduler before exposing any usable font", async () => {
    const f = await fixture(); const first = await f.service.admit(f.scope, f.input); subjects.push(first.jobId);
    expect(first.status).toBe("pending");
    expect(await db.brandFont.count({ where: { licenseConfirmedByUserId: f.scope.actorUserId } })).toBe(0);
    expect(f.registered).toHaveLength(1);
    const replay = await f.service.admit(f.scope, f.input);
    expect(replay.jobId).toBe(first.jobId); expect(f.heads()).toBe(1);
    expect((await f.service.get(f.scope, first.jobId)).status).toBe("pending");
  }, 60_000);
  test("only a live started owner can publish a font after its binary and stored metrics are both sealed", async () => {
    const f = await fixture(); const opened = await f.service.admit(f.scope, f.input); subjects.push(opened.jobId);
    const parent = (await readExecutionDispatch(db, f.registered[0]!))!.reference;
    const planned = await f.service.prepareExecution(parent);
    if (planned.kind !== "waiting") throw new Error("Expected a prepared validation execution");
    const reference = planned.deadline.reference, attemptToken = planned.deadline.attemptToken, owner = crypto.randomUUID();
    const fence = { reference, attemptToken, owner };
    const evidence = { kind: "font" as const, sha256: f.input.fingerprint, byteLength: 170812, format: "ttf" as const, family: "Anton", style: "Regular", weight: 400,
      face: { name: "Anton", file: "" as const, assName: "Anton Regular", weight: 400, style: "normal" as const, ascent: 1.404296875, descent: 0.3291015625, capHeight: 0.859375 } };
    const control = createExecutorControl({ database: db, subjectKind: "native_validation", domain: f.service, deliverWakes: async () => {}, artifacts: {
      head: async assignment => ({ etag: '"sealed"', contentType: assignment.contentType, byteLength: assignment.role === "probe" ? 512n : 170812n, sha256: assignment.role === "probe" ? "b".repeat(64) : f.input.fingerprint }),
      prepare: async (_assignment, artifact) => ({ ...artifact, ...(artifact.role === "probe" ? { evidence } : {}) }),
    } });
    function verified() { const deliveryId = crypto.randomUUID(); receipts.push(deliveryId); return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: {
      version: 1 as const, keyId: "native-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } }; }
    const execute = (command: unknown) => control.execute({ command, verifiedRequest: verified() });
    expect((await execute({ action: "acquire", reference, attemptToken, owner, leaseSeconds: 120 })).disposition).toBe("acquired");
    expect((await execute({ action: "acquire", reference, attemptToken, owner: crypto.randomUUID(), leaseSeconds: 120 })).disposition).toBe("busy");
    expect((await execute({ action: "process-start", fence })).disposition).toBe("started");
    expect((await execute({ action: "process-start", fence })).disposition).toBe("started");
    expect((await db.nativeValidationJob.findUniqueOrThrow({ where: { id: opened.jobId } })).chargedAttempts).toBe(1);
    const binary = await db.executionArtifact.create({ data: { attemptToken, owner, role: "validated_font", bindingHash: reference.inputHash,
      storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/font.ttf`, contentType: "font/ttf", maxBytes: 170812n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const metadata = await db.executionArtifact.create({ data: { attemptToken, owner, role: "probe", bindingHash: reference.inputHash,
      storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/validation.json`, contentType: "application/json", maxBytes: 65536n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const binaryCommand = { action: "commit-artifact", fence, artifact: { artifactId: binary.id, role: "validated_font", bindingHash: reference.inputHash,
      contentType: "font/ttf", byteLength: 170812, sha256: f.input.fingerprint, etag: '"sealed"' } };
    const binaryRequest = verified();
    await control.execute({ command: binaryCommand, verifiedRequest: binaryRequest });
    expect((await f.service.get(f.scope, opened.jobId)).status).toBe("pending");
    expect(await db.brandFont.count({ where: { licenseConfirmedByUserId: f.scope.actorUserId } })).toBe(0);
    await execute({ action: "commit-artifact", fence, artifact: { artifactId: metadata.id, role: "probe", bindingHash: reference.inputHash,
      contentType: "application/json", byteLength: 512, sha256: "b".repeat(64), etag: '"sealed"' } });
    const ready = await f.service.get(f.scope, opened.jobId);
    expect(ready.status).toBe("ready");
    const font = await db.brandFont.findFirstOrThrow({ where: { licenseConfirmedByUserId: f.scope.actorUserId } });
    expect(font.storageKey).toBe(binary.storageKey); expect(font.face).toMatchObject({ assName: "Anton Regular" });
    expect((await control.execute({ command: binaryCommand, verifiedRequest: binaryRequest })).disposition).toBe("committed");
    expect(await db.brandFont.count({ where: { licenseConfirmedByUserId: f.scope.actorUserId } })).toBe(1);
  }, 180_000);
  test("expiry before process start revokes the old token without charging or publishing an asset", async () => {
    const f = await fixture(); const opened = await f.service.admit(f.scope, f.input); subjects.push(opened.jobId);
    const planned = await f.service.prepareExecution((await readExecutionDispatch(db, f.registered[0]!))!.reference);
    if (planned.kind !== "waiting") throw new Error("Expected validation execution");
    const { reference, attemptToken } = planned.deadline; const owner = crypto.randomUUID();
    const control = createExecutorControl({ database: db, subjectKind: "native_validation", domain: f.service, deliverWakes: async () => {} });
    function verified() { const deliveryId = crypto.randomUUID(); receipts.push(deliveryId); return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "native-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } }; }
    await control.execute({ command: { action: "acquire", reference, attemptToken, owner, leaseSeconds: 120 }, verifiedRequest: verified() });
    const due = await db.$transaction(async tx => {
      const [clock] = await tx.$queryRaw<Array<{ due: Date }>>`SELECT (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC' AS "due"`;
      await tx.nativeValidationJob.update({ where: { id: opened.jobId }, data: { leaseExpiresAt: clock!.due } });
      await tx.executionAttempt.update({ where: { attemptToken }, data: { leaseExpiresAt: clock!.due } });
      return clock!.due;
    });
    const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
    // The persisted timer can name an older lease after active renewal. Once
    // the current lease is also due, it must still expire this exact owner.
    expect((await control.expireDeadline({ deadline: { reference, attemptToken, kind: "lease", observedDeadlineAt: new Date(due.getTime() - 1000).toISOString() }, deliveryId })).kind).toBe("expired");
    expect((await control.execute({ command: { action: "process-start", fence: { reference, attemptToken, owner } }, verifiedRequest: verified() })).disposition).toBe("superseded");
    const current = await db.nativeValidationJob.findUniqueOrThrow({ where: { id: opened.jobId } });
    expect(current.generation).toBe(2); expect(current.chargedAttempts).toBe(0); expect(current.executorOwner).toBeNull();
    expect(await db.brandFont.count({ where: { licenseConfirmedByUserId: f.scope.actorUserId } })).toBe(0);
  }, 180_000);
  test("private restore fixture uses actual admission/preparation, leaves registration pending, and closes temporary admission on replay or HEAD failure",async()=>{
    const f=await fixture(),state=await db.executionEpoch.findUniqueOrThrow({where:{id:1}}),runId=crypto.randomUUID();
    const input=nativeRestoreFixtureInput({version:1,runId,inputKey:`visual-assets/${f.scope.actorUserId}/restore-${runId}/source.png`,inputBytes:72,inputSha256:"a".repeat(64)});
    await db.executionEpoch.update({where:{id:1},data:{admissionOpen:false}});
    try{
      const options={database:db,epoch:state.epoch,userId:f.scope.actorUserId,workspaceId:f.scope.workspaceId,input,head:async()=>({contentType:"image/png",sizeBytes:72,etag:'"png"'})};
      const prepared=await prepareNativeRestoreFixture(options);subjects.push(prepared.jobId!);
      expect(prepared).toMatchObject({normalModalRegistration:"pending",invocation:{reference:{kind:"modal_execution",deploymentEpoch:state.epoch}}});
      expect(await db.nativeValidationJob.findUniqueOrThrow({where:{id:prepared.jobId}})).toMatchObject({status:"queued",chargedAttempts:0,executorOwner:null,inputStorageKey:input.inputKey,inputEtag:'"png"'});
      expect(await db.executionAttempt.findUniqueOrThrow({where:{attemptToken:prepared.invocation.attemptToken}})).toMatchObject({status:"admitted",owner:null,processStartedAt:null});
      expect(await db.executionDispatch.count({where:{subjectId:prepared.jobId,acknowledgedAt:{not:null}}})).toBe(0);
      expect((await db.executionEpoch.findUniqueOrThrow({where:{id:1}})).admissionOpen).toBe(false);
      expect(await prepareNativeRestoreFixture(options)).toEqual(prepared);
      expect(await db.executionAttempt.count({where:{dispatch:{subjectId:prepared.jobId}}})).toBe(1);
      let heads=0;const failedRun=crypto.randomUUID();
      await expect(prepareNativeRestoreFixture({...options,input:{...input,runId:failedRun,inputKey:`visual-assets/${f.scope.actorUserId}/restore-${failedRun}/source.png`},head:async()=>{heads++;if(heads===2)throw Error("head_failed_after_admission_open");return{contentType:"image/png",sizeBytes:72,etag:'"png"'};}})).rejects.toThrow("head_failed_after_admission_open");
      expect((await db.executionEpoch.findUniqueOrThrow({where:{id:1}})).admissionOpen).toBe(false);
      expect(await db.nativeValidationJob.count({where:{createdByUserId:f.scope.actorUserId}})).toBe(1);
      const cancellation=new AbortController();cancellation.abort();
      await expect(prepareNativeRestoreFixture({...options,signal:cancellation.signal})).rejects.toThrow("qualified_native_fixture_refused");
      expect((await db.executionEpoch.findUniqueOrThrow({where:{id:1}})).admissionOpen).toBe(false);
    }finally{await db.executionEpoch.update({where:{id:1},data:{admissionOpen:state.admissionOpen}});}
  });
});
