import {reviewsCommands} from "./reviews-commands-runtime";
import {withExecutionDispatches} from "./execution-dispatch-runtime";
import {DatabaseScope} from "@narriflow/db/client";
import {withServiceEnvironment} from "./runtime-environment";
import {prepareNotificationDelivery} from "./notification-execution-runtime";
import {encryptReviewValue,decryptReviewValue} from "./review.service";
import {planProjectNotificationRecoveryPage,planReviewNotificationRecoveryPage,planProjectNotificationRestorePage,planReviewNotificationRestorePage} from "./notification-maintenance";
import {appendWorkflowEvent} from "./workflow-event-append";
import {afterAll,afterEach,beforeAll,describe,expect,test} from "bun:test";
import {PrismaPg} from "@prisma/adapter-pg";
import {PrismaClient} from "@prisma/client";
import {assertExecutionDatabaseTestTarget} from "./execution-db-test-support";
import {appendNotificationDelivery,createNotificationExecution} from "./notification-execution";
import {readExecutionDispatch} from "./execution-dispatch";
const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==='1'&&url?describe:describe.skip;
suite('Targeted email notification delivery',()=>{
 let db:PrismaClient;const workspaces:string[]=[],users:string[]=[];
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA??'public';assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:5},{schema}),transactionOptions:{timeout:30000,maxWait:10000}});});
 afterEach(async()=>{await db.workspace.deleteMany({where:{id:{in:workspaces}}});await db.user.deleteMany({where:{id:{in:users}}});workspaces.length=users.length=0;});
 afterAll(async()=>{await db.$disconnect();});
 async function fixture(){
  const user=await db.user.create({data:{clerkId:`mail-gate:${crypto.randomUUID()}`}});users.push(user.id);
  const workspace=await db.workspace.create({data:{name:'Mail gate',ownerUserId:user.id,pricingTier:'business'}});workspaces.push(workspace.id);
  await db.workspaceMember.create({data:{workspaceId:workspace.id,userId:user.id,role:'owner'}});
  const project=await db.project.create({data:{workspaceId:workspace.id,title:'Mail gate',sourceMediaUrl:'r2://fixture/source'}});
  const ledger=await db.notificationLedger.create({data:{projectId:project.id,sourceId:crypto.randomUUID(),outcome:'clips_ready'}});
  const target={kind:'project' as const,id:ledger.id};
  return{user,project,ledger,target,reference:await db.$transaction(tx=>appendNotificationDelivery(tx,target))};
 }
 const prepare=async(_target:unknown,sealed:{encrypted:string;hash:string}|null)=>sealed??{encrypted:'private-fixture',hash:'a'.repeat(64)};
 async function review(f:Awaited<ReturnType<typeof fixture>>,encrypted='unused'){
  const round=await db.reviewRound.create({data:{workspaceId:f.project.workspaceId,projectId:f.project.id,createdByUserId:f.user.id,revision:1,title:'Fixture review',recipientEmails:['reviewer@example.test'],accessTokenHash:'a'.repeat(64),deliveryTokenEncrypted:encrypted}});
  const ledger=await db.reviewNotificationLedger.create({data:{reviewRoundId:round.id,recipientEmail:'reviewer@example.test',kind:'round_sent',scopeKey:'round'}});
  const target={kind:'review' as const,id:ledger.id};return{round,ledger,target,reference:await db.$transaction(tx=>appendNotificationDelivery(tx,target))};
 }
 test('terminal source facts, notification intent and dispatch roll back or commit together',async()=>{
  const f=await fixture();const run=await db.workflowRun.create({data:{projectId:f.project.id,stage:'clip_rendering',status:'completed',idempotencyKey:crypto.randomUUID()}});
  const input={projectId:f.project.id,workflowRunId:run.id,attemptId:crypto.randomUUID(),stage:'clip_rendering' as const,status:'completed' as const,progress:100,errorCode:null,transition:'mail_gate',notification:{kind:'clip_render.completed' as const,projectId:f.project.id,workflowRunId:run.id,requested:2,succeeded:2,failed:0,superseded:0}};
  await expect(db.$transaction(async tx=>{await appendWorkflowEvent(tx,input);throw Error('terminal_mail_rollback');})).rejects.toThrow('terminal_mail_rollback');
  expect(await db.notificationLedger.count({where:{sourceId:run.id}})).toBe(0);expect(await db.workflowEvent.count({where:{workflowRunId:run.id}})).toBe(0);
  await db.$transaction(tx=>appendWorkflowEvent(tx,input));
  const ledger=await db.notificationLedger.findFirstOrThrow({where:{sourceId:run.id}});
  expect(ledger).toMatchObject({status:'pending',facts:{clipCount:2,reason:null}});
  expect(await db.executionDispatch.count({where:{subjectKind:'notification',subjectId:`em1.p.${ledger.id}`}})).toBe(1);
  expect(await db.workflowEvent.findFirstOrThrow({where:{workflowRunId:run.id}})).toMatchObject({notificationRequired:true,notificationDeliveredAt:expect.any(Date)});
  await db.$transaction(tx=>appendWorkflowEvent(tx,input));
  expect(await db.notificationLedger.count({where:{sourceId:run.id}})).toBe(1);
 });
 test('review delivery uses its own exact target and original provider key',async()=>{
  const f=await fixture(),r=await review(f),keys:string[]=[];
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare,send:async(target,_sealed,key)=>{expect(target).toEqual(r.target);keys.push(key);return{sent:true,providerMessageId:'review-fixture'};}});
  expect((await driver.run(r.reference)).kind).toBe('complete');
  expect(await db.reviewNotificationLedger.findUniqueOrThrow({where:{id:r.ledger.id}})).toMatchObject({status:'sent',attemptCount:1,claimToken:null,providerMessageId:'review-fixture'});
  await driver.run(r.reference);expect(keys).toEqual([`review-notification-${r.ledger.id}`]);
  expect(await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}})).toMatchObject({status:'pending',attemptCount:0});
 });
 test('a started final attempt remains owned until its lease ends and expiry grants no fresh send',async()=>{
  const f=await fixture();let sends=0;
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare,send:async()=>{sends++;return{sent:true};}});
  await db.notificationLedger.update({where:{id:f.ledger.id},data:{status:'claimed',claimToken:crypto.randomUUID(),leaseExpiresAt:new Date(Date.now()+60_000),attemptCount:3,submissionStartedAt:new Date()}});
  expect((await driver.run(f.reference)).kind).toBe('wait');
  await db.notificationLedger.update({where:{id:f.ledger.id},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
  await driver.run(f.reference);const next=await db.$transaction(tx=>appendNotificationDelivery(tx,f.target));await driver.run(next);
  expect(sends).toBe(0);expect(await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}})).toMatchObject({status:'failed',attemptCount:3,generation:2});
 });
 test('an expired original deadline cannot send or extend itself',async()=>{
  const f=await fixture(),old=Date.now()-2000;
  const ledger=await db.notificationLedger.create({data:{projectId:f.project.id,sourceId:crypto.randomUUID(),outcome:'no_clips',createdAt:new Date(old),operationDeadlineAt:new Date(old+1000)}}),target={kind:'project' as const,id:ledger.id};let sends=0;
  const reference=await db.$transaction(tx=>appendNotificationDelivery(tx,target));
  await createNotificationExecution({database:db,register:async()=>{},prepare,send:async()=>{sends++;return{sent:true};}}).run(reference);
  expect(sends).toBe(0);expect(await db.notificationLedger.findUniqueOrThrow({where:{id:ledger.id}})).toMatchObject({status:'failed',attemptCount:0,operationDeadlineAt:ledger.operationDeadlineAt});
 });
 test('restore preserves encrypted provider requests and deadlines before a bounded final redispatch',async()=>{
  const f=await fixture(),r=await review(f);
  await db.notificationLedger.update({where:{id:f.ledger.id},data:{status:'claimed',claimToken:crypto.randomUUID(),leaseExpiresAt:new Date(Date.now()+60_000),attemptCount:1,submissionStartedAt:new Date(),deliveryInputEncrypted:'sealed-original',deliveryInputHash:'b'.repeat(64)}});
  const original=await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}}),rollback=Error('mail_restore_rollback');
  await expect(db.$transaction(async tx=>{
   const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}}),fence=await tx.executionEpoch.update({where:{id:1},data:{epoch:epoch.epoch+1,admissionOpen:false,changedAt:new Date()}});
   const page={snapshotEpoch:epoch.epoch,fenceAboveEpoch:epoch.epoch,deploymentEpoch:fence.epoch,cutoff:fence.changedAt,after:{at:original.createdAt,id:'00000000-0000-0000-0000-000000000000'},limit:32};
   const before=await tx.executionDispatch.count();
   expect((await planProjectNotificationRestorePage(tx,page)).dispatchIds).toEqual([]);
   expect((await planReviewNotificationRestorePage(tx,page)).dispatchIds).toEqual([]);
   expect(await tx.executionDispatch.count()).toBe(before);
   expect(await tx.notificationLedger.findUniqueOrThrow({where:{id:original.id}})).toMatchObject({deploymentEpoch:fence.epoch,generation:2,status:'pending',attemptCount:1,claimToken:null,leaseExpiresAt:null,deliveryInputEncrypted:original.deliveryInputEncrypted,deliveryInputHash:original.deliveryInputHash,operationDeadlineAt:original.operationDeadlineAt,nextAttemptAt:original.nextAttemptAt});
   expect(await tx.reviewNotificationLedger.findUniqueOrThrow({where:{id:r.ledger.id}})).toMatchObject({deploymentEpoch:fence.epoch,generation:2,status:'pending',attemptCount:0,operationDeadlineAt:r.ledger.operationDeadlineAt});
   expect((await planProjectNotificationRestorePage(tx,page)).processed).toBe(0);
   expect((await planProjectNotificationRecoveryPage(tx,page)).dispatchIds).toHaveLength(2);
   expect((await planReviewNotificationRecoveryPage(tx,page)).dispatchIds).toHaveLength(2);
   await expect(planProjectNotificationRestorePage(tx,{...page,cutoff:new Date(page.cutoff.getTime()+1)})).rejects.toThrow('restore_page_proof_invalid');
   throw rollback;
  })).rejects.toBe(rollback);
  expect(await db.notificationLedger.findUniqueOrThrow({where:{id:original.id}})).toEqual(original);
 });
 test('production preparation freezes encrypted request bytes while recipient or review-token changes revoke delivery',async()=>{
  const f=await fixture(),secret='notification-private-test-key-0123456789';
  await db.user.update({where:{id:f.user.id},data:{primaryEmail:'original@example.test'}});
  const r=await review(f,encryptReviewValue('original-guest-token',secret));
  const run=<T>(operation:()=>Promise<T>)=>new DatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})}).run(()=>withServiceEnvironment({RESEND_API_KEY:'fake-not-used-for-send',REVIEW_ACCESS_SECRET:secret,WEB_ORIGIN:'https://app.example.test'},operation));
  const first=(await run(()=>prepareNotificationDelivery(f.target,null)))!;
  const envelope=JSON.parse(decryptReviewValue(first.encrypted,secret));expect(envelope.request.to).toBe('original@example.test');expect(envelope.request.idempotencyKey).toBeUndefined();
  await db.project.update({where:{id:f.project.id},data:{title:'Changed after first attempt'}});
  expect(await run(()=>prepareNotificationDelivery(f.target,first))).toEqual(first);
  await db.user.update({where:{id:f.user.id},data:{primaryEmail:'changed@example.test'}});
  expect(await run(()=>prepareNotificationDelivery(f.target,first))).toBeNull();
  const reviewSeal=(await run(()=>prepareNotificationDelivery(r.target,null)))!;expect(reviewSeal).toBeTruthy();
  await db.reviewRound.update({where:{id:r.round.id},data:{deliveryTokenEncrypted:encryptReviewValue('rotated-guest-token',secret)}});
  expect(await run(()=>prepareNotificationDelivery(r.target,reviewSeal))).toBeNull();
 });
 test('an accepted review invite repairs its stored notification wake after scheduler ACK loss',async()=>{
  const f=await fixture(),r=await review(f),key=crypto.randomUUID(),registrations:string[][]=[];let lose=true;
  const invoke=()=>new DatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})}).run(()=>withServiceEnvironment({REVIEW_ACCESS_SECRET:'review-receipt-private-fixture-secret-0123456789'},()=>withExecutionDispatches(()=>reviewsCommands.invite({actorUserId:f.user.id,workspaceId:f.project.workspaceId,projectId:f.project.id,pricingTier:'business'},r.round.id,{recipientEmails:['new-reviewer@example.test']},{clientIdempotencyKey:key}),{database:db,deliver:async ids=>{registrations.push([...ids]);if(lose){lose=false;throw Error('review-invite-ack-lost');}}})));
  await expect(invoke()).rejects.toThrow('review-invite-ack-lost');
  const receipt=await db.operationReceipt.findFirstOrThrow({where:{workspaceId:f.project.workspaceId,command:'invite_reviewers',clientIdempotencyKey:key}});
  expect(receipt.result).toMatchObject({notificationDispatchIds:expect.any(Array),protectedResult:expect.any(String)});
  expect(await invoke()).toMatchObject({replayed:true,value:{addedCount:1}});
  expect(registrations).toHaveLength(2);expect(registrations[1]).toEqual(registrations[0]);
  expect(await db.reviewNotificationLedger.count({where:{reviewRoundId:r.round.id,recipientEmail:'new-reviewer@example.test'}})).toBe(1);
 });
 test('a rolled-back intent leaves no dispatch and exact replay retains its original deadline',async()=>{
  const f=await fixture();const count=await db.executionDispatch.count({where:{subjectId:f.reference.subject.id}});
  expect(await db.$transaction(tx=>appendNotificationDelivery(tx,f.target))).toEqual(f.reference);
  expect(await db.executionDispatch.count({where:{subjectId:f.reference.subject.id}})).toBe(count);
  await expect(db.$transaction(async tx=>{const next=await tx.notificationLedger.create({data:{projectId:f.project.id,sourceId:crypto.randomUUID(),outcome:'no_clips'}});await appendNotificationDelivery(tx,{kind:'project',id:next.id});throw Error('rollback-mail');})).rejects.toThrow('rollback-mail');
  expect(await db.notificationLedger.count({where:{projectId:f.project.id}})).toBe(1);
  await expect(Promise.resolve(db.notificationLedger.update({where:{id:f.ledger.id},data:{operationDeadlineAt:new Date(f.ledger.operationDeadlineAt.getTime()+1)}}))).rejects.toThrow('notification delivery input is immutable');
 });
 test('unconfirmed watchdog starts no provider request and consumes no attempt',async()=>{
  const f=await fixture();let sends=0;
  const driver=createNotificationExecution({database:db,register:async()=>{throw Error('mail-watchdog-unconfirmed');},prepare,send:async()=>{sends++;return{sent:true};}});
  await expect(driver.run(f.reference)).rejects.toThrow('mail-watchdog-unconfirmed');expect(sends).toBe(0);
  expect(await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}})).toMatchObject({status:'pending',claimToken:null,leaseExpiresAt:null,attemptCount:0,generation:1});
 });
 test('a concurrent duplicate waits without another send and late results cannot publish after owner revocation',async()=>{
  const f=await fixture();let entered!:()=>void,release!:()=>void,sends=0;
  const started=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare,send:async()=>{sends++;entered();await barrier;return{sent:true,providerMessageId:'private-test-id'};}});
  const pending=driver.run(f.reference);await started;expect((await driver.run(f.reference)).kind).toBe('wait');expect(sends).toBe(1);
  await db.notificationLedger.update({where:{id:f.ledger.id},data:{status:'pending',claimToken:null,leaseExpiresAt:null,generation:{increment:1}}});
  release();expect((await pending).kind).toBe('superseded');
  expect(await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}})).toMatchObject({status:'pending',providerMessageId:null,attemptCount:1});
 });
 test('lost continuation acknowledgement repairs the committed wake without sending or extending a budget',async()=>{
  const f=await fixture();let sends=0,lose=true,repairs=0;const keys:string[]=[];
  const driver=createNotificationExecution({database:db,register:async ids=>{const next=await db.executionDispatch.findMany({where:{id:{in:[...ids]},generation:2}});if(next.length){repairs++;if(lose){lose=false;throw Error('mail-next-ack-lost');}}},prepare,send:async(_target,_sealed,key)=>{sends++;keys.push(key);return{sent:false};}});
  await expect(driver.run(f.reference)).rejects.toThrow('mail-next-ack-lost');const accepted=await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}});
  expect(accepted).toMatchObject({status:'pending',generation:2,attemptCount:1,operationDeadlineAt:f.ledger.operationDeadlineAt,deliveryInputEncrypted:'private-fixture'});
  expect((await driver.run(f.reference)).kind).toBe('superseded');expect(repairs).toBe(2);expect(sends).toBe(1);expect(keys).toEqual([`notification-ledger-${f.ledger.id}`]);
  expect(await db.notificationLedger.findUniqueOrThrow({where:{id:f.ledger.id}})).toEqual(accepted);
  const next=await db.$transaction(tx=>appendNotificationDelivery(tx,f.target));expect((await driver.run(next)).kind).toBe('sleep');expect(sends).toBe(1);
  expect((await readExecutionDispatch(db,next.dispatchId))!.reference).toEqual(next);
 });
});
