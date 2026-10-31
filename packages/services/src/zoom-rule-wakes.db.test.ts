import { afterAll,beforeAll,describe,expect,test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { contentPackSchema } from "@narriflow/validators";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { withServiceEnvironment } from "./runtime-environment";
import { ZoomService } from "./zoom.service";
import { ExecutionDispatchPendingError } from "./execution-dispatch";
import { AutopilotService } from "./autopilot.service";
import { ZoomNotificationExecution,queueZoomNotification } from "./zoom-execution";
import { readExecutionDispatch } from "./execution-dispatch";
import { createZoomRuleWakes,appendZoomRuleWake } from "./zoom-rule-wakes";
const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==="1"&&url?describe:describe.skip;
suite("Exact Zoom Rule resume producers",()=>{
 let db:PrismaClient;const context=createDatabaseTestContext();
 const scoped=<T>(run:()=>Promise<T>)=>()=>withServiceEnvironment({...process.env,ZOOM_CLIENT_ID:"synthetic",ZOOM_CLIENT_SECRET:"synthetic",ZOOM_WEBHOOK_SECRET_TOKEN:"synthetic",SOCIAL_TOKEN_ENCRYPTION_KEY:"synthetic-zoom-key"},context.bind(run));
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA??"public";assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema})});context.client=db;});
 afterAll(async()=>{await db?.$disconnect();});
 async function fixture(){
  const user=await db.user.create({data:{clerkId:`zoom-resume:${crypto.randomUUID()}`}}),workspace=await db.workspace.create({data:{name:"Zoom resume",ownerUserId:user.id,pricingTier:"business",members:{create:{userId:user.id,role:"owner"}}}});
  const recipe=await db.recipe.create({data:{workspaceId:workspace.id,createdByUserId:user.id,name:"Original",contentPack:contentPackSchema.parse({outputTypes:["short_clip"],clipCountTarget:3,clipDurationSecTarget:45,platformPlaybookVersion:"test"})}});
  const connection=await db.zoomConnection.create({data:{workspaceId:workspace.id,userId:user.id,zoomAccountId:crypto.randomUUID(),zoomUserId:"resume-host",displayName:"Synthetic",accessTokenEncrypted:"unused",refreshTokenEncrypted:"unused",scopes:[]}});
  const rule=await db.autopilotRule.create({data:{workspaceId:workspace.id,createdByUserId:user.id,sourceKind:"zoom",zoomConnectionId:connection.id,recipeId:recipe.id,name:"Original"}});
  const createdAt=new Date(),job=await db.zoomWebhookJob.create({data:{eventKey:crypto.randomUUID(),payload:{event:"recording.completed",eventTs:createdAt.getTime(),accountId:connection.zoomAccountId,hostId:connection.zoomUserId,meetingUuid:"resume",recordingId:"resume",topic:"Synthetic",durationSeconds:60},createdAt,operationDeadlineAt:new Date(createdAt.getTime()+30*86400_000)}});
  return {user,workspace,recipe,connection,rule,job};
 }
 test("a resume command durably wakes the original paused target and repairs a lost page registration ACK",scoped(async()=>{
  const {user,workspace,rule,job}=await fixture();
  let imports=0;const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{imports++;return {count:1};},revokeConnection:async()=>{}});
  await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,job.id)))!);
  const frozen=(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:job.id}})).executionTarget;
  const service=new AutopilotService(),scope={workspaceId:workspace.id,actorUserId:user.id};
  await service.updateRule(scope,rule.id,{status:"paused"});
  await db.autopilotRule.update({where:{id:rule.id},data:{pauseKind:"brand_profile"}});
  const parked=(await db.$transaction(tx=>queueZoomNotification(tx,job.id)))!;
  expect(await driver.run(parked)).toEqual({kind:"wait",dueAt:job.operationDeadlineAt});
  await service.updateRule(scope,rule.id,{status:"active"});
  const event=await db.executionDispatch.findFirstOrThrow({where:{kind:"maintenance",subjectKind:"maintenance",subjectId:{startsWith:`zw1.${workspace.id.replaceAll("-","")}.${rule.id.replaceAll("-","")}.`}},orderBy:{createdAt:"desc"}});
  const deliveries:string[][]=[];const producer=createZoomRuleWakes({database:db,register:async ids=>{deliveries.push([...ids]);if(deliveries.length===1)throw Error("lost_resume_page_ack");}}),reference=(await readExecutionDispatch(db,event.id))!.reference;
  await expect(producer.dispatch(reference)).rejects.toThrow("lost_resume_page_ack");
  await producer.dispatch(reference);
  expect(deliveries).toHaveLength(2);expect(deliveries[1]).toEqual(deliveries[0]);
  const wakes=await db.executionDispatch.findMany({where:{kind:"operation_driver",subjectKind:"zoom_notification",subjectId:job.id,wakeKind:{startsWith:"zr_"}}});expect(wakes).toHaveLength(1);
  expect((await db.zoomWebhookJob.findUniqueOrThrow({where:{id:job.id}})).executionTarget).toEqual(frozen);
  await driver.run((await readExecutionDispatch(db,wakes[0]!.id))!.reference);
  expect(imports).toBe(1);
  expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({ruleCursor:rule.id,executionTarget:null,operationDeadlineAt:job.operationDeadlineAt});
 }));
 test("Rule deletion wakes its former target and a replay repairs the same deletion obligation",scoped(async()=>{
  const f=await fixture();let imports=0;
  const driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{imports++;return {count:1};},revokeConnection:async()=>{}});
  await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
  const service=new AutopilotService(),scope={workspaceId:f.workspace.id,actorUserId:f.user.id};
  await service.deleteRule(scope,f.rule.id);
  await service.deleteRule(scope,f.rule.id);
  const events=await db.executionDispatch.findMany({where:{kind:"maintenance",subjectKind:"maintenance",subjectId:`zw1.${f.workspace.id.replaceAll("-","")}.${f.rule.id.replaceAll("-","")}.d`}});
  expect(events).toHaveLength(1);
  await createZoomRuleWakes({database:db,register:async()=>{}}).dispatch((await readExecutionDispatch(db,events[0]!.id))!.reference);
  const wake=await db.executionDispatch.findFirstOrThrow({where:{subjectKind:"zoom_notification",subjectId:f.job.id,wakeKind:{startsWith:"zr_"}}});
  await driver.run((await readExecutionDispatch(db,wake.id))!.reference);
  expect(imports).toBe(0);
  expect(await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}})).toMatchObject({executionTarget:null,ruleCursor:f.rule.id,skippedTargets:1});
 }));
 test("deauthorization confirms its Rule wakes before acknowledgement and repairs them after a lost response",scoped(async()=>{
  const f=await fixture(),deliveries:string[][]=[];
  const service=new ZoomService({register:async ids=>{deliveries.push([...ids]);if(deliveries.length===1)throw new ExecutionDispatchPendingError(new Date(Date.now()+1000));}});
  const eventAt=new Date();
  await expect(service.revokeNotifiedConnection(f.connection.id,eventAt)).rejects.toBeInstanceOf(ExecutionDispatchPendingError);
  const revoked=await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}});expect(revoked.revokedAt).not.toBeNull();expect(revoked.accessTokenEncrypted).toBeNull();
  await service.revokeNotifiedConnection(f.connection.id,eventAt);
  expect(deliveries).toHaveLength(2);expect(deliveries[1]).toEqual(deliveries[0]);
  expect(await db.autopilotRule.findUniqueOrThrow({where:{id:f.rule.id}})).toMatchObject({status:"paused",pauseKind:"zoom_connection"});
 }));

 test("a Rule event pages33 frozen targets with a strict cursor and one committed continuation",scoped(async()=>{
  const f=await fixture(),driver=new ZoomNotificationExecution({database:db,register:async()=>{},importRecording:async()=>{throw Error("Producer cannot import");},revokeConnection:async()=>{}});
  await driver.run((await db.$transaction(tx=>queueZoomNotification(tx,f.job.id)))!);
  const row=await db.zoomWebhookJob.findUniqueOrThrow({where:{id:f.job.id}});
  await db.zoomWebhookJob.createMany({data:Array.from({length:32},()=>({eventKey:crypto.randomUUID(),payload:row.payload as never,executionTarget:row.executionTarget as never,deploymentEpoch:row.deploymentEpoch,createdAt:row.createdAt,availableAt:row.availableAt,operationDeadlineAt:row.operationDeadlineAt}))});
  const ref=(await db.$transaction(tx=>appendZoomRuleWake(tx,f.rule.id)))!;
  const producer=createZoomRuleWakes({database:db,register:async()=>{}}),first=await producer.dispatch(ref);
  expect(first.dispatchIds.length).toBeLessThanOrEqual(127);
  const continuations=await db.executionDispatch.findMany({where:{kind:"maintenance",subjectKind:"maintenance",subjectId:{startsWith:`${ref.subject.id}.`}}});expect(continuations).toHaveLength(1);
  await producer.dispatch((await readExecutionDispatch(db,continuations[0]!.id))!.reference);
  const jobs=await db.zoomWebhookJob.findMany({where:{executionTarget:{path:["plan","source","ruleId"],equals:f.rule.id}},select:{id:true}});
  expect(jobs).toHaveLength(33);
  expect(await db.executionDispatch.count({where:{subjectKind:"zoom_notification",subjectId:{in:jobs.map(job=>job.id)},wakeKind:{startsWith:"zr_"}}})).toBe(33);
  expect(await producer.dispatch(ref)).toEqual(first);
  expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 }));

});
