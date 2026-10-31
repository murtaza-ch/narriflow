/** Private acceptance tooling only. No deployment, migration, admission opening,
 * bucket inventory, provider call or native credential provisioning. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { nativeValidationInputSchema } from "@narriflow/validators/native-validation";
import { assertExecutionSnapshotDatabase, readFencedWorker, readRestoreResumeWorker, validateExecutionSnapshotEvidence } from "../../src/execution-snapshot";
import { hashSnapshotFile, hashSnapshotMigrations, readSnapshotJson } from "../execution-snapshot-files";

const host="ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech",databaseName="serverless_pipeline_gates";
const pgDirectory="/opt/homebrew/opt/postgresql@17/bin";
const invalid=()=>Error("qualified_restore_gate_refused");
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function candidateRestoreTarget(raw:string){
 const target=new URL(raw);
 if(!["postgres:","postgresql:"].includes(target.protocol)||target.hostname!==host||target.pathname!==`/${databaseName}`||target.hash||!target.username||!target.password||target.port&&target.port!=="5432"||target.searchParams.get("sslmode")!=="verify-full"||[...target.searchParams.keys()].some(key=>!["sslmode","schema"].includes(key))||target.searchParams.has("schema")&&target.searchParams.get("schema")!=="public")throw invalid();
 target.searchParams.delete("schema");return target;
}
interface Journal{version:1;runId:string;jobId:string;dispatchId:string;attemptToken:string;artifactId:string;commandSha256:string;operationDeadlineAt:string;fencedVersion:string;snapshotPath:string;proofPath:string;refusalPath:string}
export function candidateRestoreJournal(raw:unknown):Journal{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw invalid();
 const j=raw as Journal;
 const keys=["version","runId","jobId","dispatchId","attemptToken","artifactId","commandSha256","operationDeadlineAt","fencedVersion","snapshotPath","proofPath","refusalPath"];
 const files=[j.snapshotPath,j.proofPath,j.refusalPath];
 if(Object.keys(j).sort().join(",")!==keys.sort().join(",")||j.version!==1||
  ![j.runId,j.jobId,j.dispatchId,j.attemptToken,j.artifactId].every(uuid)||typeof j.commandSha256!=="string"||!/^[a-f0-9]{64}$/.test(j.commandSha256)||
  typeof j.operationDeadlineAt!=="string"||!Number.isFinite(Date.parse(j.operationDeadlineAt))||new Date(j.operationDeadlineAt).toISOString()!==j.operationDeadlineAt||
  typeof j.fencedVersion!=="string"||!/^[A-Za-z0-9_-]{1,160}$/.test(j.fencedVersion)||
  !files.every(path=>typeof path==="string"&&isAbsolute(path)&&![...path].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))||new Set(files).size!==3)throw invalid();
 return j;
}

async function main(){
 const stage=process.argv[2];if(!["dump","restore","verify"].includes(stage??"")||process.argv.length!==3)throw invalid();
 const target=candidateRestoreTarget(process.env.DIRECT_URL??""),origin=process.env.API_ORIGIN;
 if(!origin||!process.env.RESTORE_GATE_JOURNAL)throw invalid();
 const j=candidateRestoreJournal(await readSnapshotJson(process.env.RESTORE_GATE_JOURNAL));
 const makeDatabase=()=>new PrismaClient({adapter:new PrismaPg({connectionString:target.toString(),max:1,connectionTimeoutMillis:10000,query_timeout:10000},{schema:"public"}),log:[],transactionOptions:{maxWait:10000,timeout:15000}});
 let db=makeDatabase();
 const deadline=Date.parse(j.operationDeadlineAt);
 async function identity(epoch:number){
  const [bound]=await db.$queryRaw<Array<{database:string;schema:string}>>`SELECT current_database() AS database,current_schema() AS schema`;
  const state=await db.executionEpoch.findUniqueOrThrow({where:{id:1}});
  if(bound?.database!==databaseName||bound.schema!=="public"||state.epoch!==epoch||state.admissionOpen)throw invalid();
  return state;
 }
 async function original(){
  const job=await db.nativeValidationJob.findUniqueOrThrow({where:{id:j.jobId}}),attempt=await db.executionAttempt.findUniqueOrThrow({where:{attemptToken:j.attemptToken}}),artifact=await db.executionArtifact.findUniqueOrThrow({where:{id:j.artifactId}});
  const dispatch=await db.executionDispatch.findUniqueOrThrow({where:{id:attempt.dispatchId}});
  const input=nativeValidationInputSchema.parse(job.input);
  if(job.kind!=="visual_asset"||input.kind!=="visual"||input.contentType!=="image/png"||input.sizeBytes>1024*1024||job.operationDeadlineAt.toISOString()!==j.operationDeadlineAt||job.maxAttempts!==3||attempt.deploymentEpoch!==2||attempt.functionName!=="asset_validation"||!attempt.processStartedAt||attempt.operationDeadlineAt.toISOString()!==j.operationDeadlineAt||dispatch.id!==j.dispatchId||dispatch.subjectKind!=="native_validation"||dispatch.subjectId!==j.jobId||artifact.attemptToken!==j.attemptToken||artifact.owner!==attempt.owner||artifact.role!=="probe"||artifact.committedAt)throw invalid();
  if(await db.executionArtifact.count({where:{attemptToken:j.attemptToken,role:"validated_asset",committedAt:{not:null}}})!==1)throw invalid();
  return {job,attempt,artifact,input};
 }
 async function source(){
  const state=await identity(3),worker=await readFencedWorker(origin!);
  if(worker.version!==j.fencedVersion||await db.executionDispatch.findFirst({where:{deploymentEpoch:{gte:3}},select:{id:true}}))throw invalid();
  const facts=await original();
  if(facts.job.deploymentEpoch!==2||facts.job.status!=="processing"||facts.job.attemptToken!==j.attemptToken||facts.job.chargedAttempts!==1||deadline-Date.now()<30000||await db.visualAsset.count({where:{userId:facts.job.ownerUserId,workspaceId:facts.job.ownerWorkspaceId,fingerprint:facts.input.fingerprint}})!==0)throw invalid();
  return {state,worker};
 }
 const runFile=promisify(execFile);
 async function postgres(tool:"pg_dump"|"pg_restore",args:string[]){
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,PGHOST:host,PGPORT:"5432",PGDATABASE:databaseName,PGUSER:decodeURIComponent(target.username),PGPASSWORD:decodeURIComponent(target.password),PGSSLMODE:"verify-full",PGCONNECT_TIMEOUT:"10",PGOPTIONS:"-c statement_timeout=60000 -c lock_timeout=5000"};
  const timeout=Math.min(60000,deadline-Date.now()-10000);if(timeout<1000)throw invalid();
  const binary=`${pgDirectory}/${tool}`,version=await runFile(binary,["--version"],{env,timeout:5000,maxBuffer:4096});if(!version.stdout.includes(" 17."))throw invalid();
  await runFile(binary,args,{env,timeout,maxBuffer:4*1024*1024});
 }
 try{
  if(stage==="dump"){
   await source();
   const temporary=`${j.snapshotPath}.${j.runId}.partial`,file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.close();
   await db.$disconnect();
   await postgres("pg_dump",["--format=custom","--compress=0","--no-owner","--no-privileges",`--file=${temporary}`]);
   await link(temporary,j.snapshotPath);await unlink(temporary);
   console.log(JSON.stringify({mode:"snapshot_captured",runId:j.runId,sourceEpoch:3,capturedAt:new Date().toISOString(),snapshotSha256:await hashSnapshotFile(j.snapshotPath)}));
  }else if(stage==="restore"){
   const {state,worker}=await source();
   const evidence=await validateExecutionSnapshotEvidence({proof:await readSnapshotJson(j.proofPath),snapshotSha256:await hashSnapshotFile(j.snapshotPath),localMigrationSha256:await hashSnapshotMigrations(fileURLToPath(new URL("../../../db/prisma/migrations/",import.meta.url))),worker});
   if(evidence.proof.sourceEpoch!==3||evidence.proof.schema!=="public")throw invalid();
   const validate=()=>db.$transaction(async tx=>{const [current]=await tx.$queryRaw<Array<typeof state>>`SELECT epoch,"admissionOpen","changedAt" FROM "ExecutionEpoch" WHERE id=1 FOR UPDATE`;if(!current)throw invalid();await assertExecutionSnapshotDatabase(tx,evidence,{...current,expectedEpoch:3,fenceAboveEpoch:3});});
   await validate();await db.$disconnect();
   await postgres("pg_restore",["--clean","--if-exists","--single-transaction","--exit-on-error","--no-owner","--no-privileges",`--dbname=${databaseName}`,j.snapshotPath]);
   db=makeDatabase();await validate();await original();
   console.log(JSON.stringify({mode:"attested_snapshot_restored",runId:j.runId,sourceEpoch:3,restoredAt:new Date().toISOString(),snapshotSha256:evidence.proof.snapshotSha256}));
  }else{
   await identity(4);await readRestoreResumeWorker(origin,true);
   const {job,attempt}=await original(),report=await readSnapshotJson(j.refusalPath) as Record<string,unknown>;
   if(report.event!=="restore_fault_refused"||report.runId!==j.runId||report.sourceEpoch!==2||report.targetEpoch!==4||report.attemptToken!==j.attemptToken||report.artifactId!==j.artifactId||report.dispatchId!==attempt.dispatchId||report.refusal!=="superseded"||report.commandSha256!==j.commandSha256||job.deploymentEpoch!==4||job.status!=="completed"||job.chargedAttempts!==2||!job.completedAt||job.completedAt.getTime()>deadline||attempt.status!=="superseded"||!attempt.revokedAt)throw invalid();
   const starts=await db.executionAttempt.findMany({where:{dispatch:{subjectKind:"native_validation",subjectId:j.jobId},processStartedAt:{not:null}},take:4});
   const successor=starts.filter(row=>row.deploymentEpoch===4&&row.status==="completed");
   if(starts.length!==2||successor.length!==1||starts.some(row=>row.operationDeadlineAt.getTime()!==deadline))throw invalid();
   const binary=await db.executionArtifact.findFirstOrThrow({where:{attemptToken:successor[0]!.attemptToken,role:"validated_asset",committedAt:{not:null}}});
   const result=job.result as {assetId?:string};if(!result?.assetId)throw invalid();
   const asset=await db.visualAsset.findUniqueOrThrow({where:{id:result.assetId}});
   if(asset.storageKey!==binary.storageKey||await db.visualAsset.count({where:{userId:job.ownerUserId,workspaceId:job.ownerWorkspaceId,fingerprint:asset.fingerprint}})!==1)throw invalid();
   console.log(JSON.stringify({mode:"qualified_restore_verified",runId:j.runId,jobId:j.jobId,sourceEpoch:2,snapshotEpoch:3,targetEpoch:4,chargedStarts:2,staleCommit:"superseded",publishedAssets:1,operationDeadlineAt:j.operationDeadlineAt,completedAt:job.completedAt.toISOString()}));
  }
 }finally{await db.$disconnect();}
}
if((import.meta as ImportMeta&{main?:boolean}).main)main().catch(()=>{console.error(JSON.stringify({mode:"failed",code:"qualified_restore_gate_refused"}));process.exitCode=1;});
