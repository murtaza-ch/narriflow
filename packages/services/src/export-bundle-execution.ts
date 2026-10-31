import { randomUUID } from "node:crypto";
import { Prisma,type PrismaClient,type WorkflowRun,type ExportBundle,type ExecutionAttempt,type ExecutionArtifact } from "@prisma/client";
import { clipAspectRatioToDb,exportBundleManifestSchema,workspaceAllowsCapability } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { EXPORT_BUNDLE_OUTPUT_MAX_BYTES,type ExportBundleExecutionInput } from "@narriflow/validators/export-bundle-execution";
import { WorkflowRunLifecycle,WORKFLOW_MAX_ATTEMPTS,type WorkflowExecutionReference } from "./workflow-run-lifecycle";
import { appendExecutionDispatch,readExecutionDispatch,executionDispatchIdentity } from "./execution-dispatch";
import { takeExecutionDispatchIds,collectExecutionDispatch } from "./execution-dispatch-runtime";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { lockPlannedExecutionObject } from "./execution-object-cleanup";
import { encodeExportBundleInput,decodeExportBundleInput,exportBundleInputBinding } from "./export-bundle-input";
import type { PrivateJsonObject,PrivateJsonStorage } from "./private-json-storage";
import type { NativeValidationPreparation } from "./native-validation";
import { ExecutorControlError,createExecutorControl,type ExecutorArtifactHead } from "./executor-control";
import { appendWorkflowEvent } from "./workflow-event-append";
import { flushWorkspaceEvents } from "./workspace-event";
import type { ExecutorExpiryObservation,ExecutorExpiryResult,ExecutorArtifactCommit,ExecutorMutationContext,ExecutorMutationResult,ExecutorDomainLock,ExecutorFailureInput,ExecutorReleaseInput } from "./executor-domain-control";
import type { createExecutionStorage } from "./execution-storage";
import { createExecutionTransfer } from "./execution-transfer";
import { WorkflowFailure } from "./workflow-attempt-contract";

type Tx=Prisma.TransactionClient;
type ObjectFacts=ExportBundleExecutionInput["sources"][number]["object"];
interface Dependencies {
  toolchainFingerprint:string;
  inputStorage:Pick<PrivateJsonStorage,"write"|"read">;
  head(storageKey:string):Promise<(ObjectFacts&{storageKey:string})|null>;
  register(ids:readonly string[]):Promise<void>;
}
interface State { run:WorkflowRun;bundle:ExportBundle;now:Date;manifest:ExportBundleExecutionInput["manifest"];variants:{id:string;storageKey:string;sizeBytes:bigint}[] }
export interface ExportBundleArtifactCommit extends ExecutorArtifactCommit { input?:ExportBundleExecutionInput }
const invalid=():never=>{throw new ExecutorControlError("invalid_reference");};
const tuple=(row:Pick<ExecutionAttempt,"inputStorageKey"|"inputEtag"|"inputByteLength"|"inputChecksumSha256">):PrivateJsonObject=>{
  if(!row.inputStorageKey||!row.inputEtag||!row.inputByteLength||!row.inputChecksumSha256)return invalid();
  return {storageKey:row.inputStorageKey,etag:row.inputEtag,byteLength:Number(row.inputByteLength),sha256:row.inputChecksumSha256};
};

/** The accepted Workflow Run remains the sole owner, generation and retry ledger. */
export class ExportBundleExecution extends WorkflowRunLifecycle {
  constructor(private readonly database:PrismaClient,private readonly bundleDependencies:Dependencies){
    super({prisma:database});
    if(!/^[a-f0-9]{64}$/.test(bundleDependencies.toolchainFingerprint))throw Error("export_bundle_configuration_invalid");
  }

  private async transition<T>(operation:(tx:Tx)=>Promise<T>){
    const result=await this.database.$transaction(async tx=>{
      const value=await operation(tx);await flushWorkspaceEvents(tx);
      return {value,dispatchIds:takeExecutionDispatchIds(tx)};
    });
    if(result.dispatchIds.length)await this.bundleDependencies.register(result.dispatchIds);
    return result.value;
  }

  private async bundleState(tx:Tx,reference:ExecutionDispatchReference,verifySources=true):Promise<State|null>{
    const [epoch]=await tx.$queryRaw<Array<{epoch:number}>>`SELECT epoch FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
    const ledger=await readExecutionDispatch(tx,reference.dispatchId);
    if(!epoch||epoch.epoch!==reference.deploymentEpoch||reference.subject.kind!=="workflow_run"||!['operation_driver','modal_execution'].includes(reference.kind)||
      !ledger||JSON.stringify(ledger.reference)!==JSON.stringify(reference))return null;
    const initial=await tx.workflowRun.findUnique({where:{id:reference.subject.id}});
    if(!initial||initial.stage!=="export_bundle")return null;
    const locked=await super.lockExecution(tx,reference,initial.attemptId??reference.dispatchId);
    if(locked.kind!=="current"){
      if(['failed','cancelled','superseded'].includes(locked.disposition.disposition)){
        const run=await tx.workflowRun.findUniqueOrThrow({where:{id:initial.id}});
        await tx.$queryRaw`SELECT id FROM "ExportBundle" WHERE "workflowRunId"=${run.id}::uuid FOR UPDATE`;
        const bundle=await tx.exportBundle.findUnique({where:{workflowRunId:run.id},include:{operation:{select:{projectId:true,workflowRunId:true}}}});
        if(bundle&&run.generation===reference.generation&&run.deploymentEpoch===reference.deploymentEpoch&&bundle.deploymentEpoch===reference.deploymentEpoch&&
          bundle.operation.projectId===run.projectId&&bundle.operation.workflowRunId===run.id&&['queued','building'].includes(bundle.status)){
          const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
          if(!clock)return invalid();
          const state={run,bundle,now:clock.now,manifest:exportBundleManifestSchema.parse(bundle.manifest),variants:[]};
          const errorCode=run.errorCode??(run.status==='cancelled'?'export_bundle_cancelled':run.status==='failed'?'export_bundle_parent_failed':locked.disposition.disposition==='superseded'?'export_bundle_source_superseded':'export_bundle_source_failed');
          if(['queued','running','waiting'].includes(run.status))await this.finishFailure(tx,state,reference,errorCode);
          else{
            await this.projectFailure(tx,state,errorCode,false);
            await appendWorkflowEvent(tx,{projectId:run.projectId,workflowRunId:run.id,attemptId:run.attemptId??run.id,stage:'export_bundle',status:'failed',progress:100,errorCode,transition:'bundle_terminal_projection'},
              {progressRequired:true,analyticsEnabled:false});
          }
        }
      }
      return null;
    }
    await tx.$queryRaw`SELECT id FROM "ExportBundle" WHERE "workflowRunId"=${initial.id}::uuid FOR UPDATE`;
    const run=await tx.workflowRun.findUniqueOrThrow({where:{id:initial.id}});
    const bundle=await tx.exportBundle.findUnique({where:{workflowRunId:run.id},include:{operation:{select:{projectId:true,workspaceId:true,workflowRunId:true,actorUserId:true}}}});
    const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    if(!bundle||!clock||bundle.operation.projectId!==run.projectId||bundle.operation.workflowRunId!==run.id)return null;
    if(bundle.deploymentEpoch!==run.deploymentEpoch||['completed','failed','expired'].includes(bundle.status))return null;
    const manifest=exportBundleManifestSchema.parse(bundle.manifest);
    if(manifest.operationId!==bundle.operationId||manifest.projectId!==run.projectId)return invalid();
    if(!verifySources)return {run,bundle,now:clock.now,manifest,variants:[]};
    const project=await tx.project.findUniqueOrThrow({where:{id:run.projectId},select:{workspaceId:true}});
    const workspace=await tx.workspace.findUnique({where:{id:bundle.operation.workspaceId},select:{ownerUserId:true,status:true}});
    const actor=await tx.user.findUnique({where:{id:bundle.operation.actorUserId},select:{deletedAt:true}});
    const membership=await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:bundle.operation.workspaceId,userId:bundle.operation.actorUserId}},select:{role:true}});
    const owner=workspace?.ownerUserId===bundle.operation.actorUserId;
    if(project.workspaceId!==bundle.operation.workspaceId||!workspace||!actor||actor.deletedAt||!owner&&!membership||
      !workspaceAllowsCapability({role:owner?'owner':membership!.role,status:workspace.status},'content.download'))throw new WorkflowFailure('export_bundle_access_revoked','permanent','Bundle access is no longer available');
    const expected=manifest.included.flatMap(item=>item.files.map(file=>({...file,clipId:item.clipId,exportId:item.exportId,editorRevision:item.editorRevision})));
    const rows=await tx.clipExportVariant.findMany({where:{id:{in:expected.map(entry=>entry.variantId)},status:'completed',storageKey:{not:null},export:{projectId:run.projectId,campaignOperationItems:{some:{operationId:bundle.operationId}}}},
      select:{id:true,storageKey:true,sizeBytes:true,aspectRatio:true,export:{select:{id:true,clipId:true,editorRevision:true}}}});
    if(rows.length!==expected.length||rows.some(row=>!expected.some(entry=>entry.variantId===row.id&&entry.exportId===row.export.id&&entry.clipId===row.export.clipId&&entry.editorRevision===row.export.editorRevision&&row.aspectRatio===clipAspectRatioToDb[entry.aspectRatio]&&row.sizeBytes===BigInt(entry.sizeBytes))))throw new WorkflowFailure('export_bundle_variant_missing','permanent','A frozen bundle variant is unavailable');
    return {run,bundle,now:clock.now,manifest,variants:rows.map(row=>({id:row.id,storageKey:row.storageKey!,sizeBytes:row.sizeBytes!}))};
  }

  async loadInput(row:Pick<ExecutionAttempt,"inputStorageKey"|"inputEtag"|"inputByteLength"|"inputChecksumSha256">){
    const object=tuple(row),input=await decodeExportBundleInput(await this.bundleDependencies.inputStorage.read(object),object);
    if(input.toolchainFingerprint!==this.bundleDependencies.toolchainFingerprint)return invalid();
    return input;
  }

  override async lockExecution(tx:Tx,reference:ExecutionDispatchReference,attemptToken:string):Promise<ExecutorDomainLock<WorkflowExecutionReference>>{
    const locked=await super.lockExecution(tx,reference,attemptToken);
    if(locked.kind==='terminal'){
      await this.bundleState(tx,reference,false);
      return {...locked,dispatchIds:await this.recordedWakes(tx,reference)};
    }
    if(locked.ref.stage!=='export_bundle')return {kind:'terminal',disposition:{disposition:'superseded'}};
    let state:State|null;
    try{state=await this.bundleState(tx,reference);}catch(error){
      if(!this.knownRefusal(error))throw error;
      const current=await this.bundleState(tx,reference,false);
      return current?{kind:'terminal',disposition:{disposition:'failed',failureCode:error.code},...await this.finishFailure(tx,current,reference,error.code)}:{kind:'terminal',disposition:{disposition:'superseded'}};
    }
    if(!state)return {kind:'terminal',disposition:{disposition:'superseded'}};
    const attempt=await tx.executionAttempt.findUnique({where:{attemptToken}});
    if(!attempt||attempt.functionName!=='export_bundle'||attempt.dispatchId!==reference.dispatchId||attempt.operationDeadlineAt.getTime()!==state.bundle.operationDeadlineAt.getTime()||
      attempt.inputStorageKey!==state.bundle.inputStorageKey||attempt.inputEtag!==state.bundle.inputEtag||attempt.inputByteLength!==state.bundle.inputByteLength||attempt.inputChecksumSha256!==state.bundle.inputChecksumSha256||!state.bundle.inputBindingHash)return invalid();
    return locked;
  }

  private ownerLifecycle(owner:string){return new WorkflowRunLifecycle({prisma:this.database,leaseOwner:owner});}
  private async ownedBundle(tx:Tx,ref:WorkflowExecutionReference,context:ExecutorMutationContext){
    const state=await this.bundleState(tx,context.reference);
    if(!state||ref.id!==context.reference.subject.id||ref.attemptToken!==context.attemptToken||state.run.attemptId!==context.attemptToken||state.run.status!=='running'||
      state.run.leaseOwner!==context.owner||!state.run.leaseExpiresAt||state.run.leaseExpiresAt<=state.now||state.bundle.operationDeadlineAt<=state.now)return invalid();
    return state;
  }

  override async acquireExecution(tx:Tx,ref:WorkflowExecutionReference,context:ExecutorMutationContext):Promise<ExecutorMutationResult>{
    const result=await super.acquireExecution(tx,ref,context),state=await this.ownedBundle(tx,ref,context);
    await this.ownerLifecycle(context.owner).beginExportBundleBuildWithinTransaction(tx,{workflowRunId:ref.id,projectId:ref.projectId,stage:'export_bundle',attemptId:context.attemptToken,attemptCount:state.run.attemptCount},
      {bundleId:state.bundle.id,operationId:state.bundle.operationId,attemptStorageKey:null});
    return result;
  }

  override async commitArtifactExecution(tx:Tx,ref:WorkflowExecutionReference,context:ExecutorMutationContext,artifact:ExportBundleArtifactCommit):Promise<ExecutorMutationResult>{
    const state=await this.ownedBundle(tx,ref,context),input=artifact.input;
    if(!input||artifact.role!=='export_bundle'||artifact.contentType!=='application/zip'||artifact.byteLength<1n||artifact.byteLength>BigInt(EXPORT_BUNDLE_OUTPUT_MAX_BYTES)||
      artifact.bindingHash!==state.bundle.inputBindingHash||input.bindingHash!==artifact.bindingHash||input.bundleId!==state.bundle.id||input.workflowRunId!==ref.id||
      input.toolchainFingerprint!==this.bundleDependencies.toolchainFingerprint||JSON.stringify(input.manifest)!==JSON.stringify(state.manifest))return invalid();
    const attempt={workflowRunId:ref.id,projectId:ref.projectId,stage:'export_bundle' as const,attemptId:context.attemptToken,attemptCount:state.run.attemptCount};
    await this.ownerLifecycle(context.owner).completeExportBundleBuildWithinTransaction(tx,attempt,{bundleId:state.bundle.id,operationId:state.bundle.operationId,
      storageKey:artifact.storageKey,sizeBytes:Number(artifact.byteLength),checksumSha256:artifact.sha256,operationStatus:state.manifest.excluded.length?'partial':'completed',succeededCount:state.manifest.included.length});
    return this.completeExecutionWithinTransaction(tx,ref,context);
  }

  private knownRefusal(error:unknown):error is WorkflowFailure{return error instanceof WorkflowFailure&&['export_bundle_access_revoked','export_bundle_variant_missing','export_bundle_source_missing','export_bundle_source_changed'].includes(error.code);}
  private async projectFailure(tx:Tx,state:State,errorCode:string,retry:boolean){
    await tx.exportBundle.update({where:{id:state.bundle.id},data:{status:retry?'queued':'failed',attemptStorageKey:null,errorCode:retry?null:errorCode}});
    await tx.campaignOperationItem.updateMany({where:{operationId:state.bundle.operationId,status:{in:['pending','processing']}},data:{status:retry?'pending':'failed',errorCode:retry?null:errorCode,settledAt:retry?null:state.now}});
    await tx.campaignOperation.update({where:{id:state.bundle.operationId},data:{status:retry?'running':'failed',succeededCount:0,failedCount:retry?0:state.manifest.included.length,completedAt:retry?null:state.now}});
  }

  override async failExecution(tx:Tx,ref:WorkflowExecutionReference,context:ExecutorMutationContext,failure:ExecutorFailureInput):Promise<ExecutorMutationResult>{
    const state=await this.ownedBundle(tx,ref,context);
    await this.projectFailure(tx,state,failure.failureCode,failure.retryable&&state.run.attemptCount<WORKFLOW_MAX_ATTEMPTS);
    return super.failExecution(tx,ref,context,failure);
  }

  override async releaseExecution(tx:Tx,ref:WorkflowExecutionReference,context:ExecutorMutationContext,release:ExecutorReleaseInput):Promise<ExecutorMutationResult>{
    const state=await this.ownedBundle(tx,ref,context);await this.projectFailure(tx,state,release.reason,true);
    return super.releaseExecution(tx,ref,context,release);
  }

  override async expireExecution(tx:Tx,reference:ExecutionDispatchReference,attemptToken:string,observation:ExecutorExpiryObservation):Promise<ExecutorExpiryResult>{
    const admitted=await tx.executionAttempt.findUnique({where:{attemptToken}});
    if(!admitted||admitted.dispatchId!==reference.dispatchId||admitted.deploymentEpoch!==reference.deploymentEpoch||admitted.generation!==reference.generation||admitted.inputHash!==reference.inputHash||
      admitted.functionName!=='export_bundle'||!Number.isFinite(observation.observedDeadlineAt.getTime())||observation.kind==='operation'&&observation.observedDeadlineAt.getTime()!==admitted.operationDeadlineAt.getTime())return {kind:'superseded'};
    const state=await this.bundleState(tx,reference,false);
    if(state){
      const due=Math.min(state.bundle.operationDeadlineAt.getTime(),state.run.leaseExpiresAt?.getTime()??Infinity);
      if(due<=state.now.getTime())await this.projectFailure(tx,state,state.bundle.operationDeadlineAt<=state.now?'operation_deadline_exceeded':'worker_stalled',
        state.run.status==='running'&&state.bundle.operationDeadlineAt>state.now&&state.run.attemptCount<WORKFLOW_MAX_ATTEMPTS);
    }
    return super.expireExecution(tx,reference,attemptToken,observation);
  }

  private async recordedWakes(tx:Tx,reference:ExecutionDispatchReference){
    return (await tx.executionDispatch.findMany({where:{deploymentEpoch:reference.deploymentEpoch,generation:reference.generation,inputHash:reference.inputHash,
      kind:'operation_driver',subjectKind:'workflow_run',subjectId:reference.subject.id,wakeKind:'execution_finished'},select:{id:true},take:1})).map(row=>row.id);
  }

  private async finishFailure(tx:Tx,state:State,reference:ExecutionDispatchReference,errorCode:string){
    await this.projectFailure(tx,state,errorCode,false);
    await tx.workflowRun.update({where:{id:state.run.id},data:{status:'failed',progress:100,errorCode,leaseOwner:null,leaseExpiresAt:null,heartbeatAt:null,nextAttemptAt:null,nextPollAt:null}});
    await appendWorkflowEvent(tx,{projectId:state.run.projectId,workflowRunId:state.run.id,attemptId:state.run.attemptId??state.run.id,stage:'export_bundle',status:'failed',progress:100,errorCode,transition:'terminal:failed',analyticsRequired:true},{progressRequired:true,analyticsEnabled:true});
    const wake=await appendExecutionDispatch(tx,{...reference,kind:'operation_driver',dueAt:state.now,wakeKind:'execution_finished'});
    collectExecutionDispatch(tx,wake.reference.dispatchId);
    return {dispatchIds:[wake.reference.dispatchId]};
  }

  async expirePreparationDeadline(reference:ExecutionDispatchReference,observation:ExecutorExpiryObservation):Promise<ExecutorExpiryResult|{kind:'native';attemptToken:string}>{
    return this.transition(async tx=>{
      const record=await readExecutionDispatch(tx,reference.dispatchId);
      if(reference.kind!=='operation_driver'||observation.kind!=='operation'||record?.deadlineKind!=='operation'||JSON.stringify(record.reference)!==JSON.stringify(reference)||record.observedDeadlineAt?.getTime()!==observation.observedDeadlineAt.getTime())return {kind:'superseded'};
      const state=await this.bundleState(tx,reference,false);
      if(!state){
        const run=reference.subject.kind==='workflow_run'?await tx.workflowRun.findUnique({where:{id:reference.subject.id}}):null;
        return run&&run.generation===reference.generation&&run.deploymentEpoch===reference.deploymentEpoch&&['completed','partial','failed','cancelled'].includes(run.status)
          ?{kind:'terminal',dispatchIds:await this.recordedWakes(tx,reference)}:{kind:'superseded'};
      }
      if(state.bundle.operationDeadlineAt.getTime()!==observation.observedDeadlineAt.getTime())return {kind:'superseded'};
      if(state.run.status==='running')return state.run.attemptId&&state.run.leaseOwner&&state.run.leaseExpiresAt?{kind:'native',attemptToken:state.run.attemptId}:{kind:'superseded'};
      if(state.run.status!=='queued'||state.run.attemptId||state.run.leaseOwner||state.run.leaseExpiresAt)return {kind:'superseded'};
      if(state.bundle.operationDeadlineAt>state.now)return {kind:'sleep',dueAt:state.bundle.operationDeadlineAt};
      return {kind:'expired',...await this.finishFailure(tx,state,reference,'operation_deadline_exceeded')};
    });
  }

  async prepareExecution(reference:ExecutionDispatchReference):Promise<NativeValidationPreparation>{
    try{return await this.prepareBundle(reference);}catch(error){
      if(!this.knownRefusal(error))throw error;
      await this.transition(async tx=>{const state=await this.bundleState(tx,reference,false);if(state)await this.finishFailure(tx,state,reference,error.code);});
      return {kind:'terminal'};
    }
  }

  private async prepareBundle(reference:ExecutionDispatchReference):Promise<NativeValidationPreparation>{
    if(reference.kind!=='operation_driver')return {kind:'superseded'};
    const initial=await this.transition(async tx=>{
      const state=await this.bundleState(tx,reference,false);
      if(!state)return null;
      const watchdog=await appendExecutionDispatch(tx,{...reference,dueAt:state.bundle.operationDeadlineAt,deadlineKind:'operation',observedDeadlineAt:state.bundle.operationDeadlineAt});
      if(!state.run.operationDeadlineAt)await tx.workflowRun.update({where:{id:state.run.id},data:{operationDeadlineAt:state.bundle.operationDeadlineAt}});
      else if(state.run.operationDeadlineAt.getTime()!==state.bundle.operationDeadlineAt.getTime())return invalid();
      return {...state,watchdog};
    });
    if(!initial)return {kind:'superseded'};
    await this.bundleDependencies.register([initial.watchdog.reference.dispatchId]);
    if(initial.bundle.operationDeadlineAt<=initial.now){
      const expired=await this.expirePreparationDeadline(initial.watchdog.reference,{kind:'operation',observedDeadlineAt:initial.bundle.operationDeadlineAt});
      if(expired.kind==='native'){
        const attempt=await this.database.executionAttempt.findUnique({where:{attemptToken:expired.attemptToken}});
        const native=attempt?await readExecutionDispatch(this.database,attempt.dispatchId):null;
        if(!attempt||!native||attempt.functionName!=='export_bundle'||attempt.operationDeadlineAt.getTime()!==initial.bundle.operationDeadlineAt.getTime()||native.reference.subject.kind!=='workflow_run'||native.reference.subject.id!==reference.subject.id||
          native.reference.generation!==reference.generation||native.reference.deploymentEpoch!==reference.deploymentEpoch||native.reference.inputHash!==reference.inputHash)return invalid();
        return {kind:'waiting',deadline:{reference:native.reference,attemptToken:attempt.attemptToken,kind:'operation',observedDeadlineAt:attempt.operationDeadlineAt.toISOString()},deliveryId:initial.watchdog.reference.dispatchId,dispatchIds:[initial.watchdog.reference.dispatchId]};
      }
      return {kind:expired.kind==='superseded'?'superseded':'terminal'};
    }
    if(initial.run.nextAttemptAt&&initial.run.nextAttemptAt>initial.now)return {kind:'sleep',dueAt:new Date(Math.min(initial.run.nextAttemptAt.getTime(),initial.bundle.operationDeadlineAt.getTime()))};
    if(!initial.bundle.inputStorageKey){
      const current=await this.transition(tx=>this.bundleState(tx,reference));
      if(!current)return {kind:'superseded'};
      const objects:ObjectFacts[]=[];
      for(let offset=0;offset<current.variants.length;offset+=4){
        const batch=await Promise.all(current.variants.slice(offset,offset+4).map(async variant=>{
          const object=await this.bundleDependencies.head(variant.storageKey);
          if(!object)throw new WorkflowFailure('export_bundle_source_missing','permanent','A frozen bundle source is unavailable');
          if(object.storageKey!==variant.storageKey||BigInt(object.byteLength)!==variant.sizeBytes)throw new WorkflowFailure('export_bundle_source_changed','permanent','A frozen bundle source changed');
          return object;
        }));objects.push(...batch);
      }
      const value:Omit<ExportBundleExecutionInput,'bindingHash'>={version:1,kind:'export_bundle',bundleId:initial.bundle.id,workflowRunId:initial.run.id,toolchainFingerprint:this.bundleDependencies.toolchainFingerprint,manifest:initial.manifest,
        sources:current.variants.map((variant,index)=>({variantId:variant.id,name:`variant_${variant.id.replaceAll('-','')}`,object:objects[index]!})).sort((a,b)=>a.variantId.localeCompare(b.variantId))};
      const encoded=await encodeExportBundleInput({...value,bindingHash:await exportBundleInputBinding(value)});
      const key=await this.transition(async tx=>{
        const current=await this.bundleState(tx,reference);if(!current)return invalid();if(current.bundle.inputStorageKey)return null;
        if(current.bundle.operationDeadlineAt<=current.now){await this.finishFailure(tx,current,reference,'operation_deadline_exceeded');return null;}
        const key=`projects/${current.run.projectId}/export-bundles/${current.bundle.id}/${randomUUID()}.json`;
        await admitMediaCleanupObligations(tx,[{origin:'export_bundle_input',cleanupClass:'execution_input',projectId:current.run.projectId,objectKey:key,notBefore:new Date(current.bundle.operationDeadlineAt.getTime()+120_000)}]);
        return key;
      });
      if(key){
        const stored=await this.bundleDependencies.inputStorage.write(key,encoded.bytes);
        if(stored.byteLength!==encoded.byteLength||stored.sha256!==encoded.sha256||stored.etag.length>160||!/^"[^\r\n"]+"$/.test(stored.etag))return invalid();
        await this.transition(async tx=>{
          const current=await this.bundleState(tx,reference);if(!current)return invalid();if(current.bundle.inputStorageKey)return;
          if(current.bundle.operationDeadlineAt<=current.now){await this.finishFailure(tx,current,reference,'operation_deadline_exceeded');return;}
          if(!current.variants.every(variant=>value.sources.some(source=>source.variantId===variant.id&&source.object.storageKey===variant.storageKey&&BigInt(source.object.byteLength)===variant.sizeBytes)))throw new WorkflowFailure('export_bundle_source_changed','permanent','A frozen bundle source changed');
          await lockPlannedExecutionObject(tx,{origin:'export_bundle_input',storageKey:key});
          await tx.exportBundle.update({where:{id:current.bundle.id},data:{inputBindingHash:encoded.input.bindingHash,inputStorageKey:key,inputEtag:stored.etag,inputByteLength:BigInt(stored.byteLength),inputChecksumSha256:stored.sha256}});
        });
      }
    }
    const prepared=await this.transition(async tx=>{
      const state=await this.bundleState(tx,reference);if(!state)return null;
      if(state.bundle.operationDeadlineAt<=state.now&&state.run.status==='queued'&&!state.run.attemptId&&!state.run.leaseOwner&&!state.run.leaseExpiresAt){await this.finishFailure(tx,state,reference,'operation_deadline_exceeded');return null;}
      const object=tuple(state.bundle);
      const identity={deploymentEpoch:reference.deploymentEpoch,generation:reference.generation,kind:'modal_execution' as const,subject:reference.subject};
      const key=await executionDispatchIdentity(identity),existing=await tx.executionDispatch.findUnique({where:{deliveryKey:key.deliveryKey},select:{dueAt:true}});
      const native=await appendExecutionDispatch(tx,{...identity,inputHash:reference.inputHash,dueAt:existing?.dueAt??state.run.nextAttemptAt??state.run.createdAt});
      const attempts=await tx.executionAttempt.findMany({where:{dispatchId:native.reference.dispatchId},take:2});
      if(attempts.length>1)return invalid();
      const attempt=attempts[0]??await tx.executionAttempt.create({data:{attemptToken:randomUUID(),dispatchId:native.reference.dispatchId,deploymentEpoch:reference.deploymentEpoch,generation:reference.generation,inputHash:reference.inputHash,functionName:'export_bundle',operationDeadlineAt:state.bundle.operationDeadlineAt,inputStorageKey:object.storageKey,inputEtag:object.etag,inputByteLength:BigInt(object.byteLength),inputChecksumSha256:object.sha256}});
      if(attempt.functionName!=='export_bundle'||attempt.operationDeadlineAt.getTime()!==state.bundle.operationDeadlineAt.getTime()||attempt.inputStorageKey!==object.storageKey||attempt.inputEtag!==object.etag||attempt.inputByteLength!==BigInt(object.byteLength)||attempt.inputChecksumSha256!==object.sha256||state.run.status==='running'&&state.run.attemptId!==attempt.attemptToken)return invalid();
      return {kind:'waiting' as const,deadline:{reference:native.reference,attemptToken:attempt.attemptToken,kind:'operation' as const,observedDeadlineAt:state.bundle.operationDeadlineAt.toISOString()},deliveryId:initial.watchdog.reference.dispatchId,dispatchIds:[initial.watchdog.reference.dispatchId,native.reference.dispatchId]};
    });
    if(!prepared)return {kind:'terminal'};
    await this.bundleDependencies.register(prepared.dispatchIds);return prepared;
  }
}

/** Capsule inspection and object HEAD stay outside the domain transaction. */
export function createExportBundleExecution(options:{database:PrismaClient;domain:ExportBundleExecution;storage:ReturnType<typeof createExecutionStorage>;
  artifacts:{head(assignment:Readonly<ExecutionArtifact>):Promise<ExecutorArtifactHead|null>};deliverWakes(ids:readonly string[]):Promise<void>}){
  const control=createExecutorControl({database:options.database,subjectKind:'workflow_run',domain:options.domain,deliverWakes:options.deliverWakes,
    prepareContext:async attempt=>{const input=await options.domain.loadInput(attempt);return {source:input.bindingHash,analysis:null,toolchain:input.toolchainFingerprint};},
    artifacts:{head:options.artifacts.head,prepare:async(assignment,artifact)=>{
      const attempt=await options.database.executionAttempt.findUniqueOrThrow({where:{attemptToken:assignment.attemptToken}});
      const input=await options.domain.loadInput(attempt);return {...artifact,input};
    }}});
  const transfer=createExecutionTransfer({database:options.database,authority:control,storage:options.storage,resolvePackage:async authority=>{
    if(authority.functionName!=='export_bundle'||authority.fence.reference.kind!=='modal_execution'||authority.fence.reference.subject.kind!=='workflow_run'||!authority.input)return invalid();
    const input=await options.domain.loadInput({inputStorageKey:authority.input.storageKey,inputEtag:authority.input.etag,inputByteLength:authority.input.byteLength,inputChecksumSha256:authority.input.sha256});
    if(input.workflowRunId!==authority.fence.reference.subject.id)return invalid();
    return {input:{kind:'object'},sources:input.sources.map(source=>({name:source.name,...source.object})),initialSourceNames:[],
      outputs:[{role:'export_bundle',bindingHash:input.bindingHash,contentType:'application/zip',maxBytes:EXPORT_BUNDLE_OUTPUT_MAX_BYTES}]};
  }});
  return {control,transfer,prepareExecution:options.domain.prepareExecution.bind(options.domain)};
}
