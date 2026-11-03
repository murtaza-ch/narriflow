import { Prisma,type ClipPreparation,type PrismaClient } from "@prisma/client";
import { clipPreparationReadyObjectsSchema,clipPreparationObjectSchema,type ClipPreparationInput,type ClipPreparationResult,type ClipPreparationObject } from "@narriflow/validators/clip-preparation";
import type { ExecutionRestorePage,ExecutionRestorePreparedPhase,ExecutionRestorePhaseHandler } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
import { lockExecutionRecoveryParents } from "./execution-recovery-locks";
import { ClipPreparationService,clipPreparationExecutionInputHash,validateClipPreparationManifest } from "./clip-preparation";
import { decodeClipPreparationInput,encodeClipPreparationInput,encodeClipPreparationResult } from "./clip-preparation-input";
import { derivePeaksStorageKey } from "./clip-preview-storage";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { lockPlannedExecutionObject,fenceRestoreObjectPut } from "./execution-object-cleanup";
import type { PrivateJsonStorage } from "./private-json-storage";
import { clipSelectionBytesHash } from "./clip-selection-input";

type Tx=Prisma.TransactionClient;
const invalid=()=>Error("restore_preparation_input_unavailable");
const fingerprint=(job:ClipPreparation)=>clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify([job.id,job.deploymentEpoch,job.generation,job.bindingHash,job.engineHash,job.inputHash,job.inputStorageKey,job.inputEtag,Number(job.inputByteLength),job.inputChecksumSha256,job.status,job.attemptToken,job.executorOwner,job.leaseExpiresAt?.toISOString(),job.operationDeadlineAt.toISOString(),job.retryAt?.toISOString(),job.createdAt.toISOString(),job.chargedAttempts,job.result,job.readyObjects,job.errorCode,job.completedAt?.toISOString()])));
async function snapshot(tx:Tx,page:ExecutionRestorePage,service:ClipPreparationService,lock=false){
  await assertExecutionRestorePage(tx,page);
  const after=page.after?Prisma.sql`AND (job."createdAt",job.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
  const candidates=await tx.$queryRaw<Array<{id:string;at:Date;projectId:string;workspaceId:string}>>`SELECT job.id,job."createdAt" AS at,job."projectId",p."workspaceId" FROM "ClipPreparation" job JOIN "Project" p ON p.id=job."projectId"
    WHERE job."deploymentEpoch"<=${page.snapshotEpoch} AND job.status IN ('queued','running','completed','failed')
      AND job."createdAt"<=(${page.cutoff}::timestamp)
      AND NOT EXISTS(SELECT 1 FROM "ClipPreparation" current WHERE current."clipId"=job."clipId" AND current."bindingHash"=job."bindingHash" AND current."deploymentEpoch"=${page.deploymentEpoch})
      AND (job.status IN ('queued','running') OR EXISTS(SELECT 1 FROM "RenderGroup" g JOIN "WorkflowRun" r ON r.id=g."workflowRunId" WHERE g."clipId"=job."clipId" AND g."deploymentEpoch"=${page.deploymentEpoch} AND g.status='queued' AND r.status='queued' AND NOT EXISTS(SELECT 1 FROM "RenderGroupMember" m WHERE m."groupId"=g.id AND m."invalidatedAt" IS NOT NULL) AND p."sourceRevision"=job."sourceRevision" AND (g."exportIdentity"::jsonb->>2)=job."editorRevision"::text))
      ${after} ORDER BY job."createdAt",job.id LIMIT 2`;
  const target=candidates[0];if(!target)return null;
  if(lock)await lockExecutionRecoveryParents(tx,[target]);
  const job=await tx.clipPreparation.findUniqueOrThrow({where:{id:target.id}});
  const groups=await tx.$queryRaw<Array<{id:string}>>`SELECT g.id FROM "RenderGroup" g JOIN "WorkflowRun" r ON r.id=g."workflowRunId" JOIN "Project" p ON p.id=r."projectId"
    WHERE g."clipId"=${job.clipId}::uuid AND g."deploymentEpoch"=${page.deploymentEpoch} AND g.status='queued' AND r.status='queued'
      AND NOT EXISTS(SELECT 1 FROM "RenderGroupMember" m WHERE m."groupId"=g.id AND m."invalidatedAt" IS NOT NULL) AND p."sourceRevision"=${job.sourceRevision} AND p."purgeStartedAt" IS NULL AND (p."expiresAt" IS NULL OR p."expiresAt">(${page.cutoff}::timestamp))
      AND (g."exportIdentity"::jsonb->>2)=${String(job.editorRevision)} ORDER BY g.id LIMIT 1`;
  const group=groups[0],desired=group?await service.restoreInputForGroup(tx,group.id,page):null;
  if(desired && desired.input.bindingHash!==job.bindingHash)throw invalid();
  if(lock)await tx.$queryRaw`SELECT id FROM "ClipPreparation" WHERE id=${job.id}::uuid FOR UPDATE`;
  return {target,next:candidates.length>1?target:null,job,desired};
}
async function validateObjects(tx:Tx,job:ClipPreparation,result:ClipPreparationResult){
  const objects=clipPreparationReadyObjectsSchema.parse(job.readyObjects);
  const expected=[{id:result.preview.artifactId,role:"clip_preview",contentType:"video/mp4",object:objects.preview},...(result.peaks.state==="ready"?[{id:result.peaks.artifactId,role:"preview_peaks",contentType:"application/json",object:objects.peaks}]:[])];
  if((result.peaks.state==="ready")!==(objects.peaks!==null) || (objects.peaks && objects.peaks.storageKey!==derivePeaksStorageKey(objects.preview.storageKey)))throw invalid();
  const artifacts=await tx.executionArtifact.findMany({where:{id:{in:expected.map(row=>row.id)}}});
  for(const item of expected){const artifact=artifacts.find(row=>row.id===item.id);if(!item.object || !artifact?.committedAt || artifact.role!==item.role || artifact.bindingHash!==job.bindingHash || artifact.contentType!==item.contentType || artifact.storageKey!==item.object.storageKey || artifact.etag!==item.object.etag || artifact.checksumSha256!==item.object.sha256 || artifact.byteLength!==BigInt(item.object.byteLength))throw invalid();}
  const manifest=await tx.executionArtifact.findUnique({where:{storageKey:objects.manifest.storageKey}});
  if(manifest){if(!manifest.committedAt || manifest.role!=="layout_evidence" || manifest.bindingHash!==job.bindingHash || manifest.etag!==objects.manifest.etag || manifest.checksumSha256!==objects.manifest.sha256 || manifest.byteLength!==BigInt(objects.manifest.byteLength))throw invalid();}
  else {
    const prefix=`projects/${job.projectId}/preparations/${job.id}/`;
    const planned=await tx.mediaCleanupObligation.findUnique({where:{origin_cleanupClass_objectKey:{origin:"clip_preparation_input",cleanupClass:"execution_input",objectKey:objects.manifest.storageKey}}});
    if(!objects.manifest.storageKey.startsWith(prefix) || objects.manifest.storageKey===job.inputStorageKey || !planned || planned.attemptCount || planned.claimId || planned.completedAt)throw invalid();
  }
  return objects;
}
interface Adoption {target:{id:string;at:Date};next:{id:string;at:Date}|null;oldHash:string;input:ClipPreparationInput|null;inputObject:ClipPreparationObject|null;result:ClipPreparationResult|null;objects:Prisma.InputJsonValue|null;keys:string[];failed:boolean}
function transition(options:{service:ClipPreparationService},prepared:Adoption):Awaited<ReturnType<ExecutionRestorePreparedPhase>>{
  return {async apply(tx,page){
    const current=await snapshot(tx,page,options.service,true);if(!current || current.target.id!==prepared.target.id || await fingerprint(current.job)!==prepared.oldHash)throw invalid();
    const {job}=current;
    if(prepared.input){
      if(!current.desired || (await encodeClipPreparationInput(current.desired.input)).sha256!==prepared.inputObject?.sha256)throw invalid();
      for(const storageKey of prepared.keys.slice().sort())await lockPlannedExecutionObject(tx,{origin:"clip_preparation_input",storageKey});
      const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;if(!clock)throw invalid();
      const failed=prepared.failed || (!prepared.result && (job.operationDeadlineAt<=clock.now || job.chargedAttempts>=3));
      await tx.clipPreparation.create({data:{id:prepared.input.preparationId,projectId:job.projectId,clipId:job.clipId,sourceRevision:job.sourceRevision,editorRevision:job.editorRevision,bindingHash:job.bindingHash,engineHash:job.engineHash,
        inputHash:clipPreparationExecutionInputHash(prepared.input.preparationId,job.bindingHash),inputStorageKey:prepared.inputObject!.storageKey,inputEtag:prepared.inputObject!.etag,inputByteLength:BigInt(prepared.inputObject!.byteLength),inputChecksumSha256:prepared.inputObject!.sha256,
        deploymentEpoch:page.deploymentEpoch,generation:job.generation+1,operationDeadlineAt:job.operationDeadlineAt,chargedAttempts:job.chargedAttempts,createdAt:job.createdAt,
        status:prepared.result?"completed":failed?"failed":"queued",completedAt:prepared.result?job.completedAt:failed?clock.now:null,retryAt:failed||prepared.result?null:job.retryAt,
        result:prepared.result as unknown as Prisma.InputJsonValue??Prisma.DbNull,readyObjects:prepared.objects??Prisma.DbNull,errorCode:failed?(job.errorCode??"clip_preparation_deadline"):null}});
    }
    if(["queued","running"].includes(job.status))await tx.clipPreparation.update({where:{id:job.id},data:{status:"superseded",executorOwner:null,leaseExpiresAt:null,completedAt:page.cutoff,errorCode:"execution_epoch_restored"}});
    return {processed:1,next:prepared.next,dispatchIds:[]};
  }};
}
export function createPreparationRestorePreparation(options:{database:PrismaClient;storage:PrivateJsonStorage;service:ClipPreparationService}):ExecutionRestorePreparedPhase{
  return async(_reference,page)=>{
    const state=await options.database.$transaction(tx=>snapshot(tx,page,options.service));if(!state)return {apply:async()=>({processed:0,next:null,dispatchIds:[]})};
    const job=state.job,oldHash=await fingerprint(job);
    if(!state.desired)return transition(options,{target:state.target,next:state.next,oldHash,input:null,inputObject:null,result:null,objects:null,keys:[],failed:false});
    const oldReference={storageKey:job.inputStorageKey,etag:job.inputEtag,byteLength:Number(job.inputByteLength),sha256:job.inputChecksumSha256};
    const old=await decodeClipPreparationInput(await options.storage.read(oldReference),oldReference),input=state.desired.input,encoded=await encodeClipPreparationInput(input);
    if(job.inputHash!==clipPreparationExecutionInputHash(job.id,job.bindingHash) || old.preparationId!==job.id || old.bindingHash!==job.bindingHash || (await encodeClipPreparationInput({...old,preparationId:input.preparationId})).sha256!==encoded.sha256)throw invalid();
    const result=job.status==="completed"?validateClipPreparationManifest(old,job.result as unknown as ClipPreparationResult):null;
    const oldObjects=result?await options.database.$transaction(async tx=>{await assertExecutionRestorePage(tx,page);return validateObjects(tx,job,result);}):null;
    const rewritten=result?await encodeClipPreparationResult({...result,preparationId:input.preparationId}):null;
    const inputKey=`projects/${job.projectId}/preparations/${input.preparationId}/${crypto.randomUUID()}.json`,manifestKey=rewritten?`projects/${job.projectId}/preparations/${input.preparationId}/${crypto.randomUUID()}.json`:null,keys=[inputKey,...(manifestKey?[manifestKey]:[])];
    await options.database.$transaction(async tx=>{
      const current=await snapshot(tx,page,options.service,true);if(!current || current.target.id!==state.target.id || await fingerprint(current.job)!==oldHash)throw invalid();
      const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;if(!clock)throw invalid();
      await admitMediaCleanupObligations(tx,keys.map(objectKey=>({origin:"clip_preparation_input",cleanupClass:"execution_input",projectId:job.projectId,clipId:job.clipId,objectKey,notBefore:new Date(Math.max(clock.now.getTime()+120000,job.operationDeadlineAt.getTime()+120000))})),{deferDispatch:true});
    });
    await options.database.$transaction(tx=>fenceRestoreObjectPut(tx,page,{origin:"clip_preparation_input",storageKey:inputKey}));
    const measured=await options.storage.write(inputKey,encoded.bytes);if(measured.byteLength!==encoded.byteLength || measured.sha256!==encoded.sha256)throw invalid();
    const inputObject=clipPreparationObjectSchema.parse({storageKey:inputKey,...measured});let objects:Prisma.InputJsonValue|null=null;
    if(rewritten){await options.database.$transaction(tx=>fenceRestoreObjectPut(tx,page,{origin:"clip_preparation_input",storageKey:manifestKey!}));const manifest=await options.storage.write(manifestKey!,rewritten.bytes);if(manifest.byteLength!==rewritten.byteLength || manifest.sha256!==rewritten.sha256)throw invalid();objects=clipPreparationReadyObjectsSchema.parse({...oldObjects!,manifest:{storageKey:manifestKey!,...manifest}}) as Prisma.InputJsonValue;}
    return transition(options,{target:state.target,next:state.next,oldHash,input,inputObject,result:rewritten?.result??null,objects,keys,failed:job.status==="failed"});
  };
}


/** Seals every surviving Group link in bounded metadata pages before any
 * restored preparation driver is registered. A never-prepared/video-waiting
 * Group remains unowned and follows normal first admission after resume. */
export function createPreparationLinkRestore(service:ClipPreparationService):ExecutionRestorePhaseHandler{
  return async(tx,page)=>{
    await assertExecutionRestorePage(tx,page);
    const limit=Math.min(page.limit,8),after=page.after?Prisma.sql`AND (g."createdAt",g.id)>((${page.after.at}::timestamp),${page.after.id}::uuid)`:Prisma.empty;
    const rows=await tx.$queryRaw<Array<{id:string;at:Date;projectId:string;workspaceId:string;workflowRunId:string}>>`SELECT g.id,g."createdAt" AS at,r."projectId",p."workspaceId",r.id AS "workflowRunId" FROM "RenderGroup" g JOIN "WorkflowRun" r ON r.id=g."workflowRunId" JOIN "Project" p ON p.id=r."projectId"
      WHERE g."deploymentEpoch"=${page.deploymentEpoch} AND g.status='queued' AND g."preparationId" IS NULL AND g."attemptToken" IS NULL
        AND p."ingestStatus"='ready' AND p."sourceStorageKey" IS NOT NULL AND p."purgeStartedAt" IS NULL
        AND (p."expiresAt" IS NULL OR p."expiresAt">(${page.cutoff}::timestamp))
        AND NOT EXISTS(SELECT 1 FROM "RenderGroupMember" m WHERE m."groupId"=g.id AND m."invalidatedAt" IS NOT NULL)
        AND g."createdAt"<=(${page.cutoff}::timestamp) ${after} ORDER BY g."createdAt",g.id LIMIT ${limit+1}`;
    const selected=rows.slice(0,limit);await lockExecutionRecoveryParents(tx,selected);
    for(const id of [...new Set(selected.map(row=>row.workflowRunId))].sort())await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${id}::uuid FOR UPDATE`;
    for(const row of [...selected].sort((a,b)=>a.id.localeCompare(b.id))){
      const desired=await service.restoreInputForGroup(tx,row.id,page),job=await tx.clipPreparation.findUnique({where:{id:desired.input.preparationId}});
      if(!job)continue;
      if(job.deploymentEpoch!==page.deploymentEpoch || job.bindingHash!==desired.input.bindingHash || job.inputChecksumSha256!==(await encodeClipPreparationInput(desired.input)).sha256)throw invalid();
      await tx.renderGroup.update({where:{id:row.id},data:{preparationId:job.id}});
    }
    return {processed:selected.length,next:rows.length>limit?{at:selected.at(-1)!.at,id:selected.at(-1)!.id}:null,dispatchIds:[]};
  };
}
