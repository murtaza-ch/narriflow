import {ExecutionDispatchPendingError} from '@narriflow/services/execution-dispatch';
import type {WorkflowDirective} from './protocol';
/** The operation unwinds its database scope before this durable sleep is
 * returned. Uncertain failures retain ordinary Workflow failure handling. */
export async function runWorkflowCommand(operation:()=>Promise<WorkflowDirective>):Promise<WorkflowDirective>{
 try{return await operation();}catch(error){
  if(error instanceof ExecutionDispatchPendingError)return{type:'sleep',until:error.retryAt.toISOString()};
  throw error;
 }
}
