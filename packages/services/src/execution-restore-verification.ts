import type { ExecutionRestorePhaseHandler } from "./execution-restore";
import { assertExecutionRestorePage } from "./execution-restore-pages";
/** Device sessions are epoch-namespaced Durable Object transport state, not
 * another SQL authority table. Revoking their old Generic permissions and the
 * epoch fence invalidates every captured device signature/lease. */
export const verifyRestoredDeviceFence:ExecutionRestorePhaseHandler=async(tx,page)=>{await assertExecutionRestorePage(tx,page);if(await tx.executionAttempt.findFirst({where:{deploymentEpoch:{lt:page.deploymentEpoch},status:{in:["admitted","running"]},dispatch:{kind:"local_fetch"}},select:{attemptToken:true}}))throw Error("restore_device_permission_not_revoked");return {processed:0,next:null,dispatchIds:[]};};
/** A real indexed permission audit is the final metadata barrier. Product
 * registration happens in separate rs2 pages only after this barrier commits. */
export const verifyRestoreAuthority:ExecutionRestorePhaseHandler=async(tx,page)=>{await assertExecutionRestorePage(tx,page);if(await tx.executionAttempt.findFirst({where:{deploymentEpoch:{lt:page.deploymentEpoch},status:{in:["admitted","running"]}},select:{attemptToken:true}}))throw Error("restore_permission_not_revoked");return {processed:0,next:null,dispatchIds:[]};};
