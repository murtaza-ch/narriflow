import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { withServiceEnvironment } from "./runtime-environment";
import { AutopilotService } from "./autopilot.service";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { projectService } from "./project.service";
import { acceptedRecipe, contentPackSchema } from "@narriflow/validators";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { AutopilotExecution, queueAutopilotRule } from "./autopilot-execution";
import { OutboundProbeService } from "./outbound-probe";
import { createExecutorControl } from "./executor-control";
import { ExecutionDispatchPendingError, readExecutionDispatch } from "./execution-dispatch";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Exact Autopilot source coordination", () => {
  let db: PrismaClient;
  const context = createDatabaseTestContext();
  const scoped = <T>(run: () => Promise<T>) => () => withServiceEnvironment({ ...process.env, MEDIA_FETCH_TOOLCHAIN_FINGERPRINT: "d".repeat(64) }, context.bind(run));
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6 }, { schema }), transactionOptions: { timeout: 30_000 } });
    context.client = db;
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture(options: { failures?: number; dueAt?: Date } = {}) {
    const user = await db.user.create({ data: { clerkId: `autopilot-execution:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Targeted Autopilot", ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    const recipe = await db.recipe.create({ data: { workspaceId: workspace.id, name: "Original source", contentPack: contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "test" }), createdByUserId: user.id } });
    const rule = await db.autopilotRule.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, name: "Original source", rssUrl: "https://feeds.example.test/original.xml", recipeId: recipe.id, initializedAt: new Date(), lastSeenEpisodeId: "prior", nextRunAt: options.dueAt ?? new Date(Date.now() - 1000), consecutiveFailures: options.failures ?? 0 } });
    return { rule, workspace, user, recipe };
  }
  async function sealResult(probe: OutboundProbeService, ruleId: string) {
    const rule = await db.autopilotRule.findUniqueOrThrow({ where: { id: ruleId } });
    const parent = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectKind: "outbound_probe", subjectId: rule.executionProbeId!, deadlineKind: null } });
    const planned = await probe.prepareExecution((await readExecutionDispatch(db,parent.id))!.reference);
    if (planned.kind !== "waiting") throw Error("Probe must be admitted");
    const { reference, attemptToken } = planned.deadline, owner = crypto.randomUUID(), fence = { reference,attemptToken,owner };
    const control = createExecutorControl({ database: db, subjectKind: "outbound_probe", domain: probe, deliverWakes: async () => {}, artifacts: { prepare: async (_assigned,artifact)=>artifact, head: async ()=>({ etag: '"sealed"',contentType:"application/json",byteLength:512n,sha256:"a".repeat(64) }) } });
    const verified = () => ({ requestHash:crypto.randomUUID().replaceAll("-","").repeat(2), metadata:{ version:1 as const,keyId:"source-gate",audience:"executor-control" as const,method:"POST" as const,canonicalTarget:"/api/execution/command",bodySha256:"0".repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId:crypto.randomUUID(),signature:"0".repeat(64) } });
    await control.execute({ command:{ action:"acquire",reference,attemptToken,owner,leaseSeconds:120 },verifiedRequest:verified() });
    await control.execute({ command:{ action:"process-start",fence },verifiedRequest:verified() });
    const artifact = await db.executionArtifact.create({ data:{ attemptToken,owner,role:"outbound_receipt",bindingHash:reference.inputHash,storageKey:`execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/feed.json`,contentType:"application/json",maxBytes:4194304n,grantExpiresAt:new Date(Date.now()+60000) } });
    await control.execute({ command:{ action:"commit-artifact",fence,artifact:{artifactId:artifact.id,role:"outbound_receipt",bindingHash:reference.inputHash,contentType:"application/json",byteLength:512,sha256:"a".repeat(64),etag:'"sealed"'} },verifiedRequest:verified() });
    return (await db.$transaction(tx=>queueAutopilotRule(tx,ruleId)))!;
  }
  test("one exact cycle atomically admits its native probe and waits without a renewable parent lease", async () => {
    const f = await fixture(), registered: string[][] = [];
    const register = async (ids: readonly string[]) => { registered.push([...ids]); };
    const probe = new OutboundProbeService(db, { register, readResult: async () => { throw Error("Pending probe must not read an object"); } });
    const driver = new AutopilotExecution({ database: db, probe, register, importEpisode: async () => { throw Error("Pending probe must not admit intake"); } });
    const reference = (await db.$transaction(tx => queueAutopilotRule(tx, f.rule.id)))!;
    expect((await driver.run(reference)).kind).toBe("complete");
    const accepted = await db.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } });
    expect(accepted.executionCycleId).not.toBeNull();
    expect(accepted.executionProbeId).not.toBeNull();
    expect(accepted.executionInput).toMatchObject({ recipe: { id: f.recipe.id, revision: 1 }, source: { recipeContentRevision: 1, authority: { publish: [], review: null } } });
    expect(accepted).toMatchObject({ claimToken: null, leaseExpiresAt: null });
    expect(accepted.operationDeadlineAt!.getTime() - accepted.executionDueAt!.getTime()).toBe(3600_000);
    expect(await db.outboundProbe.count({ where: { id: accepted.executionProbeId! } })).toBe(1);
    const pending = (await db.$transaction(tx => queueAutopilotRule(tx, f.rule.id)))!;
    expect(await driver.run(pending)).toEqual({ kind: "wait", dueAt: accepted.operationDeadlineAt });
    expect((await driver.run(reference)).kind).toBe("superseded");
    expect(await db.outboundProbe.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(registered.flat().length).toBeGreaterThan(1);
  });
  test("a keyed rule acceptance repairs its original targeted wake after a lost scheduler response", scoped(async () => {
    const f = await fixture(), deliveries: string[][] = [];
    const service = new AutopilotService({ fetchFeed: async () => ({ title:"Synthetic",episodes:[],etag:null,lastModified:null,finalUrl:"https://feeds.example.test/accepted",notModified:false }) });
    const scope = {workspaceId:f.workspace.id,actorUserId:f.user.id}, key = crypto.randomUUID();
    const invoke = () => withExecutionDispatches(()=>service.acceptRule(scope,{name:"Accepted targeted rule",rssUrl:"https://feeds.example.test/accepted",recipeId:f.recipe.id},{clientIdempotencyKey:key}),{database:db,deliver:async ids=>{deliveries.push([...ids]);if(deliveries.length===1)throw Error("lost_rule_wake_ack");}});
    await expect(invoke()).rejects.toThrow("lost_rule_wake_ack");
    const replay = await invoke();
    expect(replay.replayed).toBe(true);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(await db.executionDispatch.count({where:{kind:"operation_driver",subjectKind:"autopilot_rule",subjectId:replay.rule.id}})).toBe(1);
    expect(await db.autopilotRule.count({where:{workspaceId:f.workspace.id}})).toBe(2);
  }));
  test("run-now creates one fresh dispatch identity and exact receipt replay cannot move the schedule again",scoped(async()=>{
    const f=await fixture(),scope={workspaceId:f.workspace.id,actorUserId:f.user.id},key=crypto.randomUUID(),service=new AutopilotService();
    const before=(await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!;
    const first=await service.acceptRunNow(scope,f.rule.id,{clientIdempotencyKey:key});
    expect(first.replayed).toBe(false);
    const accepted=await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}});
    expect(accepted.generation).toBe(f.rule.generation+1);
    const after=(await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!;
    expect(after.dispatchId).not.toBe(before.dispatchId);
    expect((await service.acceptRunNow(scope,f.rule.id,{clientIdempotencyKey:key})).replayed).toBe(true);
    expect(await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}})).toMatchObject({generation:accepted.generation,nextRunAt:accepted.nextRunAt});
    expect((await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!.dispatchId).toBe(after.dispatchId);
  }));
  test("an admitted episode stays at the same cursor until its ingest registration is confirmed", scoped(async () => {
    const f = await fixture(), confirmations: string[][] = []; let lose = true;
    const snapshot = { title:"Synthetic",episodes:["first","prior"].map(id=>({id,title:id,enclosureUrl:`https://cdn.example.test/${id}.mp3`,durationSeconds:60})),etag:null,lastModified:null,finalUrl:f.rule.rssUrl!,notModified:false };
    const probe = new OutboundProbeService(db,{register:async()=>{},readResult:async()=>snapshot});
    const driver: AutopilotExecution = new AutopilotExecution({ database:db,probe,register:async()=>{},importEpisode:input=>projectService.importResolvedRssEpisodes(input.scope,{rssUrl:input.finalUrl,episodes:[input.episode],brandProfileId:input.plan.recipe.brandProfileId},{autopilotSource:input.plan.source,generationContext:{contentPack:input.plan.recipe.contentPack,languageCode:input.plan.recipe.languageCode,finishing:input.plan.recipe.finishing,recipe:acceptedRecipe(input.plan.recipe)},beforeAutopilotAdmit:tx=>driver.assertIntakeWithinTransaction(tx,input),confirmIngest:async ids=>{confirmations.push([...ids]);if(lose){lose=false;throw new ExecutionDispatchPendingError(new Date(Date.now()+1000));}}}) });
    await driver.run((await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!);
    await driver.run(await sealResult(probe,f.rule.id));
    const episode = (await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!;
    await expect(driver.run(episode)).rejects.toBeInstanceOf(ExecutionDispatchPendingError);
    const interrupted = await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}});
    expect(interrupted).toMatchObject({status:"running",executionCursor:0,generation:episode.generation,consecutiveFailures:0,claimToken:null,leaseExpiresAt:null});
    expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    await driver.run(episode);
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toEqual(confirmations[0]);
    expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    expect(await db.processingUsageReservation.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    expect(await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}})).toMatchObject({status:"active",executionCycleId:null,consecutiveFailures:0,lastSeenEpisodeId:"first"});
  }));
  test("the accepted cycle's source plan and deadline are immutable, and an explicit source edit revokes it", async () => {
    const f = await fixture();
    const probe = new OutboundProbeService(db,{register:async()=>{},readResult:async()=>{throw Error("pending");}});
    const driver = new AutopilotExecution({database:db,probe,register:async()=>{},importEpisode:async()=>{throw Error("pending");}});
    await driver.run((await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!);
    const row = await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}});
    await expect(Promise.resolve(db.autopilotRule.update({where:{id:row.id},data:{operationDeadlineAt:new Date(row.operationDeadlineAt!.getTime()+60_000)}}))).rejects.toThrow("Autopilot cycle input is immutable");
    await expect(Promise.resolve(db.autopilotRule.update({where:{id:row.id},data:{executionInput:{changed:true}}}))).rejects.toThrow("Autopilot cycle input is immutable");
    const edited = await db.autopilotRule.update({where:{id:row.id},data:{titlePrefix:"Explicit replacement"}});
    expect(edited).toMatchObject({status:"active",generation:row.generation+1,executionCycleId:null,executionProbeId:null,claimToken:null,leaseExpiresAt:null});
    expect(await db.outboundProbe.count({where:{id:row.executionProbeId!}})).toBe(1);
  });
  test("replaying the old cycle receipt repairs its child probe and next-generation watches after registration loss", async () => {
    const f = await fixture(), delivered: string[][] = []; let lose = true;
    const probe = new OutboundProbeService(db,{register:async()=>{},readResult:async()=>{throw Error("pending");}});
    const driver = new AutopilotExecution({database:db,probe,register:async ids=>{delivered.push([...ids]);if(lose){lose=false;throw Error("lost_cycle_ack");}},importEpisode:async()=>{throw Error("pending");}});
    const original = (await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!;
    await expect(driver.run(original)).rejects.toThrow("lost_cycle_ack");
    const accepted = await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}});
    const child = await db.executionDispatch.findFirstOrThrow({where:{kind:"operation_driver",subjectKind:"outbound_probe",subjectId:accepted.executionProbeId!,deadlineKind:null}});
    expect((await driver.run(original)).kind).toBe("superseded");
    expect(delivered[1]).toContain(child.id);
    expect(delivered[1]).toEqual(expect.arrayContaining(delivered[0]!));
    expect(await db.outboundProbe.count({where:{workspaceId:f.workspace.id}})).toBe(1);
  });
  test("an unavailable sealed feed releases its short claim and schedules one bounded cycle retry", async () => {
    const f = await fixture();
    const probe = new OutboundProbeService(db,{ register:async()=>{},readResult:async()=>{ throw Error("temporary object failure with secret source URL"); } });
    const driver = new AutopilotExecution({ database:db,probe,register:async()=>{},importEpisode:async()=>{throw Error("Unavailable feed cannot reserve credits");} });
    await driver.run((await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!);
    const reference = await sealResult(probe,f.rule.id);
    expect(await driver.run(reference)).toEqual({kind:"complete"});
    const next = await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}});
    expect(next).toMatchObject({status:"active",consecutiveFailures:1,claimToken:null,leaseExpiresAt:null,executionCycleId:null,lastError:"autopilot_cycle_failed"});
    expect(next.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect((await driver.run(reference)).kind).toBe("superseded");
    expect((await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}})).consecutiveFailures).toBe(1);
  });
  test("a missing acting member or uncovered plan pauses before native probe and preserves failure history", async () => {
    for (const reason of ["acting_member","plan"] as const) {
      const f = await fixture({ failures: 3 });
      if (reason === "acting_member") await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.user.id } } });
      else await db.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "free" } });
      const probe = new OutboundProbeService(db, { register: async () => {}, readResult: async () => { throw Error("Paused rule cannot read an object"); } });
      const driver = new AutopilotExecution({ database: db, probe, register: async () => {}, importEpisode: async () => { throw Error("Paused rule cannot admit intake"); } });
      expect(await driver.run((await db.$transaction(tx=>queueAutopilotRule(tx,f.rule.id)))!)).toEqual({ kind: "complete" });
      expect(await db.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).toMatchObject({ status: "paused", pauseKind: reason, consecutiveFailures: 3, claimToken: null, executionCycleId: null });
      expect(await db.outboundProbe.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    }
  });
  test("a delayed cycle expires once before probe or intake and keeps the existing eight-failure policy", async () => {
    for (const failures of [0,7]) {
      const f = await fixture({ failures, dueAt: new Date(Date.now()-7200_000) }), registered: string[] = [];
      const probe = new OutboundProbeService(db, { register: async () => {}, readResult: async () => { throw Error("Expired cycle cannot read an object"); } });
      const driver = new AutopilotExecution({ database: db, probe, register: async ids => { registered.push(...ids); }, importEpisode: async () => { throw Error("Expired cycle cannot admit intake"); } });
      const reference = (await db.$transaction(tx => queueAutopilotRule(tx,f.rule.id)))!;
      expect(await driver.run(reference)).toEqual({ kind: "complete" });
      const ended = await db.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } });
      expect(ended).toMatchObject({ status: failures === 7 ? "failed" : "active", consecutiveFailures: failures+1, claimToken: null, leaseExpiresAt: null, executionCycleId: null });
      expect(ended.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(await db.outboundProbe.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect((await driver.run(reference)).kind).toBe("superseded");
      expect((await db.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } })).consecutiveFailures).toBe(failures+1);
    }
  });
  test("the native probe commit confirms one exact rule wake and repairs it after acknowledgement loss", scoped(async () => {
    const f = await fixture(), delivered: string[] = []; let reads = 0; const intakes: string[] = [];
    const snapshot = { title: "Original feed", episodes: ["first", "second", "prior"].map(id => ({ id, title: id, enclosureUrl: `https://cdn.example.test/${id}.mp3`, durationSeconds: 60 })), etag: '"feed-original"', lastModified: null, finalUrl: "https://feeds.example.test/original.xml", notModified: false };
    const probe = new OutboundProbeService(db, { register: async () => {}, readResult: async () => { reads++; return snapshot; } });
    const driver = new AutopilotExecution({ database: db, probe, register: async () => {}, importEpisode: async input => {
      const result = await projectService.importResolvedRssEpisodes(input.scope, { rssUrl: input.finalUrl, episodes: [input.episode], titlePrefix: input.plan.titlePrefix ?? undefined, brandProfileId: input.plan.recipe.brandProfileId }, {
        autopilotSource: input.plan.source, generationContext: { contentPack: input.plan.recipe.contentPack, languageCode: input.plan.recipe.languageCode, finishing: input.plan.recipe.finishing, recipe: acceptedRecipe(input.plan.recipe) },
        beforeAutopilotAdmit: tx => driver.assertIntakeWithinTransaction(tx,input),
      });
      intakes.push(input.episode.id); return result;
    } });
    await driver.run((await db.$transaction(tx => queueAutopilotRule(tx, f.rule.id)))!);
    const rule = await db.autopilotRule.findUniqueOrThrow({ where: { id: f.rule.id } });
    const probeDispatch = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectKind: "outbound_probe", subjectId: rule.executionProbeId!, deadlineKind: null } });
    const planned = await probe.prepareExecution((await readExecutionDispatch(db, probeDispatch.id))!.reference);
    if (planned.kind !== "waiting") throw Error("Native probe must be pending");
    const { reference, attemptToken } = planned.deadline, owner = crypto.randomUUID(), fence = { reference, attemptToken, owner };
    let loseCommitAck = false;
    const control = createExecutorControl({ database: db, subjectKind: "outbound_probe", domain: probe, deliverWakes: async ids => { delivered.push(...ids); if (loseCommitAck) { loseCommitAck = false; throw Error("lost_probe_result_wake_ack"); } }, artifacts: { prepare: async (_assigned, artifact) => artifact, head: async () => ({ etag: '"sealed"', contentType: "application/json", byteLength: 512n, sha256: "a".repeat(64) }) } });
    const verified = () => ({ requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "source-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now()/1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
    await control.execute({ command: { action: "acquire", reference, attemptToken, owner, leaseSeconds: 120 }, verifiedRequest: verified() });
    await control.execute({ command: { action: "process-start", fence }, verifiedRequest: verified() });
    const artifact = await db.executionArtifact.create({ data: { attemptToken, owner, role: "outbound_receipt", bindingHash: reference.inputHash, storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/feed.json`, contentType: "application/json", maxBytes: 4194304n, grantExpiresAt: new Date(Date.now()+60000) } });
    const command = { action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "outbound_receipt", bindingHash: reference.inputHash, contentType: "application/json", byteLength: 512, sha256: "a".repeat(64), etag: '"sealed"' } }, request = verified();
    loseCommitAck = true;
    await expect(control.execute({ command, verifiedRequest: request })).rejects.toThrow("lost_probe_result_wake_ack");
    const wake = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "autopilot_rule", subjectId: rule.id, wakeKind: { startsWith: "rss." } } });
    expect(delivered).toContain(wake.id);
    await control.execute({ command, verifiedRequest: request });
    expect(delivered.filter(id => id === wake.id)).toHaveLength(2);
    expect(await db.executionDispatch.count({ where: { subjectKind: "autopilot_rule", subjectId: rule.id, wakeKind: { startsWith: "rss." } } })).toBe(1);
    expect(reads).toBe(0);
    expect((await driver.run((await readExecutionDispatch(db, wake.id))!.reference)).kind).toBe("complete");
    const selected = await db.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(selected.executionSelection).toMatchObject({ indices: [0,1], shouldAdvanceCursor: true, deferred: false });
    expect((selected.executionSelection as { episodeHashes: string[] }).episodeHashes).toHaveLength(2);
    expect(selected).toMatchObject({ executionCursor: 0, claimToken: null, leaseExpiresAt: null });
    expect((await driver.run((await readExecutionDispatch(db, wake.id))!.reference)).kind).toBe("superseded");
    expect(reads).toBe(1);
    expect(intakes).toEqual([]);
    const firstEpisode = (await db.$transaction(tx=>queueAutopilotRule(tx,rule.id)))!;
    expect((await driver.run(firstEpisode)).kind).toBe("complete");
    expect(intakes).toEqual(["first"]);
    expect(await db.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ executionCursor: 1, claimToken: null, leaseExpiresAt: null, executionDueAt: rule.executionDueAt, operationDeadlineAt: rule.operationDeadlineAt });
    await driver.run(firstEpisode); expect(intakes).toEqual(["first"]);
    expect((await driver.run((await db.$transaction(tx=>queueAutopilotRule(tx,rule.id)))!)).kind).toBe("complete");
    expect(intakes).toEqual(["first","second"]);
    const ended = await db.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(ended).toMatchObject({ status: "active", executionCycleId: null, executionProbeId: null, claimToken: null, leaseExpiresAt: null, lastSeenEpisodeId: "first", etag: '"feed-original"', consecutiveFailures: 0 });
    expect(ended.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.project.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    expect(await db.processingUsageReservation.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    expect(await db.executionDispatch.count({ where: { kind: "import_pipeline", subjectId: { in: (await db.ingestJob.findMany({ where: { project: { workspaceId: f.workspace.id } }, select: { id: true } })).map(row=>row.id) } } })).toBe(2);
  }));
});
