import {afterAll,afterEach,beforeAll,describe,expect,test} from 'bun:test';
import {PrismaClient} from '@prisma/client';
import {PrismaPg} from '@prisma/adapter-pg';
import {withExecutionDispatches} from './execution-dispatch-runtime';
import {DatabaseScope} from '@narriflow/db/client';
import {withServiceEnvironment} from './runtime-environment';
import {assertExecutionDatabaseTestTarget} from './execution-db-test-support';
import {createStandingGrants} from './standing-grant';
import {createNotificationExecution,appendNotificationDelivery} from './notification-execution';
import {planGrantNotificationRecoveryPage,planGrantNotificationRestorePage} from './notification-maintenance';
import {decryptReviewValue} from './review.service';
import {prepareNotificationDelivery} from './notification-execution-runtime';
const url=process.env.SERVERLESS_TEST_DATABASE_URL,suite=process.env.ALLOW_SERVERLESS_DB_TESTS==='1'?describe:describe.skip;
suite('Targeted grant-pause mail',()=>{
 let db:PrismaClient;const users:string[]=[],workspaces:string[]=[];
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema})});});
 afterEach(async()=>{await db.workspace.deleteMany({where:{id:{in:workspaces}}});await db.user.deleteMany({where:{id:{in:users}}});workspaces.length=users.length=0;});
 afterAll(async()=>{await db.$disconnect();});
 async function fixture(){
  const user=await db.user.create({data:{clerkId:crypto.randomUUID(),primaryEmail:`owner-${crypto.randomUUID()}@example.test`,emailVerifiedAt:new Date()}});users.push(user.id);
  const workspace=await db.workspace.create({data:{name:'Grant mail',ownerUserId:user.id,pricingTier:'business',members:{create:{userId:user.id,role:'owner'}}}});workspaces.push(workspace.id);
  const recipe=await db.recipe.create({data:{workspaceId:workspace.id,name:'Settings',contentPack:{outputTypes:['short_clip'],clipCountTarget:3,clipDurationSecTarget:45,platformPlaybookVersion:'test'}}});
  const rule=await db.autopilotRule.create({data:{workspaceId:workspace.id,createdByUserId:user.id,name:'Weekly show',rssUrl:'https://feeds.example.test/feed',recipeId:recipe.id}});
  const grants=createStandingGrants({prisma:db,requireActor:async()=>({userId:user.id,workspaceId:workspace.id,pricingTier:'business',role:'owner',status:'active',ownerUserId:user.id,isPersonalWorkspace:false}) as never});
  const grant=await grants.create({actorUserId:user.id,workspaceId:workspace.id},{kind:'review_send',autopilotRuleId:rule.id,reviewerEmails:['reviewer@example.test'],dailyCap:1,weeklyCap:2,expiresInDays:30});
  return{user,workspace,rule,grant,grants};
 }
 const scoped=<T>(fn:()=>Promise<T>)=>withServiceEnvironment({REVIEW_ACCESS_SECRET:'grant-mail-private-fixture-secret-long-enough',RESEND_API_KEY:'fixture-not-sent',WEB_ORIGIN:'https://web.example.test'},()=>new DatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})}).run(fn));
 test('system pause, workspace ledger and exact dispatch commit or roll back together; replay adds none',async()=>{
  const f=await fixture();
  await expect(f.grants.pauseBySystem(f.grant.id,'invalid-code' as never)).rejects.toThrow();
  expect((await db.standingGrant.findUniqueOrThrow({where:{id:f.grant.id}})).status).toBe('active');
  expect(await db.standingGrantEvent.count({where:{grantId:f.grant.id,kind:'paused'}})).toBe(0);
  expect(await db.grantPauseNotificationLedger.count()).toBe(0);
  await f.grants.pauseBySystem(f.grant.id,'post_failed');await f.grants.pauseBySystem(f.grant.id,'post_failed');
  const ledger=await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{grantId_grantRevision:{grantId:f.grant.id,grantRevision:1}}});
  expect(ledger.operationDeadlineAt.getTime()-ledger.createdAt.getTime()).toBe(23*3600_000);
  expect(await db.executionDispatch.count({where:{subjectId:`em1.g.${ledger.id}`}})).toBe(1);
  expect(await db.project.count({where:{workspaceId:f.workspace.id}})).toBe(0);
 });
 test('production preparation and shared sender retain the original provider key and seal across a retry',async()=>{
  const f=await fixture();await f.grants.pauseBySystem(f.grant.id,'post_failed');const ledger=await db.grantPauseNotificationLedger.findFirstOrThrow({where:{grantId:f.grant.id}}),target={kind:'grant' as const,id:ledger.id};
  const reference=await db.$transaction(tx=>appendNotificationDelivery(tx,target));const calls:Array<{key:string;encrypted:string}>=[];
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async(_target,sealed,key)=>{calls.push({key,encrypted:sealed.encrypted});return{sent:calls.length>1};}});
  await scoped(()=>driver.run(reference));
  const first=await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:ledger.id}});expect(first).toMatchObject({status:'pending',attemptCount:1,generation:2});
  await db.grantPauseNotificationLedger.update({where:{id:ledger.id},data:{nextAttemptAt:new Date(Date.now()-1),generation:{increment:1}}});
  const next=await db.$transaction(tx=>appendNotificationDelivery(tx,target));await scoped(()=>driver.run(next));
  expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(calls[0]!.key).toBe(`standing-grant-paused:${f.grant.id}:1`);
  expect(await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:ledger.id}})).toMatchObject({status:'sent',attemptCount:2,operationDeadlineAt:ledger.operationDeadlineAt,deliveryInputEncrypted:first.deliveryInputEncrypted});
 });
 async function notice(f:Awaited<ReturnType<typeof fixture>>,reason:'post_failed'|'plan_lost'|'granter_unavailable'='post_failed'){
  await f.grants.pauseBySystem(f.grant.id,reason);const row=await db.grantPauseNotificationLedger.findFirstOrThrow({where:{grantId:f.grant.id}}),target={kind:'grant' as const,id:row.id};return{row,target,reference:await db.$transaction(tx=>appendNotificationDelivery(tx,target))};
 }
 test('a repeated accepted system pause repairs its original mail and grant targets after lost acknowledgement',async()=>{
  const f=await fixture(),deliveries:string[][]=[];
  const invoke=()=>withExecutionDispatches(()=>f.grants.pauseBySystem(f.grant.id,'post_failed'),{database:db,deliver:async ids=>{deliveries.push([...ids]);if(deliveries.length===1)throw Error('lost-pause-ack');}});
  await expect(invoke()).rejects.toThrow('lost-pause-ack');expect(await invoke()).toBe(false);
  expect(deliveries).toHaveLength(2);expect(deliveries[1]).toHaveLength(2);expect(deliveries[1]!.every(id=>deliveries[0]!.includes(id))).toBe(true);expect(await db.grantPauseNotificationLedger.count({where:{grantId:f.grant.id}})).toBe(1);
 });
 test('a lost registration acknowledgement repairs the same intent before any send',async()=>{
  const f=await fixture(),n=await notice(f);let sends=0,lose=true;
  const driver=createNotificationExecution({database:db,prepare:prepareNotificationDelivery,register:async()=>{if(lose){lose=false;throw Error('lost-grant-watchdog');}},send:async()=>{sends++;return{sent:true};}});
  await expect(scoped(()=>driver.run(n.reference))).rejects.toThrow('lost-grant-watchdog');
  expect(sends).toBe(0);expect(await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'pending',claimToken:null,attemptCount:0});
  await scoped(()=>driver.run(n.reference));expect(sends).toBe(1);
 });
 test('three physical submissions retain one body and key, and automatic replay cannot reset the budget',async()=>{
  const f=await fixture(),n=await notice(f),calls:string[]=[];
  const driver=createNotificationExecution({database:db,prepare:prepareNotificationDelivery,register:async()=>{},send:async(_t,s,key)=>{calls.push(`${key}:${s.encrypted}`);return{sent:false};}});
  for(let i=0;i<3;i++){
   if(i)await db.grantPauseNotificationLedger.update({where:{id:n.row.id},data:{nextAttemptAt:new Date(Date.now()-1),generation:{increment:1}}});
   await scoped(()=>db.$transaction(tx=>appendNotificationDelivery(tx,n.target)).then(reference=>driver.run(reference)));
  }
  const terminal=await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}});
  expect(terminal).toMatchObject({status:'failed',attemptCount:3,operationDeadlineAt:n.row.operationDeadlineAt});expect(new Set(calls).size).toBe(1);
  await scoped(()=>driver.run(n.reference));expect(calls).toHaveLength(3);
  await expect(Promise.resolve(db.grantPauseNotificationLedger.update({where:{id:n.row.id},data:{attemptCount:0}}))).rejects.toThrow('grant notification input is immutable');
  await expect(Promise.resolve(db.grantPauseNotificationLedger.update({where:{id:n.row.id},data:{operationDeadlineAt:new Date(n.row.operationDeadlineAt.getTime()+1)}}))).rejects.toThrow('grant notification input is immutable');
 });
 test('renewal or expiry supersedes the old pause and cannot send its misleading notice',async()=>{
  for(const kind of ['renew','expire'] as const){const f=await fixture(),n=await notice(f);let sends=0;
   if(kind==='renew')await f.grants.renew({workspaceId:f.workspace.id,actorUserId:f.user.id},{grantId:f.grant.id,dailyCap:1,weeklyCap:2,expiresInDays:30});
   else await db.standingGrant.update({where:{id:f.grant.id},data:{expiresAt:new Date(Date.now()-1)}});
   await scoped(()=>createNotificationExecution({database:db,prepare:prepareNotificationDelivery,register:async()=>{},send:async()=>{sends++;return{sent:true};}}).run(n.reference));
   expect(sends).toBe(0);expect(await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'skipped',attemptCount:0});
  }
 });
 test('plan loss still informs a verified current owner when the granter no longer manages the Workspace',async()=>{
  const f=await fixture();const former=await db.user.create({data:{clerkId:crypto.randomUUID(),primaryEmail:'former@example.test',emailVerifiedAt:new Date()}});users.push(former.id);
  await db.workspaceMember.create({data:{workspaceId:f.workspace.id,userId:former.id,role:'editor'}});await db.standingGrant.update({where:{id:f.grant.id},data:{grantedByUserId:former.id}});
  await db.workspace.update({where:{id:f.workspace.id},data:{pricingTier:'free'}});const n=await notice(f,'plan_lost');
  const sealed=await scoped(()=>prepareNotificationDelivery(n.target,null));expect(sealed).toBeTruthy();
  const envelope=JSON.parse(decryptReviewValue(sealed!.encrypted,'grant-mail-private-fixture-secret-long-enough'));
  expect(envelope.request.to).toBe(f.user.primaryEmail);expect(envelope.request.text).toContain('Weekly show');
 });
 test('a recipient change between preparation and the send marker starts no provider request',async()=>{
  const f=await fixture(),n=await notice(f);let sends=0;
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare:async(target,previous)=>{const sealed=await prepareNotificationDelivery(target,previous);await db.user.update({where:{id:f.user.id},data:{primaryEmail:'changed@example.test'}});return sealed;},send:async()=>{sends++;return{sent:true};}});
  await scoped(()=>driver.run(n.reference));expect(sends).toBe(0);expect(await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'skipped',attemptCount:0,failureCode:'recipient_changed'});
 });
 test('a duplicate waits without SQL held across send, and renewal fences a late successful response',async()=>{
  const f=await fixture(),n=await notice(f),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let sends=0;
  const driver=createNotificationExecution({database:db,prepare:prepareNotificationDelivery,register:async()=>{},send:async()=>{sends++;entered.resolve();await release.promise;return{sent:true};}});
  const running=scoped(()=>driver.run(n.reference));await entered.promise;
  try{
   expect((await scoped(()=>driver.run(n.reference))).kind).toBe('wait');
   await f.grants.renew({workspaceId:f.workspace.id,actorUserId:f.user.id},{grantId:f.grant.id,dailyCap:1,weeklyCap:2,expiresInDays:30});release.resolve();expect(await running).toEqual({kind:'superseded'});
   expect(sends).toBe(1);expect(await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'claimed',attemptCount:1,sentAt:null});
   await scoped(()=>driver.run(n.reference));expect((await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).status).toBe('skipped');
  }finally{release.resolve();await running;}
 });
 test('metadata restore preserves original body, future due, deadline and charged starts; final page alone redispatches',async()=>{
  const f=await fixture(),n=await notice(f);await scoped(()=>createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async()=>({sent:false})}).run(n.reference));
  const original=await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}}),rollback=Error('grant-restore-rollback');
  await expect(db.$transaction(async tx=>{
   const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}}),fence=await tx.executionEpoch.update({where:{id:1},data:{epoch:epoch.epoch+1,admissionOpen:false,changedAt:new Date()}}),page={snapshotEpoch:epoch.epoch,fenceAboveEpoch:epoch.epoch,deploymentEpoch:fence.epoch,cutoff:fence.changedAt,after:null,limit:32};
   const before=await tx.executionDispatch.count();expect((await planGrantNotificationRestorePage(tx,page)).dispatchIds).toEqual([]);expect(await tx.executionDispatch.count()).toBe(before);
   expect(await tx.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({deploymentEpoch:fence.epoch,generation:original.generation+1,status:'pending',claimToken:null,attemptCount:1,deliveryInputEncrypted:original.deliveryInputEncrypted,deliveryContextFingerprint:original.deliveryContextFingerprint,operationDeadlineAt:original.operationDeadlineAt,nextAttemptAt:original.nextAttemptAt});
   const result=await planGrantNotificationRecoveryPage(tx,page);expect(result.dispatchIds).toHaveLength(2);expect(result.processed).toBe(1);
   const base=await tx.executionDispatch.findFirstOrThrow({where:{id:{in:[...result.dispatchIds!]},wakeKind:null}});expect(base.dueAt).toEqual(original.nextAttemptAt);
   throw rollback;
  })).rejects.toBe(rollback);
  expect(await db.grantPauseNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toEqual(original);
 });

});
