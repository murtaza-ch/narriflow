import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { readExecutionAdmission } from "./execution-admission";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch, takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { executeExecutionPage } from "./execution-page-receipt";
import { queueGenerationFinishing } from "./generation-finishing";
import { lockWorkspaceUsage } from "./processing-usage";

type Tx = Prisma.TransactionClient;
const PAGE = 32, uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const pattern = new RegExp(`^gf1\\.e\\.(${uuid})\\.([a-f0-9]{32})\\.(0|${uuid})$`);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (status: string) => ["ready", "partial_ready", "failed"].includes(status);
const token = (row: { id: string; status: string; retryCount: number }) => hash([row.id,row.status,row.retryCount]).slice(0,32);
async function append(tx: Tx, id: string) {
  const { epoch } = await readExecutionAdmission(tx);
  const record = await appendExecutionDispatch(tx,{ deploymentEpoch:epoch,generation:1,kind:"maintenance",subject:{kind:"maintenance",id},inputHash:hash(["finishing-export-page-v1",id]),dueAt:new Date(0) });
  collectExecutionDispatch(tx,record.reference.dispatchId);
  return record.reference.dispatchId;
}

/** The exact terminal export facts and its dependents' wake page commit together. */
export async function appendFinishingExportWake(tx: Tx, exportId: string): Promise<string | null> {
  const row = await tx.clipExport.findUnique({where:{id:exportId},select:{id:true,status:true,retryCount:true}});
  return row && terminal(row.status) ? append(tx,`gf1.e.${row.id}.${token(row)}.0`) : null;
}
export function isFinishingProducerReference(reference: ExecutionDispatchReference): boolean {
  return reference.kind === "maintenance" && reference.subject.kind === "maintenance" && pattern.test(reference.subject.id);
}

/** Only known dependents of one export are read. Receipts retain the complete
 * wake list so callback replay repairs a lost registration acknowledgement. */
export function createFinishingProducers(options: { database: PrismaClient; register(ids: readonly string[]): Promise<void> }) {
  return { async dispatch(value: ExecutionDispatchReference): Promise<{kind:"complete"|"superseded";dispatchIds:string[]}> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const result = await options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx), ledger = await readExecutionDispatch(tx,reference.dispatchId);
      if (!isFinishingProducerReference(reference) || reference.generation !== 1 || reference.deploymentEpoch !== epoch || reference.inputHash !== hash(["finishing-export-page-v1",reference.subject.id]) ||
        !ledger || JSON.stringify(ledger.reference) !== JSON.stringify(reference)) return {kind:"superseded" as const,dispatchIds:[]};
      const page = pattern.exec(reference.subject.id)!;
      const receipt = await executeExecutionPage(tx,reference,"maintenance-page",async()=>{
        const initial = await tx.clipExport.findUnique({where:{id:page[1]},select:{projectId:true,project:{select:{workspaceId:true}}}});
        if (!initial) return {kind:"complete",processed:0,dispatchIds:[]};
        await lockWorkspaceUsage(tx,initial.project.workspaceId);
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${initial.projectId}::uuid FOR UPDATE`;
        const exported = await tx.clipExport.findUnique({where:{id:page[1]},select:{id:true,status:true,retryCount:true}});
        if (!exported || !terminal(exported.status) || token(exported) !== page[2]) return {kind:"complete",processed:0,dispatchIds:[]};
        const rows = await tx.generationFinishing.findMany({where:{deploymentEpoch:epoch,projectId:initial.projectId,workspaceId:initial.project.workspaceId,state:"exporting",picks:{array_contains:[{exportId:exported.id}]},
          ...(page[3] === "0" ? {} : {id:{gt:page[3]}})},orderBy:{id:"asc"},take:PAGE+1,select:{id:true}});
        for (const row of rows.slice(0,PAGE)) {
          const current = await queueGenerationFinishing(tx,row.id);
          if (!current) continue;
          const wake = await appendExecutionDispatch(tx,{...current,dueAt:new Date(0),wakeKind:`ex_${page[2]}`});
          collectExecutionDispatch(tx,wake.reference.dispatchId);
        }
        if (rows.length > PAGE) await append(tx,`gf1.e.${exported.id}.${page[2]}.${rows[PAGE-1]!.id}`);
        return {kind:rows.length>PAGE?"continue":"complete",processed:Math.min(rows.length,PAGE),dispatchIds:takeExecutionDispatchIds(tx)};
      });
      return {kind:"complete" as const,dispatchIds:receipt.dispatchIds};
    });
    if (result.dispatchIds.length) await options.register(result.dispatchIds);
    return result;
  } };
}
