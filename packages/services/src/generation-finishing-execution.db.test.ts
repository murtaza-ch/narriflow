import {planFinishingRecoveryPage,planFinishingRestorePage} from "./generation-finishing-maintenance";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { assertGenerationFinishingAuthority, createGenerationFinishing, FINISHING_MAX_OPERATION_MS, freezeGenerationFinishing, queueGenerationFinishing, transitionGenerationFinishing, type GenerationFinishingDependencies } from "./generation-finishing";
import { appendFinishingExportWake, createFinishingProducers } from "./generation-finishing-producers";
import { readExecutionDispatch } from "./execution-dispatch";
import { AssistedSocialCopyError } from "./assisted-social-copy";
import type { FinishingSettings } from "@narriflow/validators";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Targeted generation finishing obligations", () => {
  let db: PrismaClient;
  const users: string[] = [], workspaces: string[] = [], finishings: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url,schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  });
  afterEach(async () => {
    await db.executionDispatch.deleteMany({ where: { subjectKind: "generation_finishing", subjectId: { in: finishings } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = workspaces.length = finishings.length = 0;
  });
  afterAll(async () => { await db.$disconnect(); });
  async function fixture(settings: Partial<FinishingSettings> = {}) {
    const user = await db.user.create({ data: { clerkId: `finishing-execution:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Finishing gate", ownerUserId: user.id, pricingTier: "business" } }); workspaces.push(workspace.id);
    await db.workspaceMember.create({data:{workspaceId:workspace.id,userId:user.id,role:"owner"}});
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Finishing gate", sourceMediaUrl: "r2://synthetic/source" } });
    const origin = await db.workflowRun.create({ data: { projectId: project.id, stage: "stt", status: "completed", idempotencyKey: crypto.randomUUID() } });
    await db.$transaction(tx => freezeGenerationFinishing(tx, { workspaceId: workspace.id, projectId: project.id, originRunId: origin.id, actorUserId: user.id,
      settings: { topClips: 2, minScore: 0, resolution: "720p", copyPlatforms: [], delivery: "ready_to_review", queueAccountIds: [], ...settings }, defaultAspectRatio: "9:16" }));
    const row = await db.generationFinishing.findUniqueOrThrow({ where: { originRunId: origin.id } }); finishings.push(row.id);
    return { row, origin };
  }
  test("restore revokes the old owner and preserves child facts and deadlines before final redispatch",async()=>{
    const value=await due();const original=await db.generationFinishing.update({where:{id:value.row.id},data:{state:"running",claimToken:crypto.randomUUID(),leaseExpiresAt:new Date(Date.now()+60_000),attempts:2,picks:[{clipId:crypto.randomUUID(),editorRevision:3,exportId:crypto.randomUUID(),copyGenerationId:crypto.randomUUID()}]}});
    const rollback=Error("restore_fixture_rollback");
    await expect(db.$transaction(async tx=>{
      const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}});
      const fence=await tx.executionEpoch.update({where:{id:1},data:{epoch:epoch.epoch+1,admissionOpen:false,changedAt:new Date()}});
      const page={snapshotEpoch:epoch.epoch,fenceAboveEpoch:epoch.epoch,deploymentEpoch:fence.epoch,cutoff:fence.changedAt,after:{at:original.createdAt,id:"00000000-0000-0000-0000-000000000000"},limit:1};
      const before=await tx.executionDispatch.count();
      expect(await planFinishingRestorePage(tx,page)).toMatchObject({processed:1,next:null,dispatchIds:[]});
      expect(await tx.executionDispatch.count()).toBe(before);
      const restored=await tx.generationFinishing.findUniqueOrThrow({where:{id:original.id}});
      expect(restored).toMatchObject({deploymentEpoch:fence.epoch,generation:original.generation+1,state:"due",claimToken:null,leaseExpiresAt:null,attempts:3,picks:original.picks,dueAt:original.dueAt,operationDeadlineAt:original.operationDeadlineAt,nextAttemptAt:original.nextAttemptAt,settings:original.settings});
      expect(await planFinishingRestorePage(tx,page)).toMatchObject({processed:0,dispatchIds:[]});
      const recovery=await planFinishingRecoveryPage(tx,page);expect(recovery.dispatchIds).toHaveLength(2);
      expect(await planFinishingRecoveryPage(tx,page)).toEqual(recovery);
      expect(await tx.generationFinishing.findUniqueOrThrow({where:{id:original.id}})).toEqual(restored);
      await expect(planFinishingRestorePage(tx,{...page,cutoff:new Date(page.cutoff.getTime()+1)})).rejects.toThrow("restore_page_proof_invalid");
      await tx.executionEpoch.update({where:{id:1},data:{admissionOpen:true}});
      await expect(planFinishingRestorePage(tx,page)).rejects.toThrow("restore_page_proof_invalid");
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await db.generationFinishing.findUniqueOrThrow({where:{id:original.id}})).toEqual(original);
  });
  test("generation settlement atomically freezes a database-clock deadline and one replayable wake", async () => {
    const { row, origin } = await fixture();
    expect(await db.executionDispatch.count({ where: { subjectId: row.id } })).toBe(0);
    await db.$transaction(tx => transitionGenerationFinishing(tx,origin.id,"completed",new Date(0)));
    const first = await db.generationFinishing.findUniqueOrThrow({ where: { id: row.id } });
    expect(first).toMatchObject({ state: "due", generation: 1, attempts: 0, claimToken: null, leaseExpiresAt: null });
    expect(first.dueAt!.getTime()).toBeGreaterThan(Date.now()-30_000);
    expect(first.operationDeadlineAt!.getTime()-first.dueAt!.getTime()).toBe(FINISHING_MAX_OPERATION_MS);
    const reference = await db.$transaction(tx => queueGenerationFinishing(tx,row.id));
    await db.$transaction(tx => transitionGenerationFinishing(tx,origin.id,"completed"));
    expect(await db.$transaction(tx => queueGenerationFinishing(tx,row.id))).toEqual(reference);
    expect(await db.executionDispatch.count({ where: { subjectId: row.id } })).toBe(1);
    expect((await db.generationFinishing.findUniqueOrThrow({ where: { id: row.id } })).operationDeadlineAt).toEqual(first.operationDeadlineAt);
    await expect(Promise.resolve(db.generationFinishing.update({ where: { id: row.id }, data: { operationDeadlineAt: new Date(first.operationDeadlineAt!.getTime()+1) } }))).rejects.toThrow("generation finishing input is immutable");
    await expect(Promise.resolve(db.generationFinishing.update({ where: { id: row.id }, data: { autopilotAuthority: { inventedGrant: crypto.randomUUID() } } }))).rejects.toThrow("generation finishing input is immutable");
  });
  test("rolled-back settlement creates neither a due job nor an orphan dispatch", async () => {
    const { row, origin } = await fixture();
    await expect(db.$transaction(async tx => { await transitionGenerationFinishing(tx,origin.id,"completed"); throw Error("injected_finishing_rollback"); })).rejects.toThrow("injected_finishing_rollback");
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "waiting", generation: 0, dueAt: null, operationDeadlineAt: null });
    expect(await db.executionDispatch.count({ where: { subjectId: row.id } })).toBe(0);
  });
  function driver(overrides: Partial<GenerationFinishingDependencies> = {}) {
    const unexpected = async (): Promise<never> => { throw Error("No clips must create no child work"); };
    return createGenerationFinishing({ prisma: db, register: async () => {}, requireActor: async () => ({ pricingTier: "business" }), canManagePublishing: async () => true,
      createExport: unexpected, retryExport: unexpected, writeCopy: unexpected, queueAccounts: async () => [], propose: unexpected,
      acceptUnderGrant: unexpected, sendReviewRound: unexpected, notify: unexpected, ...overrides });
  }
  async function due(settings?: Parameters<typeof fixture>[0]) {
    const value = await fixture(settings);
    await db.$transaction(tx => transitionGenerationFinishing(tx,value.origin.id,"completed"));
    return { ...value, reference: (await db.$transaction(tx => queueGenerationFinishing(tx,value.row.id)))! };
  }
  async function withClips(value: Awaited<ReturnType<typeof due>>) {
    await db.transcript.create({ data: { projectId: value.row.projectId, status: "completed", completedAt: new Date(), utterancesJson: [] } });
    const selected = await db.workflowRun.create({ data: { projectId: value.row.projectId, stage: "moment_detection", status: "completed", idempotencyKey: `${value.origin.idempotencyKey}__moment_detection` } });
    for (let index=0;index<2;index++) await db.clip.create({ data: { projectId: value.row.projectId, workflowRunId: selected.id, index, startSec: 0, endSec: 30,
      hookText: "Synthetic pick", reasoning: "Fixture", category: "hook", transcriptSlice: [], viralityScore: 80-index, hookStrengthScore: 80, emotionalIntensityScore: 80,
      pacingScore: 80, durationOptimalityScore: 80, tiktokScore: 80, youtubeScore: 80, instagramScore: 80, llmProvider: "fixture", llmModel: "fixture" } });
  }
  test("a command admits only one picked export and advances through exact continuation references", async () => {
    const value = await due(); await withClips(value); let exports=0, notified=0;
    const service = driver({ createExport: async (_scope, projectId, clipId, input, key) => {
      exports++;
      const row = await db.clipExport.create({ data: { workspaceId: value.row.workspaceId, projectId, clipId, editorRevision: input.expectedRevision,
        fingerprint: key, status: "ready", resolution: "720p", watermark: false } });
      return { export: { id: row.id, status: row.status }, reused: false };
    }, notify: async () => { notified++; } });
    await service.run(value.reference); expect(exports).toBe(1); expect(notified).toBe(0);
    const next = (await db.$transaction(tx => queueGenerationFinishing(tx,value.row.id)))!;
    expect(next.generation).toBeGreaterThan(value.reference.generation);
    expect((await service.run(value.reference)).kind).toBe("superseded"); expect(exports).toBe(1);
    await service.run(next); expect(exports).toBe(2); expect(notified).toBe(0);
    await service.run((await db.$transaction(tx => queueGenerationFinishing(tx,value.row.id)))!);
    expect(notified).toBe(1);
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: value.row.id } })).toMatchObject({ state: "ready", attempts: 0, claimToken: null, leaseExpiresAt: null });
  });
  test("child admission and late result publication reject a revoked finishing claim in their own transaction",async()=>{
    const value=await due();await withClips(value);let attempts=0;
    const service=driver({createExport:async(scope,projectId,clipId,input,key,authority)=>{
      attempts++;
      await db.$transaction(tx=>assertGenerationFinishingAuthority(tx,authority,{workspaceId:scope.workspaceId,projectId,actorUserId:scope.actorUserId,clipId}));
      await db.generationFinishing.update({where:{id:value.row.id},data:{state:"due",claimToken:null,leaseExpiresAt:null}});
      await db.$transaction(async tx=>{
        await assertGenerationFinishingAuthority(tx,authority,{workspaceId:scope.workspaceId,projectId,clipId});
        return tx.clipExport.create({data:{workspaceId:scope.workspaceId,projectId,clipId,editorRevision:input.expectedRevision,fingerprint:key,status:"ready",resolution:"720p",watermark:false}});
      });
      throw Error("revoked_child_must_not_commit");
    }});
    expect((await service.run(value.reference)).kind).toBe("superseded");
    expect(attempts).toBe(1);expect(await db.clipExport.count({where:{projectId:value.row.projectId}})).toBe(0);
    expect(await db.generationFinishing.findUniqueOrThrow({where:{id:value.row.id}})).toMatchObject({state:"due",attempts:0});
  });
  test("a role downgrade before child acceptance leaves no export or charged retry",async()=>{
    const value=await due();await withClips(value);
    const service=driver({createExport:async(scope,projectId,clipId,_input,_key,authority)=>{
      await db.workspaceMember.update({where:{workspaceId_userId:{workspaceId:scope.workspaceId,userId:scope.actorUserId}},data:{role:"viewer"}});
      await db.$transaction(tx=>assertGenerationFinishingAuthority(tx,authority,{...scope,projectId,clipId}));
      throw Error("downgraded_actor_must_not_commit");
    }});
    expect((await service.run(value.reference)).kind).toBe("superseded");
    expect(await db.clipExport.count({where:{projectId:value.row.projectId}})).toBe(0);
    expect(await db.generationFinishing.findUniqueOrThrow({where:{id:value.row.id}})).toMatchObject({attempts:0});
  });
  test("an export retried during final handoff parks its finishing instead of publishing a stale ready outcome",async()=>{
    const value=await due({topClips:1});await withClips(value);
    const service=driver({createExport:async(_scope,projectId,clipId,input,key)=>{
      const exported=await db.clipExport.create({data:{workspaceId:value.row.workspaceId,projectId,clipId,editorRevision:input.expectedRevision,fingerprint:key,status:"ready",resolution:"720p",watermark:false}});
      return{export:{id:exported.id,status:exported.status},reused:false};
    },notify:async()=>{await db.clipExport.updateMany({where:{projectId:value.row.projectId},data:{status:"queued"}});}});
    await service.run(value.reference);
    const next=(await db.$transaction(tx=>queueGenerationFinishing(tx,value.row.id)))!;
    expect((await service.run(next)).kind).toBe("wait");
    expect(await db.generationFinishing.findUniqueOrThrow({where:{id:value.row.id}})).toMatchObject({state:"exporting",finishedAt:null,claimToken:null,attempts:0});
  });
  test("an already-started copy request ends partial under its original key without a fresh paid retry",async()=>{
    const value=await due({topClips:1,copyPlatforms:["x"]});await withClips(value);let copies=0;
    const service=driver({createExport:async(_scope,projectId,clipId,input,key)=>{
      const row=await db.clipExport.create({data:{workspaceId:value.row.workspaceId,projectId,clipId,editorRevision:input.expectedRevision,fingerprint:key,status:"ready",resolution:"720p",watermark:false}});
      return{export:{id:row.id,status:row.status},reused:false};
    },writeCopy:async()=>{copies++;throw new AssistedSocialCopyError("assisted_copy_generation_in_progress");},notify:async()=>{}});
    await service.run(value.reference);
    await service.run((await db.$transaction(tx=>queueGenerationFinishing(tx,value.row.id)))!);
    const progress=await db.generationFinishing.findUniqueOrThrow({where:{id:value.row.id}});
    expect(progress.picks).toEqual([expect.objectContaining({copyError:"assisted_copy_generation_in_progress"})]);
    await service.run((await db.$transaction(tx=>queueGenerationFinishing(tx,value.row.id)))!);
    expect(copies).toBe(1);
    expect(await db.generationFinishing.findUniqueOrThrow({where:{id:value.row.id}})).toMatchObject({state:"partial",reason:"copy_failed",attempts:0});
  });
  test("an old exact receipt repairs its committed next wake after ACK loss without admitting another export", async () => {
    const value = await due(); await withClips(value); let exports=0, loseNext=true, nextRegistrations=0;
    const service = driver({ register: async ids => {
      const next = await db.executionDispatch.findMany({ where: { id: { in: [...ids] }, generation: { gt: value.reference.generation }, deadlineKind: null } });
      if (next.length) { nextRegistrations++; if (loseNext) { loseNext=false; throw Error("next_wake_ack_lost"); } }
    }, createExport: async (_scope, projectId, clipId, input, key) => {
      exports++;
      const row=await db.clipExport.create({ data: { workspaceId:value.row.workspaceId,projectId,clipId,editorRevision:input.expectedRevision,fingerprint:key,status:"ready",resolution:"720p",watermark:false } });
      return { export:{id:row.id,status:row.status},reused:false };
    }, notify: async () => {} });
    await service.run(value.reference);
    expect(exports).toBe(1); expect(nextRegistrations).toBe(1);
    const committed=await db.generationFinishing.findUniqueOrThrow({ where:{id:value.row.id} });
    expect(committed).toMatchObject({state:"due",generation:2,attempts:0,claimToken:null,leaseExpiresAt:null});
    expect((await service.run(value.reference)).kind).toBe("superseded");
    expect(nextRegistrations).toBe(2); expect(exports).toBe(1);
    expect(await db.generationFinishing.findUniqueOrThrow({ where:{id:value.row.id} })).toEqual(committed);
  });
  test("terminal exports wake only their parked finishing and a lost page ACK replays the exact obligation list",async()=>{
    const value=await due();await withClips(value);let exports=0,notified=0;
    const service=driver({createExport:async(_scope,projectId,clipId,input,key)=>{
      exports++;const row=await db.clipExport.create({data:{workspaceId:value.row.workspaceId,projectId,clipId,editorRevision:input.expectedRevision,fingerprint:key,status:"queued",resolution:"720p",watermark:false}});
      return{export:{id:row.id,status:row.status},reused:false};
    },notify:async()=>{notified++;}});
    let reference=value.reference;
    await service.run(reference);reference=(await db.$transaction(tx=>queueGenerationFinishing(tx,value.row.id)))!;
    await service.run(reference);reference=(await db.$transaction(tx=>queueGenerationFinishing(tx,value.row.id)))!;
    expect((await service.run(reference)).kind).toBe("wait");expect(exports).toBe(2);
    expect(await db.$transaction(tx=>queueGenerationFinishing(tx,value.row.id))).toEqual(reference);
    const included=await db.clipExport.findMany({where:{projectId:value.row.projectId},orderBy:{id:"asc"}});
    expect(await db.$transaction(tx=>appendFinishingExportWake(tx,included[0]!.id))).toBeNull();
    await db.clipExport.updateMany({where:{id:{in:included.map(row=>row.id)}},data:{status:"ready"}});
    const pageId=(await db.$transaction(tx=>appendFinishingExportWake(tx,included[0]!.id)))!;
    expect(await db.$transaction(tx=>appendFinishingExportWake(tx,included[0]!.id))).toBe(pageId);
    const page=(await readExecutionDispatch(db,pageId))!;let loseAck=true;const registrations:string[][]=[];
    const producer=createFinishingProducers({database:db,register:async ids=>{registrations.push([...ids]);if(loseAck){loseAck=false;throw Error("finishing_page_ack_lost");}}});
    await expect(producer.dispatch(page.reference)).rejects.toThrow("finishing_page_ack_lost");
    expect((await producer.dispatch(page.reference)).kind).toBe("complete");
    expect(registrations).toHaveLength(2);expect(registrations[1]).toEqual(registrations[0]);
    expect((await service.run(reference)).kind).toBe("complete");expect(exports).toBe(2);expect(notified).toBe(1);
  });
  test("export completion fans out in bounded pages without losing the final dependent",async()=>{
    const value=await due();await withClips(value);
    const clip=await db.clip.findFirstOrThrow({where:{projectId:value.row.projectId}});
    const exported=await db.clipExport.create({data:{workspaceId:value.row.workspaceId,projectId:value.row.projectId,clipId:clip.id,editorRevision:clip.editorRevision,fingerprint:crypto.randomUUID(),status:"ready",resolution:"720p",watermark:false}});
    const frozen=await db.generationFinishing.findUniqueOrThrow({where:{id:value.row.id}});
    const picks=[{clipId:clip.id,editorRevision:clip.editorRevision,exportId:exported.id}];
    await db.generationFinishing.update({where:{id:frozen.id},data:{state:"exporting",picks}});
    for(let index=0;index<64;index++){
      const origin=await db.workflowRun.create({data:{projectId:frozen.projectId,stage:"stt",status:"completed",idempotencyKey:crypto.randomUUID()}});
      const row=await db.generationFinishing.create({data:{workspaceId:frozen.workspaceId,projectId:frozen.projectId,originRunId:origin.id,actorUserId:frozen.actorUserId,settings:frozen.settings,
        deploymentEpoch:frozen.deploymentEpoch,generation:1,state:"exporting",dueAt:frozen.dueAt,operationDeadlineAt:frozen.operationDeadlineAt,picks}});finishings.push(row.id);
    }
    let pageId=(await db.$transaction(tx=>appendFinishingExportWake(tx,exported.id)))!,pages=0;
    const producer=createFinishingProducers({database:db,register:async ids=>{expect(ids.length).toBeLessThanOrEqual(65);}});
    while(pageId){
      const reference=(await readExecutionDispatch(db,pageId))!.reference;
      const result=await producer.dispatch(reference);pages++;expect(pages).toBeLessThanOrEqual(3);
      const next=await db.executionDispatch.findFirst({where:{id:{in:result.dispatchIds},kind:"maintenance",subjectKind:"maintenance",subjectId:{startsWith:`gf1.e.${exported.id}.`}}});
      pageId=next?.id??"";
    }
    expect(pages).toBe(3);
    expect(await db.executionDispatch.count({where:{subjectKind:"generation_finishing",subjectId:{in:finishings},wakeKind:{startsWith:"ex_"}}})).toBe(65);
  });
  test("one exact driver confirms its watchdog before work and a concurrent duplicate waits", async () => {
    const first = await due(), unrelated = await due(); let calls = 0, registrations = 0;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered=resolve; }), barrier = new Promise<void>(resolve => { release=resolve; });
    const service = driver({ register: async ids => { expect(ids.length).toBeGreaterThan(0); registrations++; }, requireActor: async () => {
      calls++; expect(registrations).toBeGreaterThan(0); entered(); await barrier; return { pricingTier: "business" }; } });
    const pending = service.run(first.reference); await started;
    expect((await service.run(first.reference)).kind).toBe("wait"); expect(calls).toBe(1);
    release(); expect((await pending).kind).toBe("complete");
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: first.row.id } })).toMatchObject({ state: "skipped", reason: "no_clips", claimToken: null, leaseExpiresAt: null, attempts: 0 });
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: unrelated.row.id } })).toMatchObject({ state: "due", attempts: 0 });
    expect((await service.run(first.reference)).kind).toBe("complete"); expect(calls).toBe(1);
  });
  test("an unconfirmed watchdog leaves the exact job uncharged and starts no child action", async () => {
    const value = await due(); let actors=0;
    const before = await db.generationFinishing.findUniqueOrThrow({ where: { id: value.row.id } });
    await expect(driver({ register: async () => { throw Error("watchdog_unconfirmed"); }, requireActor: async () => { actors++; return { pricingTier:"business" }; } }).run(value.reference)).rejects.toThrow("watchdog_unconfirmed");
    expect(actors).toBe(0);
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: value.row.id } })).toMatchObject({ state: "due", attempts: 0, generation: before.generation, operationDeadlineAt: before.operationDeadlineAt, claimToken: null, leaseExpiresAt: null });
  });
});
