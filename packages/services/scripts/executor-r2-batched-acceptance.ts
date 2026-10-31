/** One-shot private coalesced transfer acceptance. No cleanup or redeployment. */
import {spawn} from "node:child_process";
import {readFile,writeFile,rename,mkdir,open,stat} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {candidateRestoreTarget} from "./gates/qualified-restore-candidate";
import {readRestoreResumeWorker} from "../src/execution-snapshot";
import {sourceReceipt} from "./executor-r2-transfer-gate";
const folder="/tmp/narriflow-executor-r2-batched",settingsPath="/tmp/narriflow-serverless-control-keys/candidate-worker-secrets.json";
const repo=fileURLToPath(new URL("../../../",import.meta.url));
const fail=()=>Error("batched_acceptance_refused");
interface Config{version:1;expectedEpoch:10;expectedWorkerVersion:string;apiOrigin:string;qualifiedRestoreProofPath:string;expectedFunctionId:string;modalSourceWitness:string}
export function batchedAcceptanceConfig(raw:unknown):Config{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw fail();const c=raw as Config;
 if(Object.keys(c).sort().join(",")!==["version","expectedEpoch","expectedWorkerVersion","apiOrigin","qualifiedRestoreProofPath","expectedFunctionId","modalSourceWitness"].sort().join(",")||c.version!==1||c.expectedEpoch!==10||typeof c.expectedWorkerVersion!=="string"||!/^[-a-zA-Z0-9_]{1,160}$/.test(c.expectedWorkerVersion)||typeof c.apiOrigin!=="string"||new URL(c.apiOrigin).origin!==c.apiOrigin||new URL(c.apiOrigin).protocol!=="https:"||!isAbsolute(c.qualifiedRestoreProofPath)||!/^fu-[A-Za-z0-9]{10,40}$/.test(c.expectedFunctionId)||typeof c.modalSourceWitness!=="string"||!/^35ca[A-Za-z0-9._-]{0,156}$/.test(c.modalSourceWitness))throw fail();return c;
}
export function batchedRestoreProof(raw:unknown){
 const p=raw as Record<string,unknown>;
 if(!p||p.mode!=="qualified_restore_verified"||p.sourceEpoch!==8||p.snapshotEpoch!==9||p.targetEpoch!==10||p.chargedStarts!==2||p.staleCommit!=="superseded"||p.publishedAssets!==1||typeof p.operationDeadlineAt!=="string"||typeof p.completedAt!=="string"||!Number.isFinite(Date.parse(p.completedAt))||!Number.isFinite(Date.parse(p.operationDeadlineAt))||Date.parse(p.completedAt)>Date.parse(p.operationDeadlineAt))throw fail();
}
export function batchedTimings(raw:unknown){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw fail();
 const labels=new Set(["work_package","fixture_generation","source_prefix","upload_initialize","authorize_part","authorize_range","storage_get","storage_put","complete","abort"]),result:Record<string,Record<string,number|null>>={};
 for(const [label,value] of Object.entries(raw)){if(!labels.has(label)||!value||typeof value!=="object"||Array.isArray(value))throw fail();const v=value as Record<string,unknown>,out:Record<string,number|null>={};
  for(const field of ["calls","failures","sumSeconds","maxSeconds","meanSeconds","maxConcurrentCalls","unfinishedCalls"]){const n=v[field];if(field==="meanSeconds"&&n===null){out[field]=null;continue;}if(typeof n!=="number"||!Number.isFinite(n)||n<0)throw fail();out[field]=n;}
  if(!Number.isInteger(out.calls)||!Number.isInteger(out.failures)||!Number.isInteger(out.maxConcurrentCalls)||out.unfinishedCalls!==0||(out.failures??0)>(out.calls??0))throw fail();result[label]=out;
 }return result;
}
export function batchedDeadline(sqlDeadline:number,reportDeadline?:number){
 if(!Number.isSafeInteger(sqlDeadline)||reportDeadline!==undefined&&!Number.isSafeInteger(reportDeadline))throw fail();return Math.min(sqlDeadline,reportDeadline??sqlDeadline);
}
async function privateJson<T>(path:string):Promise<T>{const info=await stat(path);if(!isAbsolute(path)||info.mode&0o077||info.size>131072)throw fail();return JSON.parse(await readFile(path,"utf8"));}
async function save(path:string,value:unknown){const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600,flag:"wx"});await rename(temp,path);}
async function main(){
 if(process.argv.length!==5||process.argv[2]!=="run"||process.argv[3]!=="--config"||process.versions.bun!=="1.3.6")throw fail();
 const config=batchedAcceptanceConfig(await privateJson(process.argv[4]!));
 const proof=await privateJson(config.qualifiedRestoreProofPath);batchedRestoreProof(proof);
 const restoreProofSha256=createHash("sha256").update(await readFile(config.qualifiedRestoreProofPath)).digest("hex");
 const direct=process.env.DIRECT_URL;if(!direct||process.env.DATABASE_URL!==direct)throw fail();const target=candidateRestoreTarget(direct);
 const pool=new Pool({connectionString:target.toString(),max:1,connectionTimeoutMillis:10000,query_timeout:10000});
 let child:ReturnType<typeof spawn>|undefined,interrupted=false,combinedDeadline:number|undefined,started=false,admissionOpened=false;
 const notebook:Record<string,unknown>={version:1,runId:randomUUID(),createdAt:new Date().toISOString(),epoch:config.expectedEpoch,workerVersion:config.expectedWorkerVersion,modalSourceWitness:config.modalSourceWitness,functionId:config.expectedFunctionId,restoreProofSha256,scope:"coalesced10GiB upload plus greater-than5GiB conditional pin; one original2700s budget",phases:[]};
 const phases=notebook.phases as Record<string,unknown>[];
 async function closeAdmission(){await pool.query('UPDATE "ExecutionEpoch" SET "admissionOpen"=false WHERE id=1 AND epoch=$1',[config.expectedEpoch]);}
 const interrupt=()=>{interrupted=true;child?.kill("SIGTERM");if(admissionOpened)void closeAdmission().catch(()=>{});};
 process.once("SIGINT",interrupt);process.once("SIGTERM",interrupt);
 async function guard(){
  if(interrupted)throw fail();const worker=await readRestoreResumeWorker(config.apiOrigin,true);if(worker.version!==config.expectedWorkerVersion)throw fail();
  const state=await pool.query('SELECT current_database() AS database,current_schema() AS schema,epoch,"admissionOpen" FROM "ExecutionEpoch" WHERE id=1');
  if(state.rows[0]?.database!=="serverless_pipeline_gates"||state.rows[0].schema!=="public"||state.rows[0].epoch!==config.expectedEpoch||state.rows[0].admissionOpen)throw fail();
 }
 async function run(args:string[],env:NodeJS.ProcessEnv,timeoutMs:number){
  if(interrupted||timeoutMs<1000)throw fail();
  await new Promise<void>((resolve,reject)=>{child=spawn(args[0]!,args.slice(1),{cwd:repo,env,stdio:["ignore","pipe","pipe"]});let size=0,timedOut=false;const timer=setTimeout(()=>{timedOut=true;child?.kill("SIGTERM");},timeoutMs);const kill=setTimeout(()=>{child?.kill("SIGKILL");},timeoutMs+2000);
   const collect=(chunk:Buffer)=>{size+=chunk.byteLength;if(size>65536)child?.kill("SIGKILL");};child.stdout!.on("data",collect);child.stderr!.on("data",collect);
   child.once("error",()=>{clearTimeout(timer);clearTimeout(kill);reject(fail());});child.once("exit",code=>{clearTimeout(timer);clearTimeout(kill);child=undefined;if(code!==0||size>65536||timedOut)reject(fail());else resolve();});
  });
 }
 const commonEnv:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,DATABASE_URL:direct,DIRECT_URL:direct};
 async function fixturePhase(phase:"seed-upload"|"bind-pin"){
  await guard();phases.push({phase,startedAt:new Date().toISOString()});await save(folder+"/notebook.json",notebook);
  const opened=await pool.query('UPDATE "ExecutionEpoch" SET "admissionOpen"=true WHERE id=1 AND epoch=$1 AND "admissionOpen"=false RETURNING epoch',[config.expectedEpoch]);admissionOpened=opened.rowCount===1;if(!admissionOpened||interrupted){if(admissionOpened)await closeAdmission();throw fail();}
  try{const args=[process.execPath,"--no-env-file","packages/services/scripts/executor-r2-transfer-gate.ts",phase,"--journal",folder+"/fixture.json","--settings",settingsPath,"--expected-host",target.hostname,"--epoch",String(config.expectedEpoch)];if(phase==="bind-pin")args.push("--report",folder+"/upload.json");await run(args,commonEnv,Math.min(120000,(combinedDeadline??Date.now()+120000)-Date.now()-1000));}
  finally{await closeAdmission();admissionOpened=false;}
  phases.at(-1)!.finishedAt=new Date().toISOString();await save(folder+"/notebook.json",notebook);
 }
 async function native(phase:"upload"|"pin"){
  await guard();if(!combinedDeadline||Date.now()+60000>=combinedDeadline)throw fail();
  phases.push({phase:"native_"+phase,startedAt:new Date().toISOString(),deadlineUnixMs:combinedDeadline,callState:"submitted_once_result_may_be_unknown_on_caller_loss"});await save(folder+"/notebook.json",notebook);
  const argumentsPath=folder+`/fixture.json.${phase==="upload"?"upload-invocation":"pin-arguments"}.json`;
  await run(["/Users/murtaza/.local/share/uv/tools/modal/bin/python","apps/media/python/gates/run_executor_r2_transfer.py","--app","narriflow-media-gates","--phase",phase,"--arguments",argumentsPath,"--output",folder+`/${phase}.json`,"--expected-function-id",config.expectedFunctionId],{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,MODAL_PROFILE:"murtazach275",MODAL_ENVIRONMENT:"main"},combinedDeadline-Date.now());
  const report=await privateJson<Record<string,unknown>>(folder+`/${phase}.json`);if(report.status!=="passed"||report.phase!==phase)throw fail();
  const summary:Record<string,unknown>={status:"passed",timings:batchedTimings(report.timings)};
  for(const key of ["elapsedSeconds","combinedElapsedSeconds","requestedBytes","uploadedBytes","downloadedBytes","peakRssBytes","tracedPeakBytes"]){if(!(key in report))continue;const value=report[key];if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw fail();summary[key]=value;}
  phases.at(-1)!.finishedAt=new Date().toISOString();phases.at(-1)!.summary=summary;await save(folder+"/notebook.json",notebook);
 }
 try{
  await guard();await mkdir(folder,{recursive:true,mode:0o700});
  for(const name of ["fixture.json","upload.json","pin.json","notebook.json"]){try{await stat(folder+"/"+name);throw fail();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  await(await open(folder+"/run.lock","wx",0o600)).close();started=true;await save(folder+"/notebook.json",notebook);
  await fixturePhase("seed-upload");
  const fixture=await privateJson<{upload:{invocation:{attemptToken:string}}}>(folder+"/fixture.json");
  const original=await pool.query('SELECT "operationDeadlineAt" AT TIME ZONE \'UTC\' AS "operationDeadlineAt" FROM "ExecutionAttempt" WHERE "attemptToken"=$1::uuid',[fixture.upload.invocation.attemptToken]);
  combinedDeadline=batchedDeadline(original.rows[0]?.operationDeadlineAt?.getTime());notebook.combinedDeadlineUnixMs=combinedDeadline;await save(folder+"/notebook.json",notebook);
  await native("upload");
  const report=await privateJson(folder+"/upload.json"),receipt=sourceReceipt(report as never,fixture as never);
  combinedDeadline=batchedDeadline(combinedDeadline,receipt.combinedDeadlineUnixMs);notebook.combinedDeadlineUnixMs=combinedDeadline;await save(folder+"/notebook.json",notebook);
  await fixturePhase("bind-pin");await native("pin");await guard();
  const pin=await privateJson<Record<string,unknown>>(folder+"/pin.json");if(typeof pin.combinedDeadlineUnixMs!=="number"||pin.combinedDeadlineUnixMs>combinedDeadline||typeof pin.combinedElapsedSeconds!=="number"||pin.combinedElapsedSeconds>=2700||pin.stalePartStatus!==404||![403,409,410].includes(pin.revokedGrantStatus as number))throw fail();
  combinedDeadline=batchedDeadline(combinedDeadline,pin.combinedDeadlineUnixMs);notebook.combinedDeadlineUnixMs=combinedDeadline;
  notebook.status="passed";notebook.completedAt=new Date().toISOString();await save(folder+"/notebook.json",notebook);
  console.log(JSON.stringify({mode:"coalesced_transfer_gate_passed",epoch:config.expectedEpoch,workerVersion:config.expectedWorkerVersion,combinedDeadlineUnixMs:combinedDeadline,combinedElapsedSeconds:pin.combinedElapsedSeconds}));
 }catch{if(started){notebook.status="failed_or_unconfirmed";notebook.failedAt=new Date().toISOString();await save(folder+"/notebook.json",notebook).catch(()=>{});}throw fail();}
 finally{process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);if(admissionOpened)await closeAdmission();await pool.end();}
}
if((import.meta as ImportMeta&{main?:boolean}).main)main().catch(()=>{console.error(JSON.stringify({mode:"failed_or_unconfirmed",code:"batched_acceptance_refused"}));process.exitCode=1;});
