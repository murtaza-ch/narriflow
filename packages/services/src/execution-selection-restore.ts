import { Prisma, type ClipSelectionWindow, type PrismaClient } from "@prisma/client";
import { parseStoredContentPack, type ClipSelectionInput } from "@narriflow/validators";
import type { ExecutionRestorePage, ExecutionRestorePreparedPhase } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { readWorkflowRunInputHash } from "./workflow-dispatch";
import { buildClipSelectionPlan } from "./clip-selection-plan";
import { clipSelectionTranscriptHash, type ClipSelectionObjectReference } from "./clip-selection-window";
import { decodeClipSelectionInput, decodeClipSelectionResult, encodeClipSelectionInput, encodeClipSelectionResult, clipSelectionWindowInputHash, clipSelectionBytesHash } from "./clip-selection-input";
import { SYSTEM_PROMPT, CLIP_DETECTION_JSON_SCHEMA } from "./clip-selection-policy";
import { writeClipSelectionObject, type ClipSelectionStorage } from "./clip-selection-preparation";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { lockPlannedExecutionObject,fenceRestoreObjectPut } from "./execution-object-cleanup";
import { uuidV5 } from "./uuid-v5";

type Tx=Prisma.TransactionClient;
const namespace="b9ea2d1a-8e5b-542a-8afb-b4896937355a";
const invalid=()=>new Error("restore_selection_input_unavailable");
const object=(row:ClipSelectionWindow):ClipSelectionObjectReference=>({storageKey:row.inputStorageKey,etag:row.inputEtag,sha256:row.inputChecksumSha256,byteLength:Number(row.inputByteLength)});
const hash=(value:unknown)=>clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(value)));
function immutable(row:ClipSelectionWindow){return [row.id,row.workflowRunId,row.workflowGeneration,row.deploymentEpoch,row.generation,row.transcriptId,row.transcriptGeneration,row.transcriptAttemptId,row.transcriptContentHash,row.sourceRevision,row.sourceAudioId,row.sourceAudioBindingHash,row.selectionHash,row.windowCount,row.windowIndex,row.startSec,row.endSec,row.inputHash,row.inputStorageKey,row.inputEtag,row.inputChecksumSha256,Number(row.inputByteLength),row.estimatedTokens,row.status,row.attemptToken,row.executorOwner,row.leaseExpiresAt?.toISOString(),row.operationDeadlineAt.toISOString(),row.attemptCount,row.maxAttempts,row.resultStorageKey,row.resultEtag,row.resultHash,row.resultByteLength===null?null:Number(row.resultByteLength),row.tokensUsed,row.providerRequestId,row.completedAt?.toISOString()];}
async function snapshot(tx:Tx,page:ExecutionRestorePage,lock=false){
  await assertExecutionRestorePage(tx,page);
  const after=page.after?Prisma.sql`AND (r."createdAt",r.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
  const candidates=await tx.$queryRaw<Array<{id:string;at:Date;projectId:string;workspaceId:string}>>`SELECT r.id,r."createdAt" AS at,r."projectId",p."workspaceId" FROM "WorkflowRun" r JOIN "Project" p ON p.id=r."projectId"
    WHERE r."deploymentEpoch"=${page.deploymentEpoch} AND r.stage='moment_detection' AND r."errorCode"='execution_restore_selection_pending'
      AND r."createdAt"<=(${page.cutoff}::timestamp) ${after} ORDER BY r."createdAt",r.id LIMIT 2`;
  const target=candidates[0];if(!target)return null;
  if(lock){await lockExecutionRecoveryParents(tx,[target]);await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${target.id}::uuid FOR UPDATE`;await tx.$queryRaw`SELECT id FROM "Transcript" WHERE "projectId"=${target.projectId}::uuid FOR UPDATE`;}
  const run=await tx.workflowRun.findUniqueOrThrow({where:{id:target.id},include:{project:{include:{transcript:{include:{sourceAudio:true}}}},contentPack:true}});
  const project=run.project,transcript=project.transcript;
  if(run.generation<2 || !["queued","waiting"].includes(run.status) || run.attemptId || run.leaseOwner || run.leaseExpiresAt || project.purgeStartedAt || (project.expiresAt && project.expiresAt<=page.cutoff) || !transcript || transcript.status!=="completed" || !run.contentPack || run.contentPack.draft)throw invalid();
  const old=await tx.clipSelectionWindow.findMany({where:{workflowRunId:run.id,workflowGeneration:run.generation-1,deploymentEpoch:{lte:page.snapshotEpoch}},orderBy:{windowIndex:"asc"},take:7});
  const first=old[0];if(!first || old.length>6 || old.length!==first.windowCount || old.some((row,index)=>row.windowIndex!==index || row.windowCount!==old.length || row.selectionHash!==first.selectionHash || row.inputStorageKey!==first.inputStorageKey || row.inputEtag!==first.inputEtag || row.inputChecksumSha256!==first.inputChecksumSha256 || row.inputByteLength!==first.inputByteLength))throw invalid();
  const transcriptHash=await clipSelectionTranscriptHash(transcript);
  if(old.some(row=>row.transcriptId!==transcript.id || row.transcriptGeneration!==transcript.selectionGeneration || row.transcriptAttemptId!==transcript.workflowAttemptId || row.transcriptContentHash!==transcriptHash || row.sourceRevision!==project.sourceRevision || transcript.sourceRevision!==project.sourceRevision || row.sourceAudioId!==transcript.sourceAudioId || row.sourceAudioBindingHash!==(transcript.sourceAudio?.bindingHash??null)))throw invalid();
  const base=await tx.executionDispatch.findFirst({where:{kind:"operation_driver",subjectKind:"workflow_run",subjectId:run.id,deploymentEpoch:first.deploymentEpoch,generation:first.workflowGeneration,wakeKind:null,deadlineKind:null},orderBy:{createdAt:"asc"},select:{inputHash:true}});
  if(!base)throw invalid();
  return {target,next:candidates.length>1?target:null,old,oldParent:{id:run.id,projectId:run.projectId,generation:first.workflowGeneration,deploymentEpoch:first.deploymentEpoch,inputHash:base.inputHash},
    parent:{id:run.id,projectId:run.projectId,generation:run.generation,deploymentEpoch:run.deploymentEpoch,inputHash:await readWorkflowRunInputHash(tx,run,project.sourceRevision)},
    pack:parseStoredContentPack(run.contentPack),transcriptHash};
}
interface Adoption { target:{id:string;at:Date};next:{id:string;at:Date}|null;parentGeneration:number;oldHash:string;keys:string[];rows:Prisma.ClipSelectionWindowCreateManyInput[] }
function transition(prepared:Adoption):Awaited<ReturnType<ExecutionRestorePreparedPhase>>{
  return {async apply(tx,page){
    const current=await snapshot(tx,page,true);
    if(!current || current.target.id!==prepared.target.id || current.parent.generation!==prepared.parentGeneration || await hash(current.old.map(immutable))!==prepared.oldHash)throw invalid();
    for(const storageKey of prepared.keys.slice().sort())await lockPlannedExecutionObject(tx,{origin:"selection_execution",storageKey});
    if(await tx.clipSelectionWindow.count({where:{workflowRunId:current.parent.id,workflowGeneration:current.parent.generation}}))throw invalid();
    await tx.clipSelectionWindow.createMany({data:prepared.rows});
    await tx.clipSelectionWindow.updateMany({where:{id:{in:current.old.filter(row=>["queued","running"].includes(row.status)).map(row=>row.id)}},data:{status:"cancelled",executorOwner:null,leaseExpiresAt:null,completedAt:page.cutoff,errorCode:"execution_epoch_restored"}});
    await tx.workflowRun.update({where:{id:current.parent.id},data:{status:"waiting",errorCode:null,attemptId:null,leaseOwner:null,leaseExpiresAt:null,heartbeatAt:null,nextAttemptAt:null}});
    return {processed:1,next:prepared.next,dispatchIds:[]};
  }};
}
/** One parent / at most six windows. Only JSON objects are rewritten; a
 * successful paid result is never permission for another provider request. */
export function createSelectionRestorePreparation(options:{database:PrismaClient;storage:ClipSelectionStorage}):ExecutionRestorePreparedPhase{
  return async(_reference,page)=>{
    const state=await options.database.$transaction(tx=>snapshot(tx,page));
    if(!state)return {apply:async()=>({processed:0,next:null,dispatchIds:[]})};
    const first=state.old[0]!,prior=object(first),input=await decodeClipSelectionInput(await options.storage.read(prior),prior,state.oldParent);
    if(input.systemPrompt!==SYSTEM_PROMPT || input.responseSchemaHash!==await clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(CLIP_DETECTION_JSON_SCHEMA))) ||
      (await encodeClipSelectionInput({...input,planning:{...input.planning,contentPack:state.pack}})).sha256!==first.selectionHash || input.transcript.contentHash!==state.transcriptHash)throw invalid();
    if(input.transcript.id!==first.transcriptId || input.transcript.generation!==first.transcriptGeneration || input.transcript.attemptId!==first.transcriptAttemptId || input.transcript.sourceRevision!==first.sourceRevision || input.transcript.sourceAudioId!==first.sourceAudioId || input.transcript.sourceAudioBindingHash!==first.sourceAudioBindingHash)throw invalid();
    const plan=buildClipSelectionPlan(input.planning),windows=plan.kind==="selection"?plan.windows:[{windowIndex:0,startSec:plan.clips[0]!.startSec,endSec:plan.clips[0]!.endSec}];
    if(windows.length!==state.old.length || state.old.some((row,index)=>row.windowIndex!==windows[index]!.windowIndex || row.startSec!==windows[index]!.startSec || row.endSec!==windows[index]!.endSec))throw invalid();
    // Caption/mode/prompt/guidance stay exactly as admitted in the capsule;
    // mutable Project summaries or brand defaults cannot rewrite them on replay.
    const encoded=await encodeClipSelectionInput({...input,parent:state.parent} as ClipSelectionInput),inputKey=`projects/${state.parent.projectId}/selection/${state.parent.id}/${crypto.randomUUID()}/${encoded.sha256}.json`;
    const results: Array<{row:ClipSelectionWindow;id:string;inputHash:string;bytes:Awaited<ReturnType<typeof encodeClipSelectionResult>>|null;key:string|null}>=[];
    for(const row of state.old){
      const id=uuidV5(namespace,JSON.stringify([page.deploymentEpoch,state.parent.id,state.parent.generation,row.windowIndex]));
      const inputHash=await clipSelectionWindowInputHash({selectionHash:encoded.sha256,windowIndex:row.windowIndex,startSec:row.startSec,endSec:row.endSec});
      let bytes:Awaited<ReturnType<typeof encodeClipSelectionResult>>|null=null;
      if(row.status==="completed"){
        if(!row.resultStorageKey || !row.resultEtag || !row.resultHash || row.resultByteLength===null)throw invalid();
        const reference={storageKey:row.resultStorageKey,etag:row.resultEtag,sha256:row.resultHash,byteLength:Number(row.resultByteLength)};
        const result=await decodeClipSelectionResult(await options.storage.read(reference),reference,{parentId:row.workflowRunId,parentGeneration:row.workflowGeneration,selectionHash:row.selectionHash,windowIndex:row.windowIndex});
        if(result.tokensUsed!==row.tokensUsed || result.providerRequestId!==row.providerRequestId)throw invalid();
        bytes=await encodeClipSelectionResult({parentId:state.parent.id,parentGeneration:state.parent.generation,selectionHash:encoded.sha256,windowIndex:row.windowIndex},JSON.stringify({clips:result.clips}),{tokensUsed:result.tokensUsed,providerRequestId:result.providerRequestId});
      }
      results.push({row,id,inputHash,bytes,key:bytes?`execution/${page.deploymentEpoch}/clip_selection_window/${id}/${row.generation+1}/server/selection_window/${crypto.randomUUID()}/${bytes.sha256}.json`:null});
    }
    const keys=[inputKey,...results.flatMap(item=>item.key?[item.key]:[])];
    await options.database.$transaction(async tx=>{
      const current=await snapshot(tx,page,true);if(!current || current.target.id!==state.target.id || await hash(current.old.map(immutable))!==await hash(state.old.map(immutable)))throw invalid();
      const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;if(!clock)throw invalid();
      const notBefore=new Date(Math.max(clock.now.getTime()+120_000,...state.old.map(row=>row.operationDeadlineAt.getTime()+120_000)));
      await admitMediaCleanupObligations(tx,keys.map(objectKey=>({origin:"selection_execution",cleanupClass:"execution_input",projectId:state.parent.projectId,objectKey,notBefore})),{deferDispatch:true});
    });
    await options.database.$transaction(tx=>fenceRestoreObjectPut(tx,page,{origin:"selection_execution",storageKey:inputKey}));
    const adoptedInput=await writeClipSelectionObject(options.storage,inputKey,encoded),rows:Prisma.ClipSelectionWindowCreateManyInput[]=[];
    for(const item of results){
      if(item.bytes)await options.database.$transaction(tx=>fenceRestoreObjectPut(tx,page,{origin:"selection_execution",storageKey:item.key!}));
      const row=item.row,result=item.bytes?await writeClipSelectionObject(options.storage,item.key!,item.bytes):null;
      rows.push({id:item.id,projectId:row.projectId,workflowRunId:row.workflowRunId,workflowGeneration:state.parent.generation,deploymentEpoch:page.deploymentEpoch,generation:row.generation+1,
        transcriptId:row.transcriptId,transcriptGeneration:row.transcriptGeneration,transcriptAttemptId:row.transcriptAttemptId,transcriptContentHash:row.transcriptContentHash,sourceRevision:row.sourceRevision,sourceAudioId:row.sourceAudioId,sourceAudioBindingHash:row.sourceAudioBindingHash,
        selectionHash:encoded.sha256,windowCount:row.windowCount,windowIndex:row.windowIndex,startSec:row.startSec,endSec:row.endSec,inputHash:item.inputHash,inputStorageKey:adoptedInput.storageKey,inputEtag:adoptedInput.etag,inputChecksumSha256:adoptedInput.sha256,inputByteLength:BigInt(adoptedInput.byteLength),estimatedTokens:row.estimatedTokens,
        status:row.status==="completed"?"completed":["failed","cancelled"].includes(row.status)?row.status:"queued",operationDeadlineAt:row.operationDeadlineAt,attemptCount:row.attemptCount,maxAttempts:row.maxAttempts,providerQueuedAt:row.providerQueuedAt,lastProviderStartedAt:row.lastProviderStartedAt,providerRequestId:row.providerRequestId,retryAt:row.retryAt,errorCode:["failed","cancelled"].includes(row.status)?row.errorCode:null,
        completedAt:["completed","failed","cancelled"].includes(row.status)?row.completedAt:null,
        ...(result?{resultStorageKey:result.storageKey,resultEtag:result.etag,resultHash:result.sha256,resultByteLength:BigInt(result.byteLength),tokensUsed:row.tokensUsed,completedAt:row.completedAt}:{}),createdAt:row.createdAt});
    }
    return transition({target:state.target,next:state.next,parentGeneration:state.parent.generation,oldHash:await hash(state.old.map(immutable)),keys,rows});
  };
}
