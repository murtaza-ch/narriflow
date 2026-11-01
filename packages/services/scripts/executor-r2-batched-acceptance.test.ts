import {mkdir,writeFile,readFile,lstat,rm,symlink,chmod} from "node:fs/promises";
import {expect,test} from "bun:test";
import {batchedAcceptanceConfig,batchedRestoreProof,batchedDeadline,batchedTimings,prepareBatchedOutputDirectory,batchedNativeReport} from "./executor-r2-batched-acceptance";
const config={version:2,outputDirectory:"/tmp/narriflow-executor-r2-fresh-unit",expectedEpoch:10,expectedWorkerVersion:"new-verified-version",apiOrigin:"https://candidate.narriflow.test",qualifiedRestoreProofPath:"/private/actual-restore-verified.json",expectedFunctionId:"fu-12345678901234567890",modalSourceWitness:"a".repeat(40)};
test("the coalesced gate requires epoch10 and a passed fresh8/9/10 qualified restore",()=>{
 expect(batchedAcceptanceConfig(config)).toEqual(config);
 for(const change of [{version:1},{version:3},{outputDirectory:"/tmp/narriflow-executor-r2-fresh/../failed"},{outputDirectory:"/tmp/narriflow-executor-r2-"+"a".repeat(65)},{outputDirectory:"/tmp/other-gate"},{modalSourceWitness:"35ca"},{modalSourceWitness:"a".repeat(39)},{modalSourceWitness:"a".repeat(64)},{expectedEpoch:2},{expectedEpoch:3},{expectedEpoch:5},{expectedEpoch:7},{expectedEpoch:8},{expectedEpoch:9},{expectedEpoch:null},{expectedWorkerVersion:""},{expectedFunctionId:"latest"},{modalSourceWitness:"old-005f"},{qualifiedRestoreProofPath:"relative.json"}])expect(()=>batchedAcceptanceConfig({...config,...change})).toThrow();
 const proof={mode:"qualified_restore_verified",sourceEpoch:8,snapshotEpoch:9,targetEpoch:10,chargedStarts:2,staleCommit:"superseded",publishedAssets:1,operationDeadlineAt:"2026-11-01T22:10:00.000Z",completedAt:"2026-11-01T22:09:00.000Z"};
 expect(()=>batchedRestoreProof(proof)).not.toThrow();
 for(const change of [{sourceEpoch:3,snapshotEpoch:4,targetEpoch:5},{sourceEpoch:5,snapshotEpoch:6,targetEpoch:7},{sourceEpoch:6,snapshotEpoch:7,targetEpoch:8},{targetEpoch:9},{chargedStarts:1},{staleCommit:"committed"},{mode:"pending"},{operationDeadlineAt:"invalid"},{completedAt:"2026-11-01T22:11:00.000Z"}])expect(()=>batchedRestoreProof({...proof,...change})).toThrow();
});
test("both phases keep one nominal SQL deadline rather than confusing a conservative local cutoff with a new budget",()=>{
 expect(batchedDeadline(2700000)).toBe(2700000);
 expect(batchedDeadline(2700000,2700000)).toBe(2700000);
 expect(()=>batchedDeadline(2700000,2600000)).toThrow();
 expect(()=>batchedDeadline(2700000,5400000)).toThrow();
 expect(()=>batchedDeadline(Number.NaN)).toThrow();
});
test("only fixed numeric timing summaries leave the private native report",()=>{
 const timing={calls:4,failures:0,sumSeconds:9,maxSeconds:3,meanSeconds:2.25,maxConcurrentCalls:4,unfinishedCalls:0,histogramCounts:[1,2,1],histogramUpperSeconds:[1,2,null]};
 expect(batchedTimings({authorize_part:timing})).toEqual({authorize_part:{calls:4,failures:0,sumSeconds:9,maxSeconds:3,meanSeconds:2.25,maxConcurrentCalls:4,unfinishedCalls:0}});
 for(const raw of [{private_url:timing},{authorize_part:{...timing,meanSeconds:"https://secret.invalid"}},{authorize_part:{...timing,unfinishedCalls:1}},{authorize_part:{...timing,sumSeconds:Number.NaN}}])expect(()=>batchedTimings(raw)).toThrow();
});

test("a private fresh output directory gets one exclusive lock and cannot be reused",async()=>{
 const folder="/tmp/narriflow-executor-r2-test-"+crypto.randomUUID();
 try{
  await prepareBatchedOutputDirectory(folder);
  expect((await lstat(folder)).mode&0o777).toBe(0o700);
  const lock=await lstat(folder+"/run.lock");expect(lock.mode&0o777).toBe(0o600);
  await expect(prepareBatchedOutputDirectory(folder)).rejects.toThrow("batched_acceptance_refused");
  expect((await lstat(folder+"/run.lock")).ino).toBe(lock.ino);
 }finally{await rm(folder,{recursive:true,force:true});}
});
test("prior evidence, unsafe permissions and symlink destinations are refused without rewriting them",async()=>{
 const folder="/tmp/narriflow-executor-r2-test-"+crypto.randomUUID(),target=folder+"-target",link=folder+"-link",unsafe=folder+"-unsafe";
 try{
  await mkdir(folder,{mode:0o700});await writeFile(folder+"/upload.json","retained failed evidence",{mode:0o600});
  await expect(prepareBatchedOutputDirectory(folder)).rejects.toThrow("batched_acceptance_refused");
  expect(await readFile(folder+"/upload.json","utf8")).toBe("retained failed evidence");
  await mkdir(target,{mode:0o700});await symlink(target,link);
  await expect(prepareBatchedOutputDirectory(link)).rejects.toThrow("batched_acceptance_refused");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  await mkdir(unsafe,{mode:0o755});await chmod(unsafe,0o755);
  await expect(prepareBatchedOutputDirectory(unsafe)).rejects.toThrow("batched_acceptance_refused");
  expect((await lstat(unsafe)).mode&0o777).toBe(0o755);
 }finally{for(const path of [link,target,unsafe,folder])await rm(path,{recursive:true,force:true});}
});

test("a stable Function ID cannot qualify a passed report from a different source image",()=>{
 const source="a".repeat(40),report={status:"passed",phase:"upload",sourceCommit:source,runtime:{profile:"lean"}};
 expect(batchedNativeReport(report,"upload",source)).toEqual(report);
 for(const change of [{sourceCommit:"b".repeat(40)},{sourceCommit:undefined},{sourceCommit:"35ca"},{phase:"pin"},{status:"failed"}]){
  expect(()=>batchedNativeReport({...report,...change},"upload",source)).toThrow("batched_acceptance_refused");
 }
});
