import {appendPublicationExportWake,createPublicationProducers} from "./publication-producers";
import type {PublicationRetryPolicy} from "./social-publication-attempt";
import {createHash,randomUUID} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import type {ExecutorFence} from '@narriflow/validators/execution';
import {PublicationExecution} from './publication-execution';
import {createPublicationCheckpointCipher} from './social-publication-checkpoint-cipher';
import {publicationPlanRefusal,hasCustomThumbnail} from './social-account-eligibility';
import {appendPublicationDispatch} from './publication-dispatch';
import {readExecutionDispatch} from './execution-dispatch';
import {createExecutorControl} from './executor-control';
import {withObservationTestClock} from './publication-observation-test-support';
import type {OwnedPublicationAttempt} from './social-publication-attempt';
interface Configuration{batchSize:number;leaseMs:number;processingDeadlineMs:number;reconciliationDeadlineMs:number;providerCallBudget:number;retry?:PublicationRetryPolicy}
const stores=new WeakMap<PrismaClient,Map<string,{etag:string;sha256:string;byteLength:number}>>(),fences=new WeakMap<PrismaClient,Map<string,ExecutorFence>>();
/** Drives only accepted IDs supplied by this fixture. Actual domain/Core SQL
 * owns claims and counters; the private object store is the injected boundary. */
export function createPublicationTestRuntime(database:PrismaClient,known:ReadonlySet<string>,config:Configuration){
 let objects=stores.get(database);if(!objects){objects=new Map();stores.set(database,objects);}let owners=fences.get(database);if(!owners){owners=new Map();fences.set(database,owners);}
 function runtime(at:Date){
  const db=withObservationTestClock(database,at),domain=new PublicationExecution(db,{
   config:{operationDeadlineMs:config.processingDeadlineMs,providerCallBudget:config.providerCallBudget,processingDeadlineMs:config.processingDeadlineMs,reconciliationDeadlineMs:config.reconciliationDeadlineMs,retry:config.retry??{maxAttempts:4,maxElapsedMs:config.processingDeadlineMs,baseDelayMs:1000,maxDelayMs:60000,jitterRatio:0,random:()=>0}},
   checkpointCipher:createPublicationCheckpointCipher(Buffer.alloc(32,7).toString('base64')),
   planRefusal:(tx,post)=>publicationPlanRefusal(tx,{workspaceId:post.workspaceId!,socialAccountId:post.socialAccountId,customThumbnail:hasCustomThumbnail(post.frozenState!.providerSettings as never)}),
   buildInput:async snapshot=>({bytes:new TextEncoder().encode(JSON.stringify({postId:snapshot.post.id,attemptId:snapshot.attempt.id,claimId:snapshot.claim.id,nonce:(snapshot.claim.workState as {nonce:string}).nonce})),sources:[]}),
   inputStorage:{head:async plan=>objects!.get(plan.storageKey)??null,put:async plan=>{objects!.set(plan.storageKey,{etag:'"test-private"',sha256:plan.sha256,byteLength:plan.byteLength});}},register:async()=>{},
  });
  const control=createExecutorControl({database:db,domain,subjectKind:'social_publication',deliverWakes:async()=>{}});
  const call=(command:unknown)=>control.execute({command,verifiedRequest:{requestHash:createHash('sha256').update(JSON.stringify(command)).digest('hex'),metadata:{version:1,keyId:'publication-fixture',audience:'executor-control',method:'POST',canonicalTarget:'/api/execution/command',bodySha256:'0'.repeat(64),timestamp:Math.floor(at.getTime()/1000),deliveryId:randomUUID(),signature:'0'.repeat(64)}}});
  return{db,domain,call};
 }
 async function prepare(postId:string,at:Date){const r=runtime(at),id=await r.db.$transaction(tx=>appendPublicationDispatch(tx,postId));return{...r,prepared:await r.domain.prepareExecution((await readExecutionDispatch(r.db,id))!.reference)};}
 return{
  async claimKnown(input:{now:Date;config?:Configuration}){
   const ids=await database.socialPost.findMany({where:{id:{in:[...known]}},orderBy:[{scheduledFor:'asc'},{id:'asc'}],select:{id:true}}),claimed:OwnedPublicationAttempt[]=[];
   for(const post of ids){
    const r=await prepare(post.id,input.now);if(r.prepared.kind!=='waiting')continue;
    const fence={reference:r.prepared.deadline.reference,attemptToken:r.prepared.deadline.attemptToken,owner:randomUUID()},result=await r.call({action:'acquire',reference:fence.reference,attemptToken:fence.attemptToken,owner:fence.owner,leaseSeconds:Math.max(1,Math.floor(config.leaseMs/1000))});
    if(result.disposition!=='acquired')continue;
    await r.call({action:'process-start',fence});owners!.set(fence.attemptToken,fence);
    const claim=await database.publicationClaim.findUniqueOrThrow({where:{id:fence.attemptToken}});claimed.push({attemptId:claim.attemptId,claimId:claim.id});
    if(claimed.length>=(input.config?.batchSize??config.batchSize))break;
   }
   return claimed;
  },
  async renewKnown(input:{owned:OwnedPublicationAttempt;now:Date;leaseMs:number}){
   const fence=owners!.get(input.owned.claimId);if(!fence)throw Error('Unknown fixture owner');return runtime(input.now).call({action:'renew',fence,leaseSeconds:Math.max(1,Math.floor(input.leaseMs/1000))});
  },
  async commandKnown(input:{owned:OwnedPublicationAttempt;now:Date;command:unknown}){
   const fence=owners!.get(input.owned.claimId);if(!fence)throw Error('Unknown fixture owner');
   return runtime(input.now).call({action:'publication-command',fence,command:input.command});
  },
  async observeKnown(at:Date){
   const db=withObservationTestClock(database,at),producer=createPublicationProducers({database:db,register:async()=>{}});
   const states=await db.frozenPublicationState.findMany({where:{socialPostId:{in:[...known]}},select:{clipExportVariantId:true}});
   for(const state of states){const id=await db.$transaction(tx=>appendPublicationExportWake(tx,state.clipExportVariantId));if(id)await producer.dispatch((await readExecutionDispatch(db,id))!.reference);}
  },
 };
}
