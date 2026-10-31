import { createHmac } from "node:crypto";
import { ZoomService } from "./zoom.service";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { withServiceEnvironment } from "./runtime-environment";
import { projectService } from "./project.service";
import { ExecutionDispatchPendingError } from "./execution-dispatch";
import { contentPackSchema, finishingSettingsSchema } from "@narriflow/validators";
import { ruleFingerprint } from "./standing-grant";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ZoomNotificationExecution, queueZoomNotification } from "./zoom-execution";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Targeted Zoom notification coordination", () => {
  let db: PrismaClient;
  const context=createDatabaseTestContext();
  const scoped=<T>(run:()=>Promise<T>)=>()=>withServiceEnvironment({...process.env,MEDIA_FETCH_TOOLCHAIN_FINGERPRINT:"d".repeat(64)},context.bind(run));
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url,schema);
    db = new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema})});
    context.client=db;
  });
  afterAll(async()=>{await db?.$disconnect();});
  async function fixture() {
    const user=await db.user.create({data:{clerkId:`zoom-target:${crypto.randomUUID()}`}});
    const workspace=await db.workspace.create({data:{name:"Targeted Zoom",ownerUserId:user.id,pricingTier:"business",members:{create:{userId:user.id,role:"owner"}}}});
    const account=await db.socialAccount.create({data:{workspaceId:workspace.id,userId:user.id,platform:"youtube_shorts",providerAccountId:crypto.randomUUID(),displayName:"Synthetic",accessTokenEncrypted:"unused",scopes:[]}});
    const recipe=await db.recipe.create({data:{workspaceId:workspace.id,createdByUserId:user.id,name:"Original Zoom source",contentPack:contentPackSchema.parse({outputTypes:["short_clip"],clipCountTarget:3,clipDurationSecTarget:45,platformPlaybookVersion:"test"}),finishing:finishingSettingsSchema.parse({topClips:1,delivery:"propose_to_queue",queueAccountIds:[account.id]})}});
    const connection=await db.zoomConnection.create({data:{workspaceId:workspace.id,userId:user.id,zoomAccountId:crypto.randomUUID(),zoomUserId:"synthetic-host",displayName:"Synthetic",accessTokenEncrypted:"unused",refreshTokenEncrypted:"unused",scopes:[]}});
    const rule=await db.autopilotRule.create({data:{workspaceId:workspace.id,createdByUserId:user.id,sourceKind:"zoom",zoomConnectionId:connection.id,recipeId:recipe.id,name:"Original Zoom",titlePrefix:"Original"}});
    const fingerprint=(await ruleFingerprint(db,rule.id))!;
    const grant=await db.standingGrant.create({data:{workspaceId:workspace.id,autopilotRuleId:rule.id,kind:"publish",socialAccountId:account.id,ruleFingerprint:fingerprint,dailyCap:3,weeklyCap:10,expiresAt:new Date(Date.now()+86400_000),grantedByUserId:user.id}});
    const createdAt=new Date();
    const job=await db.zoomWebhookJob.create({data:{eventKey:crypto.randomUUID(),payload:{event:"recording.completed",eventTs:createdAt.getTime(),accountId:connection.zoomAccountId,hostId:connection.zoomUserId,meetingUuid:"meeting-one",recordingId:"recording-one",topic:"Synthetic",durationSeconds:60},createdAt,operationDeadlineAt:new Date(createdAt.getTime()+30*86400_000)}});
    return {user,workspace,recipe,connection,rule,grant,job};
  }
  test("one command freezes one matching Rule's original source authority before a later intake command", async()=>{
    const f=await fixture(),intakes:unknown[]=[];
    const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async input=>{intakes.push(input);return {count:1};},revokeConnection:async()=>{throw Error("not a deauthorization");}});
    const first=(await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!;
    expect(await driver.run(first)).toEqual({kind:"complete"});
    const frozen=await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}});
    expect(frozen).toMatchObject({claimToken:null,leaseExpiresAt:null,attempts:0,ruleCursor:null,operationDeadlineAt:f.job.operationDeadlineAt});
    expect(frozen.executionTarget).toMatchObject({kind:"recording",plan:{source:{ruleId:f.rule.id,authority:{publish:[{grant:{id:f.grant.id,revision:1}}]}}}});
    expect(intakes).toEqual([]);
    await db.standingGrant.update({where:{id:f.grant.id},data:{revision:2}});
    await db.autopilotRule.update({where:{id:f.rule.id},data:{generation:{increment:1}}});
    expect((await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).executionTarget).toEqual(frozen.executionTarget);
    expect(await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!)).toEqual({kind:"complete"});
    expect(intakes).toHaveLength(1);
    expect(intakes[0]).toMatchObject({target:{plan:{source:{authority:{publish:[{grant:{id:f.grant.id,revision:1}}]}}}}});
    expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).toMatchObject({status:"queued",ruleCursor:f.rule.id,attempts:1,claimToken:null,leaseExpiresAt:null,executionTarget:null,operationDeadlineAt:f.job.operationDeadlineAt});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
    expect((await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).status).toBe("completed");
    expect(intakes).toHaveLength(1);
  });
  test("a paused Brand Profile target parks without a short lease or retry polling",async()=>{
    const f=await fixture();let calls=0;
    const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{calls++;return {count:1};},revokeConnection:async()=>{}});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
    await db.autopilotRule.update({where:{id:f.rule.id},data:{status:"paused",pauseKind:"brand_profile"}});
    const parked=await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}}),reference=(await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!;
    expect(await driver.run(reference)).toEqual({kind:"wait",dueAt:f.job.operationDeadlineAt});
    expect(await driver.run(reference)).toEqual({kind:"wait",dueAt:f.job.operationDeadlineAt});
    expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).toMatchObject({generation:parked.generation,availableAt:parked.availableAt,executionTarget:parked.executionTarget,attempts:0,claimToken:null,leaseExpiresAt:null});
    expect(calls).toBe(0);
  });
  test("changed Recipe, acting scope or connection supersedes the frozen target without re-inferring source settings",async()=>{
    for(const change of ["recipe","scope","connection"] as const){
      const f=await fixture();let calls=0;
      const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{calls++;return {count:1};},revokeConnection:async()=>{}});
      await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
      if(change==="recipe")await db.recipe.update({where:{id:f.recipe.id},data:{revision:2,contentRevision:2}});
      if(change==="scope"){
        const other=await db.user.create({data:{clerkId:`zoom-replacement:${crypto.randomUUID()}`}});await db.workspaceMember.create({data:{workspaceId:f.workspace.id,userId:other.id,role:"owner"}});
        await db.autopilotRule.update({where:{id:f.rule.id},data:{createdByUserId:other.id}});
      }
      if(change==="connection"){
        const other=await db.zoomConnection.create({data:{workspaceId:f.workspace.id,userId:f.user.id,zoomAccountId:crypto.randomUUID(),zoomUserId:"other-host",displayName:"Other",accessTokenEncrypted:"unused",refreshTokenEncrypted:"unused",scopes:[]}});
        await db.autopilotRule.update({where:{id:f.rule.id},data:{zoomConnectionId:other.id}});
      }
      expect(await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!)).toEqual({kind:"complete"});
      expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).toMatchObject({ruleCursor:f.rule.id,skippedTargets:1,executionTarget:null,operationDeadlineAt:f.job.operationDeadlineAt});
      expect(calls).toBe(0);expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(0);
    }
  });
  test("SQL keeps the original notification deadline and full frozen target immutable",async()=>{
    const f=await fixture();
    const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>({count:1}),revokeConnection:async()=>{}});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
    const row=await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}});
    await expect(Promise.resolve(db.zoomWebhookJob.update({where:{id:row.id},data:{operationDeadlineAt:new Date(row.operationDeadlineAt.getTime()+1000)}}))).rejects.toThrow("Zoom notification input is immutable");
    await expect(Promise.resolve(db.zoomWebhookJob.update({where:{id:row.id},data:{executionTarget:{...(row.executionTarget as Record<string,unknown>),titlePrefix:"Widened intent"} as never}}))).rejects.toThrow("Zoom notification target is immutable");
  });
  test("Zoom intake confirms one existing ingest before advancing after a lost scheduler acknowledgement",scoped(async()=>{
    const f=await fixture(),confirmed:string[][]=[];let lose=true;
    const driver:ZoomNotificationExecution=new ZoomNotificationExecution({database:db,register:async()=>{},revokeConnection:async()=>{},importRecording:input=>projectService.importZoomRecording(input.target.scope,{source:input.target.plan.source,connectionId:input.target.connectionId,notification:input.notification,titlePrefix:input.target.titlePrefix,recipe:input.target.plan.recipe,beforeAutopilotAdmit:tx=>driver.assertIntakeWithinTransaction(tx,input),confirmIngest:async ids=>{confirmed.push([...ids]);if(lose){lose=false;throw new ExecutionDispatchPendingError(new Date(Date.now()+1000));}}})});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
    const reference=(await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!;
    await expect(driver.run(reference)).rejects.toBeInstanceOf(ExecutionDispatchPendingError);
    expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).toMatchObject({status:"running",generation:reference.generation,ruleCursor:null,claimToken:null,leaseExpiresAt:null});
    expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    expect(await driver.run(reference)).toEqual({kind:"complete"});
    expect(confirmed).toHaveLength(2);expect(confirmed[1]).toEqual(confirmed[0]);
    expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    expect(await db.processingUsageReservation.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).toMatchObject({status:"queued",ruleCursor:f.rule.id,executionTarget:null,claimToken:null,leaseExpiresAt:null,operationDeadlineAt:f.job.operationDeadlineAt});
  }));
  test("a verified webhook confirms its targeted obligation and repairs the same event after scheduler loss",scoped(async()=>{
    const f=await fixture(),ids:string[][]=[];
    const config={clientId:"synthetic",clientSecret:"synthetic",webhookSecret:"synthetic-webhook-secret",encryptionKey:"synthetic-encryption-key"};
    const body={event:"recording.completed",event_id:crypto.randomUUID(),event_ts:Date.now(),download_token:"must-never-persist",payload:{account_id:f.connection.zoomAccountId,object:{uuid:crypto.randomUUID(),host_id:f.connection.zoomUserId,topic:"Synthetic",duration:1,recording_files:[{id:"webhook-recording",status:"completed",file_type:"MP4",recording_type:"shared_screen_with_speaker_view",download_url:"https://zoom.us/private?access_token=must-never-persist"}]}}};
    const rawBody=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000)),signature=`v0=${createHmac("sha256",config.webhookSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    const service=new ZoomService({config:()=>config,register:async current=>{ids.push([...current]);if(ids.length===1)throw new ExecutionDispatchPendingError(new Date(Date.now()+1000));}});
    await expect(service.acceptWebhook({rawBody,timestamp,signature})).rejects.toBeInstanceOf(ExecutionDispatchPendingError);
    expect(await service.acceptWebhook({rawBody,timestamp,signature})).toEqual({accepted:true});
    const jobs=await db.zoomWebhookJob.findMany({where:{payload:{path:["meetingUuid"],equals:body.payload.object.uuid}}});
    expect(jobs).toHaveLength(1);
    expect(ids).toHaveLength(2);expect(ids[1]).toEqual(ids[0]);
    expect(jobs[0]!.operationDeadlineAt!.getTime()-jobs[0]!.createdAt.getTime()).toBe(30*86400_000);
    expect(JSON.stringify(jobs[0]!.payload)).not.toContain("must-never-persist");
  }));
  test("a verified deauthorization processes one frozen connection per command without recording intake",async()=>{
    const f=await fixture(),revoked:string[]=[];
    const createdAt=new Date();
    const job=await db.zoomWebhookJob.create({data:{eventKey:crypto.randomUUID(),payload:{event:"app_deauthorized",eventTs:createdAt.getTime(),accountId:f.connection.zoomAccountId,userId:f.connection.zoomUserId},createdAt,operationDeadlineAt:new Date(createdAt.getTime()+30*86400_000)}});
    const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{throw Error("Deauthorization cannot import");},revokeConnection:async(id)=>{revoked.push(id);}});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,job.id)))!);
    expect(revoked).toEqual([]);
    expect((await db.zoomWebhookJob.findUniqueOrThrow({where:{id:job.id}})).executionTarget).toEqual({kind:"deauthorize",connectionId:f.connection.id});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,job.id)))!);
    expect(revoked).toEqual([f.connection.id]);
    expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:"queued",ruleCursor:f.connection.id,executionTarget:null,claimToken:null,leaseExpiresAt:null,attempts:1});
    await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,job.id)))!);
    expect((await db.zoomWebhookJob.findUniqueOrThrow({where:{id:job.id}})).status).toBe("completed");
    expect(revoked).toHaveLength(1);
  });
  test("an accepted recording with no eligible Rule completes without provider or intake work", async()=>{
    const createdAt = new Date();
    const row = await db.zoomWebhookJob.create({data:{eventKey:crypto.randomUUID(),payload:{event:"recording.completed",eventTs:createdAt.getTime(),accountId:crypto.randomUUID(),hostId:"synthetic-host",meetingUuid:"meeting-one",recordingId:"recording-one",topic:"Synthetic",durationSeconds:60},createdAt,operationDeadlineAt:new Date(createdAt.getTime()+30*86400_000)}});
    const driver = new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{throw Error("No matching Rule can import");},revokeConnection:async()=>{throw Error("Recording notification cannot revoke a connection");}});
    const reference = (await db.$transaction(tx=>queueZoomNotification(tx,row.id)))!;
    expect(reference.subject).toEqual({kind:"zoom_notification",id:row.id});
    expect(await driver.run(reference)).toEqual({kind:"complete"});
    expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:row.id}})).toMatchObject({status:"completed",attempts:0,claimToken:null,leaseExpiresAt:null,operationDeadlineAt:row.operationDeadlineAt});
    expect((await driver.run(reference)).kind).toBe("superseded");
  });
});
