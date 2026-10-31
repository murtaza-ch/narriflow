import type { OutboundProbe, Prisma } from "@prisma/client";
import { appendExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
export async function queueOutboundProbeRow(tx:Prisma.TransactionClient,row:OutboundProbe):Promise<string[]>{
  if(["completed","failed","cancelled"].includes(row.status))return [];
  const record=await appendExecutionDispatch(tx,{deploymentEpoch:row.deploymentEpoch,generation:row.generation,kind:"operation_driver",subject:{kind:"outbound_probe",id:row.id},inputHash:row.inputHash,dueAt:row.createdAt});
  collectExecutionDispatch(tx,record.reference.dispatchId);
  return [record.reference.dispatchId];
}
export async function queueOutboundProbeExecution(tx:Prisma.TransactionClient,id:string):Promise<string[]>{
  const {epoch}=await readExecutionAdmission(tx),row=await tx.outboundProbe.findUnique({where:{id}});
  return row?.deploymentEpoch===epoch?queueOutboundProbeRow(tx,row):[];
}
