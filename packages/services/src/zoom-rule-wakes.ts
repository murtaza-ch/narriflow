import type { Prisma,PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema,type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch,executionDispatchIdentity,readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
import { executeExecutionPage } from "./execution-page-receipt";
import { operationFingerprint } from "./operation-receipt";
import { lockWorkspaceUsage } from "./processing-usage";
import { recoverZoomNotification } from "./zoom-execution";
type Tx=Prisma.TransactionClient;
type Position={at:Date;id:string};
const PAGE=32,pattern=/^zw1\.([a-f0-9]{32})\.([a-f0-9]{32})\.(d|[1-9][0-9]{0,9})(?:\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32}))?$/;
const compact=(id:string)=>id.replaceAll("-","");
const uuid=(id:string)=>`${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
function subject(workspaceId:string,ruleId:string,version:string,after:Position|null=null){return `zw1.${compact(workspaceId)}.${compact(ruleId)}.${version}${after?`.${after.at.getTime()}.${compact(after.id)}`:""}`;}
function fingerprint(epoch:number,id:string,cutoff:Date){return operationFingerprint(["zoom-rule-wake-v1",epoch,id,cutoff.toISOString()]);}
async function append(tx:Tx,input:{workspaceId:string;ruleId:string;version:string;after?:Position|null;cutoff?:Date;repairOnly?:boolean}){
  const {epoch}=await readExecutionAdmission(tx),id=subject(input.workspaceId,input.ruleId,input.version,input.after);
  if(!pattern.test(id))throw Error("zoom_rule_wake_invalid");
  const identity={deploymentEpoch:epoch,generation:1,kind:"maintenance" as const,subject:{kind:"maintenance" as const,id}};
  const known=await tx.executionDispatch.findUnique({where:{deliveryKey:(await executionDispatchIdentity(identity)).deliveryKey},select:{dueAt:true}});
  if(input.repairOnly&&!known)return null;
  const cutoff=known?.dueAt??input.cutoff??(await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now;
  if(input.cutoff&&cutoff.getTime()!==input.cutoff.getTime())throw Error("zoom_rule_wake_invalid");
  const record=await appendExecutionDispatch(tx,{...identity,inputHash:fingerprint(epoch,id,cutoff),dueAt:cutoff});
  collectExecutionDispatch(tx,record.reference.dispatchId);return record.reference;
}
/** Rule.generation identifies the accepted settings mutation only. Frozen Zoom
 * targets do not depend on that RSS execution counter. */
export async function appendZoomRuleWake(tx:Tx,id:string,options:{repairOnly?:boolean}={}){
  const row=await tx.autopilotRule.findUnique({where:{id},select:{workspaceId:true,sourceKind:true,generation:true}});
  if(!row||row.sourceKind!=="zoom")return null;
  return append(tx,{workspaceId:row.workspaceId,ruleId:id,version:String(row.generation),repairOnly:options.repairOnly});
}
/** A deleted UUID has one logical deletion event, scoped to its Workspace.
 * An HTTP retry may recover that existing event after the Rule is gone. */
export function appendZoomRuleDeletionWake(tx:Tx,workspaceId:string,id:string,repairOnly=false){return append(tx,{workspaceId,ruleId:id,version:"d",repairOnly});}
export function isZoomRuleWakeReference(reference:ExecutionDispatchReference){return reference.kind==="maintenance"&&reference.subject.kind==="maintenance"&&pattern.test(reference.subject.id);}
export function createZoomRuleWakes(options:{database:PrismaClient;register(ids:readonly string[]):Promise<void>}){
  return {async dispatch(value:ExecutionDispatchReference):Promise<{kind:"complete"|"superseded";dispatchIds:string[]}>{
    const reference=executionDispatchReferenceSchema.parse(value);
    const result=await options.database.$transaction(async tx=>{
      const {epoch}=await readExecutionAdmission(tx),ledger=await readExecutionDispatch(tx,reference.dispatchId);
      if(!isZoomRuleWakeReference(reference)||reference.deploymentEpoch!==epoch||reference.generation!==1||!ledger||JSON.stringify(ledger.reference)!==JSON.stringify(reference)||reference.inputHash!==fingerprint(epoch,reference.subject.id,ledger.dueAt))return {kind:"superseded" as const,dispatchIds:[] as string[]};
      const parsed=pattern.exec(reference.subject.id)!,workspaceId=uuid(parsed[1]!),ruleId=uuid(parsed[2]!),version=parsed[3]!,cutoff=ledger.dueAt;
      const after=parsed[5]?{at:new Date(Number(parsed[4])),id:uuid(parsed[5])}:null;
      if(after&&(!Number.isSafeInteger(after.at.getTime())||after.at>cutoff))throw Error("zoom_rule_wake_invalid");
      const receipt=await executeExecutionPage(tx,reference,"maintenance-page",async()=>{
        await lockWorkspaceUsage(tx,workspaceId);
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId}::uuid FOR SHARE`;
        const rows=await tx.$queryRaw<Array<Position>>`SELECT j.id,j."createdAt" AS at FROM "ZoomWebhookJob" j WHERE j."deploymentEpoch"=${epoch} AND j.status IN ('queued','running')
          AND j."executionTarget"#>>'{plan,source,ruleId}'=${ruleId} AND j."executionTarget"#>>'{scope,workspaceId}'=${workspaceId}
          AND j."createdAt"<=(${cutoff}::timestamp) AND (${after===null} OR (j."createdAt",j.id)>((${after?.at??new Date(0)}::timestamp),${after?.id??"00000000-0000-0000-0000-000000000000"}::uuid))
          ORDER BY j."createdAt",j.id LIMIT ${PAGE+1}`;
        const ids:string[]=[];
        for(const row of rows.slice(0,PAGE))ids.push(...await recoverZoomNotification(tx,row.id,`zr_${compact(reference.dispatchId)}`));
        if(rows.length>PAGE){const continuation=await append(tx,{workspaceId,ruleId,version,cutoff,after:rows[PAGE-1]!});ids.push(continuation!.dispatchId);}
        return {kind:rows.length>PAGE?"continue":"complete",processed:Math.min(PAGE,rows.length),dispatchIds:[...new Set(ids)]};
      });
      return {kind:"complete" as const,dispatchIds:receipt.dispatchIds};
    });
    if(result.dispatchIds.length)await options.register(result.dispatchIds);
    return result;
  }};
}
