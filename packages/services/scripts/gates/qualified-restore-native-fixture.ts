/** Operator-only preparation. Normal Modal dispatch deliberately remains
 * unconfirmed; this setup is not public-admission acceptance evidence. */
import {readFile,stat,writeFile,rename} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {PrismaClient} from "@prisma/client";
import {PrismaPg} from "@prisma/adapter-pg";
import {HeadObjectCommand,S3Client} from "@aws-sdk/client-s3";
import {FetchHttpHandler} from "@smithy/fetch-http-handler";
import {NativeValidationService,NativeValidationError,type NativeValidationDependencies} from "../../src/native-validation";
import {brandOwnerStoragePrefix,resolveBrandOwner,type BrandActorScope} from "../../src/brand-ownership";
import {readExecutionDispatch} from "../../src/execution-dispatch";
import {readRestoreResumeWorker} from "../../src/execution-snapshot";
import {candidateRestoreTarget} from "./qualified-restore-candidate";
const expectedEpoch=3;
const leanFingerprint="6235b66ae20332ba1024049d77166d850c4fed0b7d4378bbb5d5d9e74f1cb38d";
const fail=()=>Error("qualified_native_fixture_refused");
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
interface Input{version:1;runId:string;inputKey:string;inputBytes:number;inputSha256:string;prepared?:unknown}
export function nativeRestoreFixtureInput(value:unknown):Input{
 if(!value||typeof value!=="object"||Array.isArray(value))throw fail();const j=value as Input;
 if(j.version!==1||!uuid(j.runId)||typeof j.inputKey!=="string"||j.inputKey.length>1024||!j.inputKey.endsWith(`/restore-${j.runId}/source.png`)||!Number.isInteger(j.inputBytes)||j.inputBytes<1||j.inputBytes>1024*1024||typeof j.inputSha256!=="string"||!/^[a-f0-9]{64}$/.test(j.inputSha256)||Object.keys(j).some(key=>!["version","runId","inputKey","inputBytes","inputSha256","prepared"].includes(key)))throw fail();
 return j;
}
export async function closeNativeFixtureAdmission(db:PrismaClient,epoch:number){await db.executionEpoch.updateMany({where:{id:1,epoch},data:{admissionOpen:false}});}
/** Real domain admission and preparation, with a deliberate scheduler failure.
 * No owner, charge, process history, grant or acknowledgement is invented. */
export async function prepareNativeRestoreFixture(options:{database:PrismaClient;epoch:number;userId:string;workspaceId:string;input:Input;head:NativeValidationDependencies["head"];signal?:AbortSignal}){
 const {database:db,epoch,input}=options;
 const workspace=await db.workspace.findUniqueOrThrow({where:{id:options.workspaceId}}),user=await db.user.findUniqueOrThrow({where:{id:options.userId}});
 const member=await db.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:workspace.id,userId:user.id}}});
 if(user.deletedAt||workspace.status!=="active"||workspace.ownerUserId!==user.id&&!member)throw fail();
 const scope:BrandActorScope={actorUserId:user.id,workspaceId:workspace.id,workspaceOwnerUserId:workspace.ownerUserId,role:workspace.ownerUserId===user.id?"owner":member!.role,status:workspace.status,pricingTier:workspace.pricingTier,isPersonalWorkspace:workspace.personalOwnerUserId!==null};
 if(!input.inputKey.startsWith(brandOwnerStoragePrefix(scope,"visual-assets")))throw fail();
 const owner=resolveBrandOwner(scope);
 if(await db.visualAsset.count({where:{...owner,fingerprint:input.inputSha256}}))throw fail();
 const initialHead=await options.head(input.inputKey);
 if(initialHead.contentType!=="image/png"||initialHead.sizeBytes!==input.inputBytes||!initialHead.etag)throw fail();
 const pending:string[]=[];
 const service=new NativeValidationService(db,{head:async key=>{const actual=await options.head(key);if(actual.etag!==initialHead.etag)throw fail();return actual;},register:async ids=>{pending.push(...ids);throw Error("gate_original_registration_pending");}});
 let jobId:string|undefined;
 await db.$transaction(async tx=>{const [state]=await tx.$queryRaw<Array<{epoch:number;admissionOpen:boolean}>>`SELECT epoch,"admissionOpen" FROM "ExecutionEpoch" WHERE id=1 FOR UPDATE`;if(!state||state.epoch!==epoch||state.admissionOpen||options.signal?.aborted)throw fail();await tx.executionEpoch.update({where:{id:1},data:{admissionOpen:true}});});
 try{
  try{await service.admit(scope,{kind:"visual",key:input.inputKey,contentType:"image/png",sizeBytes:input.inputBytes,fingerprint:input.inputSha256,title:`Qualified restore ${input.runId}`,provenance:"uploaded"});throw fail();}
  catch(error){if(!(error instanceof NativeValidationError)||error.code!=="native_validation_unavailable"||!uuid(error.details?.jobId)||pending.length!==1)throw error;jobId=error.details!.jobId as string;}
 }finally{await closeNativeFixtureAdmission(db,epoch);}
 const driver=await readExecutionDispatch(db,pending[0]!);
 if(!driver||driver.acknowledgedAt||driver.reference.subject.id!==jobId||driver.reference.deploymentEpoch!==epoch)throw fail();
 const plan=await service.prepareExecution(driver.reference);
 if(plan.kind!=="waiting")throw fail();
 const invocation={reference:plan.deadline.reference,attemptToken:plan.deadline.attemptToken};
 const job=await db.nativeValidationJob.findUniqueOrThrow({where:{id:jobId}}),attempt=await db.executionAttempt.findUniqueOrThrow({where:{attemptToken:invocation.attemptToken}});
 for(const id of plan.dispatchIds){const row=await readExecutionDispatch(db,id);if(!row||row.acknowledgedAt)throw fail();}
 if(job.chargedAttempts!==0||job.executorOwner||job.status!=="queued"||job.inputEtag!==initialHead.etag||job.inputByteLength!==BigInt(input.inputBytes)||attempt.owner||attempt.processStartedAt||attempt.status!=="admitted"||job.operationDeadlineAt.getTime()-job.createdAt.getTime()!==600000||(await db.executionEpoch.findUniqueOrThrow({where:{id:1}})).admissionOpen)throw fail();
 return {jobId,invocation,operationDriverId:driver.reference.dispatchId,watchdogId:plan.deliveryId,operationDeadlineAt:job.operationDeadlineAt.toISOString(),inputEtag:job.inputEtag,toolchainFingerprint:leanFingerprint,normalModalRegistration:"pending" as const};
}
async function privateJson(path:string){const file=await stat(path);if(!isAbsolute(path)||file.mode&0o077||file.size>131072)throw fail();return JSON.parse(await readFile(path,"utf8"));}
async function save(path:string,value:unknown,exclusive=false){const wire=`${JSON.stringify(value,null,2)}\n`;if(exclusive){await writeFile(path,wire,{flag:"wx",mode:0o600});return;}const temporary=`${path}.${crypto.randomUUID()}.tmp`;await writeFile(temporary,wire,{flag:"wx",mode:0o600});await rename(temporary,path);}
async function main(){
 if(process.argv.length!==3||process.argv[2]!=="prepare")throw fail();
 const journalPath=process.env.RESTORE_FIXTURE_JOURNAL,invocationPath=process.env.RESTORE_FIXTURE_INVOCATION,origin=process.env.API_ORIGIN;
 if(!journalPath||!invocationPath||!isAbsolute(invocationPath)||journalPath===invocationPath||!origin)throw fail();
 const input=nativeRestoreFixtureInput(await privateJson(journalPath));
 const auth=await privateJson("/tmp/narriflow-serverless-control-keys/cloud-auth-gate.json"),settings=await privateJson("/tmp/narriflow-serverless-control-keys/candidate-worker-secrets.json");
 if(!uuid(auth.userId)||auth.workspaceId!=="459f1481-3a45-4912-bc4c-206120882c66"||settings.R2_ACCOUNT_ID!=="5359f28d385b8632c3abee12d1f5b011"||settings.R2_BUCKET!=="narriflow-dev"||settings.MEDIA_FETCH_TOOLCHAIN_FINGERPRINT!==leanFingerprint||settings.API_ORIGIN!==origin)throw fail();
 await readRestoreResumeWorker(origin,true);
 const target=candidateRestoreTarget(process.env.DIRECT_URL??"");
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:target.toString(),max:2,connectionTimeoutMillis:10000,query_timeout:10000},{schema:"public"}),transactionOptions:{maxWait:10000,timeout:30000},log:[]});
 const client=new S3Client({region:"auto",endpoint:`https://${settings.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:settings.R2_ACCESS_KEY_ID,secretAccessKey:settings.R2_SECRET_ACCESS_KEY},requestHandler:new FetchHttpHandler({requestTimeout:10000}),maxAttempts:1});
 const cancellation=new AbortController();
 const interrupt=()=>{cancellation.abort();void closeNativeFixtureAdmission(db,expectedEpoch).finally(()=>{process.exit(130);});};
 process.once("SIGINT",interrupt);process.once("SIGTERM",interrupt);
 try{
  const [bound]=await db.$queryRaw<Array<{database:string;schema:string;epoch:number;admissionOpen:boolean}>>`SELECT current_database() AS database,current_schema() AS schema,epoch,"admissionOpen" FROM "ExecutionEpoch" WHERE id=1`;
  if(bound?.database!=="serverless_pipeline_gates"||bound.schema!=="public"||bound.epoch!==expectedEpoch||bound.admissionOpen)throw fail();
  const prepared=await prepareNativeRestoreFixture({database:db,epoch:expectedEpoch,userId:auth.userId,workspaceId:auth.workspaceId,input,signal:cancellation.signal,head:async key=>{const object=await client.send(new HeadObjectCommand({Bucket:settings.R2_BUCKET,Key:key}),{abortSignal:AbortSignal.any([cancellation.signal,AbortSignal.timeout(10000)])});return{contentType:object.ContentType??null,sizeBytes:object.ContentLength??null,etag:object.ETag??""};}});
  await save(journalPath,{...input,prepared});
  await save(invocationPath,prepared.invocation,true);
  console.log(JSON.stringify({mode:"private_native_fixture_prepared",admissionOpen:false,normalModalRegistration:"pending",invocationFileWritten:true}));
 }finally{process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);await closeNativeFixtureAdmission(db,expectedEpoch);client.destroy();await db.$disconnect();}
}
if((import.meta as ImportMeta&{main?:boolean}).main)main().catch(()=>{console.error(JSON.stringify({mode:"failed",code:"qualified_native_fixture_refused"}));process.exitCode=1;});
