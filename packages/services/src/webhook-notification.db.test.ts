import {afterAll,afterEach,beforeAll,describe,expect,test} from 'bun:test';
import {PrismaClient} from '@prisma/client';
import {PrismaPg} from '@prisma/adapter-pg';
import {assertExecutionDatabaseTestTarget} from './execution-db-test-support';
import {OutboundDeliveryService} from './outbound-delivery';
import {createCallbackCipher,prepareCallbackRegistration} from './completion-callback';
import {withExecutionDispatches,takeExecutionDispatchIds} from './execution-dispatch-runtime';
import {createNotificationExecution,appendNotificationDelivery} from './notification-execution';
import {prepareNotificationDelivery} from './notification-execution-runtime';
import {DatabaseScope} from '@narriflow/db/client';
import {withServiceEnvironment} from './runtime-environment';
import {decryptReviewValue} from './review.service';
import {createWebhookSubscriptions} from './webhook-subscription';
import {planWebhookNotificationRecoveryPage,planWebhookNotificationRestorePage} from './notification-maintenance';
import {expireWebhookNotificationRowsPage} from './execution-private-retention';
const url=process.env.SERVERLESS_TEST_DATABASE_URL,suite=process.env.ALLOW_SERVERLESS_DB_TESTS==='1'?describe:describe.skip;
suite('Targeted disabled webhook mail',()=>{
 let db:PrismaClient;const users:string[]=[],workspaces:string[]=[];
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema})});});
 afterEach(async()=>{await db.workspace.deleteMany({where:{id:{in:workspaces}}});await db.user.deleteMany({where:{id:{in:users}}});workspaces.length=users.length=0;});
 afterAll(async()=>{await db.$disconnect();});
 async function fixture(database=db){
  const user=await db.user.create({data:{clerkId:crypto.randomUUID(),primaryEmail:`owner-${crypto.randomUUID()}@example.test`,emailVerifiedAt:new Date()}});users.push(user.id);
  const workspace=await db.workspace.create({data:{name:'Webhook mail',ownerUserId:user.id,pricingTier:'business',members:{create:{userId:user.id,role:'owner'}},workspaceEventCounter:{create:{lastSeq:10n}}}});workspaces.push(workspace.id);
  const cipher=createCallbackCipher('webhook-mail-private-fixture-material'),sub=await db.webhookSubscription.create({data:{workspaceId:workspace.id,createdByUserId:user.id,...prepareCallbackRegistration(new URL('https://receiver.example.test/notification?private=hidden'),cipher),types:['operation.finished'],lastDeliveredSeq:0n}});
  const service=new OutboundDeliveryService(database,{cipher,register:async()=>{},body:{put:async()=>{throw Error('No delivery body expected');},head:async()=>{throw Error('No delivery body expected');},read:async()=>{throw Error('No delivery body expected');}}});
  return{user,workspace,sub,service};
 }
 const scoped=<T>(fn:()=>Promise<T>)=>withServiceEnvironment({REVIEW_ACCESS_SECRET:'webhook-mail-private-fixture-secret-long-enough',RESEND_API_KEY:'fixture-not-sent',WEB_ORIGIN:'https://web.example.test'},()=>new DatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})}).run(fn));
 async function notice(f:Awaited<ReturnType<typeof fixture>>){await f.service.prepareSubscription(f.sub.id);const row=await db.webhookDisabledNotificationLedger.findFirstOrThrow({where:{webhookId:f.sub.id},orderBy:{disableRevision:'desc'}}),target={kind:'webhook' as const,id:row.id};return{row,target,reference:await db.$transaction(tx=>appendNotificationDelivery(tx,target))};}
 test('a disabled subscription accepts exactly one mail intent and its wake in the disabling transaction',async()=>{
  const f=await fixture();expect(await f.service.prepareSubscription(f.sub.id)).toEqual({kind:'terminal'});
  const row=await db.webhookSubscription.findUniqueOrThrow({where:{id:f.sub.id}});expect(row.status).toBe('disabled');
  const notices=await db.webhookDisabledNotificationLedger.findMany({where:{webhookId:f.sub.id}});expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({workspaceId:f.workspace.id,disableRevision:1,reason:'cursor_expired',urlHost:'receiver.example.test',attemptCount:0});
  expect(notices[0]!.operationDeadlineAt.getTime()-notices[0]!.createdAt.getTime()).toBe(23*3600_000);
  expect(await db.executionDispatch.count({where:{subjectId:`em1.w.${notices[0]!.id}`}})).toBe(1);
 });
 test('a failed intent rolls back disabling and an accepted replay repairs the original wake after lost acknowledgement',async()=>{
  const failing=db.$extends({query:{webhookDisabledNotificationLedger:{async upsert({args,query}){await query(args);throw Error('notice-intent-rollback');}}}}) as unknown as PrismaClient;
  const aborted=await fixture(failing);await expect(aborted.service.prepareSubscription(aborted.sub.id)).rejects.toThrow('notice-intent-rollback');
  expect((await db.webhookSubscription.findUniqueOrThrow({where:{id:aborted.sub.id}})).status).toBe('active');expect(await db.webhookDisabledNotificationLedger.count({where:{webhookId:aborted.sub.id}})).toBe(0);
  const f=await fixture(),deliveries:string[][]=[];
  const invoke=()=>withExecutionDispatches(()=>f.service.prepareSubscription(f.sub.id),{database:db,deliver:async ids=>{deliveries.push([...ids]);if(deliveries.length===1)throw Error('notice-wake-ack-lost');}});
  await expect(invoke()).rejects.toThrow('notice-wake-ack-lost');const before=await db.webhookDisabledNotificationLedger.findFirstOrThrow({where:{webhookId:f.sub.id}});
  await invoke();expect(deliveries).toHaveLength(2);expect(deliveries[1]).toEqual(deliveries[0]);
  expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:before.id}})).toEqual(before);expect((await db.webhookSubscription.findUniqueOrThrow({where:{id:f.sub.id}})).disableRevision).toBe(1);
 });
 test('three shared submissions retain the original sealed body, host and provider key across retry generations',async()=>{
  const f=await fixture(),n=await notice(f),calls:Array<{key:string;encrypted:string}>=[];
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async(_target,sealed,key)=>{calls.push({key,encrypted:sealed.encrypted});return{sent:false};}});
  for(let i=0;i<3;i++){
   if(i)await db.webhookDisabledNotificationLedger.update({where:{id:n.row.id},data:{nextAttemptAt:new Date(Date.now()-1),generation:{increment:1}}});
   await scoped(()=>db.$transaction(tx=>appendNotificationDelivery(tx,n.target)).then(ref=>driver.run(ref)));
  }
  expect(calls).toHaveLength(3);expect(calls[0]!.key).toBe(`webhook-disabled:${f.sub.id}:1`);expect(calls[1]).toEqual(calls[0]);expect(calls[2]).toEqual(calls[0]);
  const envelope=JSON.parse(decryptReviewValue(calls[0]!.encrypted,'webhook-mail-private-fixture-secret-long-enough'));
  expect(envelope.request.to).toBe(f.user.primaryEmail);expect(envelope.request.text).toContain('receiver.example.test');expect(envelope.request.text).not.toContain('private=hidden');
  expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'failed',attemptCount:3,operationDeadlineAt:n.row.operationDeadlineAt});
  await scoped(()=>driver.run(n.reference));expect(calls).toHaveLength(3);
  await expect(Promise.resolve(db.webhookDisabledNotificationLedger.update({where:{id:n.row.id},data:{attemptCount:0}}))).rejects.toThrow('webhook notification input is immutable');
  await expect(Promise.resolve(db.webhookDisabledNotificationLedger.update({where:{id:n.row.id},data:{operationDeadlineAt:new Date(n.row.operationDeadlineAt.getTime()+1)}}))).rejects.toThrow('webhook notification input is immutable');
 });
 test('the current authorized creator receives the notice; a removed creator falls back to the verified owner despite plan loss',async()=>{
  const f=await fixture(),n=await notice(f),creator=await db.user.create({data:{clerkId:crypto.randomUUID(),primaryEmail:'creator@example.test',emailVerifiedAt:new Date()}});users.push(creator.id);
  await db.workspaceMember.create({data:{workspaceId:f.workspace.id,userId:creator.id,role:'admin'}});await db.webhookSubscription.update({where:{id:f.sub.id},data:{createdByUserId:creator.id}});
  const recipient=async()=>JSON.parse(decryptReviewValue((await scoped(()=>prepareNotificationDelivery(n.target,null)))!.encrypted,'webhook-mail-private-fixture-secret-long-enough')).request.to;
  expect(await recipient()).toBe(creator.primaryEmail);
  await db.workspaceMember.delete({where:{workspaceId_userId:{workspaceId:f.workspace.id,userId:creator.id}}});
  await db.workspace.update({where:{id:f.workspace.id},data:{pricingTier:'free',status:'restricted'}});expect(await recipient()).toBe(f.user.primaryEmail);
  let sends=0;await scoped(()=>createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async()=>{sends++;return{sent:true};}}).run(n.reference));
  expect(sends).toBe(1);expect((await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).status).toBe('sent');
 });
 test('an unverified recipient is a typed skip, and recipient changes before admission start no submission',async()=>{
  const f=await fixture(),n=await notice(f);await db.user.update({where:{id:f.user.id},data:{emailVerifiedAt:null}});let sends=0;
  await scoped(()=>createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async()=>{sends++;return{sent:true};}}).run(n.reference));
  expect(sends).toBe(0);expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'skipped',attemptCount:0,failureCode:'context_unavailable'});
  const g=await fixture(),m=await notice(g);
  await scoped(()=>createNotificationExecution({database:db,register:async()=>{},prepare:async(target,sealed)=>{const result=await prepareNotificationDelivery(target,sealed);await db.user.update({where:{id:g.user.id},data:{primaryEmail:'changed@example.test'}});return result;},send:async()=>{sends++;return{sent:true};}}).run(m.reference));
  expect(sends).toBe(0);expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:m.row.id}})).toMatchObject({status:'skipped',attemptCount:0,failureCode:'recipient_changed'});
 });
 test('a changed recipient skips the already sealed retry instead of replacing its body or consuming another attempt',async()=>{
  const f=await fixture(),n=await notice(f);let sends=0;
  const driver=createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async()=>{sends++;return{sent:false};}});
  await scoped(()=>driver.run(n.reference));const original=await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}});
  await db.user.update({where:{id:f.user.id},data:{primaryEmail:'new-owner-email@example.test'}});
  await db.webhookDisabledNotificationLedger.update({where:{id:n.row.id},data:{nextAttemptAt:new Date(Date.now()-1),generation:{increment:1}}});
  await scoped(()=>db.$transaction(tx=>appendNotificationDelivery(tx,n.target)).then(reference=>driver.run(reference)));
  expect(sends).toBe(1);expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'skipped',attemptCount:1,deliveryInputEncrypted:original.deliveryInputEncrypted,operationDeadlineAt:original.operationDeadlineAt});
 });
 test('a missing watchdog acknowledgement starts no request and replay retains the same notice',async()=>{
  const f=await fixture(),n=await notice(f);let sends=0,lose=true;
  const driver=createNotificationExecution({database:db,prepare:prepareNotificationDelivery,register:async()=>{if(lose){lose=false;throw Error('notice-watchdog-ack-lost');}},send:async()=>{sends++;return{sent:true};}});
  await expect(scoped(()=>driver.run(n.reference))).rejects.toThrow('notice-watchdog-ack-lost');expect(sends).toBe(0);
  expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'pending',claimToken:null,attemptCount:0});
  await scoped(()=>driver.run(n.reference));expect(sends).toBe(1);
 });
 test('re-enable fences a late successful owner and a new disable receives a distinct immutable identity',async()=>{
  const f=await fixture(),n=await notice(f),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let sends=0;
  const driver=createNotificationExecution({database:db,prepare:prepareNotificationDelivery,register:async()=>{},send:async()=>{sends++;entered.resolve();await release.promise;return{sent:true};}});
  const running=scoped(()=>driver.run(n.reference));await entered.promise;
  try{
   expect((await scoped(()=>driver.run(n.reference))).kind).toBe('wait');
   await createWebhookSubscriptions({prisma:db}).enable({workspaceId:f.workspace.id,actorUserId:f.user.id},f.sub.id);
   release.resolve();expect(await running).toEqual({kind:'superseded'});expect(sends).toBe(1);
   expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({status:'claimed',attemptCount:1,sentAt:null});
   await scoped(()=>driver.run(n.reference));expect((await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).status).toBe('skipped');
   await db.webhookSubscription.update({where:{id:f.sub.id},data:{skipExpiredOnResume:false}});const next=await notice(f);expect(next.row.id).not.toBe(n.row.id);expect(next.row.disableRevision).toBe(2);
   await expect(Promise.resolve(db.webhookSubscription.update({where:{id:f.sub.id},data:{disableRevision:1}}))).rejects.toThrow('webhook disable revision is immutable');
   expect((await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).operationDeadlineAt).toEqual(n.row.operationDeadlineAt);
  }finally{release.resolve();await running;}
 });
 test('deleting a subscription before send removes its notice and denies any later owner',async()=>{
  const f=await fixture(),n=await notice(f);await db.webhookSubscription.delete({where:{id:f.sub.id}});let sends=0;
  expect(await scoped(()=>createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async()=>{sends++;return{sent:true};}}).run(n.reference))).toEqual({kind:'superseded'});
  expect(sends).toBe(0);expect(await db.webhookDisabledNotificationLedger.findUnique({where:{id:n.row.id}})).toBeNull();
 });
 test('metadata restore emits no product wakes and final redispatch preserves future due, sealed body, deadline and charged starts',async()=>{
  const f=await fixture(),n=await notice(f);await scoped(()=>createNotificationExecution({database:db,register:async()=>{},prepare:prepareNotificationDelivery,send:async()=>({sent:false})}).run(n.reference));
  const original=await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}}),rollback=Error('webhook-restore-rollback');
  await expect(db.$transaction(async tx=>{
   const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}}),fence=await tx.executionEpoch.update({where:{id:1},data:{epoch:epoch.epoch+1,admissionOpen:false,changedAt:new Date()}}),page={snapshotEpoch:epoch.epoch,fenceAboveEpoch:epoch.epoch,deploymentEpoch:fence.epoch,cutoff:fence.changedAt,after:null,limit:32};
   const count=await tx.executionDispatch.count();expect((await planWebhookNotificationRestorePage(tx,page)).dispatchIds).toEqual([]);expect(takeExecutionDispatchIds(tx)).toEqual([]);expect(await tx.executionDispatch.count()).toBe(count);
   expect(await tx.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toMatchObject({deploymentEpoch:fence.epoch,generation:original.generation+1,status:'pending',claimToken:null,attemptCount:1,deliveryInputEncrypted:original.deliveryInputEncrypted,deliveryContextFingerprint:original.deliveryContextFingerprint,operationDeadlineAt:original.operationDeadlineAt,nextAttemptAt:original.nextAttemptAt});
   const result=await planWebhookNotificationRecoveryPage(tx,page);expect(result.dispatchIds).toHaveLength(2);expect(result.processed).toBe(1);
   expect((await tx.executionDispatch.findFirstOrThrow({where:{id:{in:[...result.dispatchIds!]},wakeKind:null}})).dueAt).toEqual(original.nextAttemptAt);
   throw rollback;
  })).rejects.toBe(rollback);
  expect(await db.webhookDisabledNotificationLedger.findUniqueOrThrow({where:{id:n.row.id}})).toEqual(original);
 });
 test('recovery uses an indexed bounded cursor and excludes rows admitted after its fixed cutoff',async()=>{
  const f=await fixture(),n=await notice(f),born=n.row.createdAt;
  for(let i=2;i<=34;i++)await db.webhookDisabledNotificationLedger.create({data:{workspaceId:f.workspace.id,webhookId:f.sub.id,disableRevision:i,reason:'cursor_expired',urlHost:f.sub.urlHost,createdAt:new Date(born.getTime()+i),nextAttemptAt:new Date(born.getTime()+60000),operationDeadlineAt:new Date(born.getTime()+i+23*3600_000)}});
  const epoch=await db.executionEpoch.findUniqueOrThrow({where:{id:1}}),page={deploymentEpoch:epoch.epoch,cutoff:new Date(born.getTime()+33),after:null,limit:32};
  const first=await db.$transaction(tx=>planWebhookNotificationRecoveryPage(tx,page));expect(first.processed).toBe(32);expect(first.next).toBeTruthy();expect(first.dispatchIds).toHaveLength(64);
  const second=await db.$transaction(tx=>planWebhookNotificationRecoveryPage(tx,{...page,after:first.next}));expect(second.processed).toBe(1);expect(second.next).toBeNull();
  expect((await db.$transaction(tx=>planWebhookNotificationRecoveryPage(tx,page))).dispatchIds).toEqual(first.dispatchIds);
  await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');const plan=await tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT id FROM "WebhookDisabledNotificationLedger" WHERE status IN ('pending','claimed') AND "deploymentEpoch"=${epoch.epoch} AND "createdAt"<=${page.cutoff} ORDER BY "createdAt",id LIMIT 33`;expect(JSON.stringify(plan)).toContain('WebhookDisabledNotificationLedger_recovery_cursor');});
 });
 test('retention deletes only old terminal notices and preserves old active and fresh terminal rows',async()=>{
  const f=await fixture(),now=new Date(),rows:Array<{id:string;status:string;old:boolean}>=[];
  for(const [index,status] of ['sent','failed','skipped','pending','claimed','sent'].entries()){
   const old=index!==5,born=new Date(now.getTime()-(old?35-index:0)*86400_000),deadline=new Date(born.getTime()+23*3600_000);
   const row=await db.webhookDisabledNotificationLedger.create({data:{workspaceId:f.workspace.id,webhookId:f.sub.id,disableRevision:index+1,reason:'cursor_expired',urlHost:f.sub.urlHost,status,createdAt:born,nextAttemptAt:born,operationDeadlineAt:deadline,...(status==='claimed'?{claimToken:crypto.randomUUID(),leaseExpiresAt:deadline}:{})}});rows.push({id:row.id,status,old});
  }
  const epoch=await db.executionEpoch.findUniqueOrThrow({where:{id:1}}),page={deploymentEpoch:epoch.epoch,cutoff:now,after:null,limit:2},count=await db.executionDispatch.count();
  const first=await db.$transaction(tx=>expireWebhookNotificationRowsPage(tx,page));expect(first.processed).toBe(2);expect(first.next).toBeTruthy();expect(first.dispatchIds).toEqual([]);
  const second=await db.$transaction(tx=>expireWebhookNotificationRowsPage(tx,{...page,after:first.next}));expect(second.processed).toBe(1);expect(second.next).toBeNull();expect(second.dispatchIds).toEqual([]);
  expect(await db.webhookDisabledNotificationLedger.findMany({where:{webhookId:f.sub.id},select:{id:true},orderBy:{id:'asc'}})).toEqual(rows.filter(row=>!row.old||['pending','claimed'].includes(row.status)).map(row=>({id:row.id})).sort((a,b)=>a.id.localeCompare(b.id)));
  expect(await db.executionDispatch.count()).toBe(count);
 });
});
