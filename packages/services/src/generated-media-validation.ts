import { Prisma, type NativeValidationJob, type PrismaClient } from "@prisma/client";
import { nativeValidationStoredInputSchema, generatedValidationPlanSchema, type GeneratedValidationPlan } from "@narriflow/validators/native-validation";
import { finalizeGenerationUsage, releaseGenerationUsage } from "./generated-media-usage-ledger";
import { GeneratedMediaJobError } from "./generated-media";
import { accessibleProjectWhere } from "./project-access";

type Tx = Prisma.TransactionClient;
export function generatedValidationParent(job: Pick<NativeValidationJob,"input">) {
 const input=nativeValidationStoredInputSchema.parse(job.input);
 return input.kind==="visual"?input.generated:undefined;
}
export async function lockGeneratedValidationParent(tx:Tx,job:NativeValidationJob) {
 const parent=generatedValidationParent(job);if(!parent)return;
 await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${parent.projectId}::uuid FOR UPDATE`;
 await tx.$queryRaw`SELECT "id" FROM "GeneratedMediaJob" WHERE "id"=${parent.id}::uuid FOR UPDATE`;
}
export async function currentGeneratedValidationParent(tx:Tx,job:NativeValidationJob,clock:Date) {
 const binding=generatedValidationParent(job);if(!binding)return null;
 const parent=await tx.generatedMediaJob.findUnique({where:{id:binding.id}});
 if(!parent||parent.validationJobId!==job.id||parent.projectId!==binding.projectId||parent.workspaceId!==job.workspaceId||parent.createdByUserId!==job.createdByUserId||parent.attempt!==binding.attempt||parent.providerRef!==binding.providerRef||parent.claimId!==null||parent.claimExpiresAt!==null||parent.status!=="waiting"||parent.usageStatus!=="reserved"||parent.outcomeUnknown||parent.providerUsageImages!==1||
  !await tx.project.findFirst({where:{id:parent.projectId,workspaceId:job.workspaceId,...accessibleProjectWhere(clock)}}))throw new GeneratedMediaJobError("generated_media_claim_lost");
 const plan=generatedValidationPlanSchema.parse(parent.validationInput);
 const input=nativeValidationStoredInputSchema.parse(job.input);
 if(plan.fingerprint!==input.fingerprint||plan.contentType!==input.contentType||plan.key!==job.inputStorageKey||plan.sizeBytes!==Number(job.inputByteLength)||plan.parentAttempt!==binding.attempt||plan.providerRef!==binding.providerRef||plan.sourceClaimLineage!==binding.claimLineage)throw new GeneratedMediaJobError("generated_media_claim_lost");
 return parent;
}
export async function completeGeneratedValidation(tx:Tx,job:NativeValidationJob,assetId:string,clock:Date) {
 const parent=await currentGeneratedValidationParent(tx,job,clock);if(!parent)return;
 await finalizeGenerationUsage(tx,{kind:"image",jobId:parent.id,reservationId:parent.usageReservationId,units:parent.providerUsageImages!});
 await tx.generatedMediaJob.update({where:{id:parent.id},data:{resultAssetId:assetId,status:"completed",moderationStatus:"approved",usageStatus:"finalized",errorCode:null,outcomeUnknown:false,retryAt:null,claimId:null,claimExpiresAt:null,promptExpiresAt:new Date(clock.getTime()+30*86400000),updatedAt:clock}});
}
export async function failGeneratedValidation(tx:Tx,job:NativeValidationJob,clock:Date,status:"failed"|"cancelled",errorCode:string) {
 const binding=generatedValidationParent(job);if(!binding)return;
 const parent=await tx.generatedMediaJob.findUnique({where:{id:binding.id}});
 if(!parent||parent.validationJobId!==job.id||parent.attempt!==binding.attempt||parent.providerRef!==binding.providerRef||["completed","failed","cancelled","rejected"].includes(parent.status))return;
 if(parent.usageStatus==="reserved")await releaseGenerationUsage(tx,{kind:"image",jobIds:[parent.id],reason:errorCode});
 await tx.generatedMediaJob.update({where:{id:parent.id},data:{status,usageStatus:parent.usageStatus==="reserved"?"released":parent.usageStatus,errorCode,outcomeUnknown:false,retryAt:null,claimId:null,claimExpiresAt:null,updatedAt:clock}});
}


/** One frozen source plan, committed with cleanup before network I/O. */
export async function planGeneratedValidationSource(database:PrismaClient,request:{jobId:string;claimId:string;source:GeneratedValidationPlan}):Promise<GeneratedValidationPlan> {
 return database.$transaction(async tx=>{
  await tx.$queryRaw`SELECT "id" FROM "GeneratedMediaJob" WHERE "id"=${request.jobId}::uuid FOR UPDATE`;
  const row=await tx.generatedMediaJob.findUniqueOrThrow({where:{id:request.jobId}});
  const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  const source=generatedValidationPlanSchema.parse(request.source);
  if(!clock||row.claimId!==request.claimId||!row.claimExpiresAt||row.claimExpiresAt<=clock.now||row.validationJobId||row.providerRef!==source.providerRef||row.attempt!==source.parentAttempt||row.providerResultContentType!==source.contentType||row.usageStatus!=="reserved"||row.outcomeUnknown||source.sourceClaimLineage!==request.claimId||!source.key.startsWith(`workspaces/${row.workspaceId}/generated-media-attempts/${row.id}/${request.claimId}/`))throw new GeneratedMediaJobError("generated_media_claim_lost");
  if(row.validationInput!==null)return generatedValidationPlanSchema.parse(row.validationInput);
  await tx.mediaCleanupObligation.create({data:{origin:"generated_media_validation",cleanupClass:"generated_asset",objectKey:source.key,nextAttemptAt:new Date(clock.now.getTime()+86400000)}});
  await tx.generatedMediaJob.update({where:{id:row.id},data:{validationInput:source as Prisma.InputJsonValue}});
  return source;
 });
}
