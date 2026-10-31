import { S3Client,PutObjectCommand,DeleteObjectCommand,HeadObjectCommand } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { createHash,randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import { createExecutionStorage } from "../src/execution-storage";
const directory=process.env.R2_PREFIX_GATE_DIR;
if(!directory||!isAbsolute(directory))throw new Error("gate_directory_required");
const accountId=process.env.R2_ACCOUNT_ID!,accessKeyId=process.env.R2_ACCESS_KEY_ID!,secretAccessKey=process.env.R2_SECRET_ACCESS_KEY!;
if(accountId!=="5359f28d385b8632c3abee12d1f5b011"||!accessKeyId||!secretAccessKey)throw new Error("requested_account_unavailable");
const bucket="narriflow-dev",key=`execution/platform-gates/${randomUUID()}/first-range.bin`,token=randomUUID()+randomUUID();
const storage=createExecutionStorage({accountId,bucket,accessKeyId,secretAccessKey});
const client=new S3Client({region:"auto",endpoint:`https://${accountId}.r2.cloudflarestorage.com`,credentials:{accessKeyId,secretAccessKey},requestHandler:new FetchHttpHandler({requestTimeout:10000}),maxAttempts:1,requestChecksumCalculation:"WHEN_REQUIRED",responseChecksumValidation:"WHEN_REQUIRED"});
await mkdir(directory,{recursive:true,mode:0o700});
try{const prior=JSON.parse(await readFile(join(directory,"private-state.json"),"utf8"));if(prior.cleaned!==true)throw new Error("gate_recovery_required");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
await writeFile(join(directory,"private-state.json"),JSON.stringify({bucket,key,cleaned:false}),{mode:0o600});
try{
 const body=Buffer.from("narriflow-owned-prefix-range-fixture"),put=await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:"application/octet-stream",ContentLength:body.length,ContentMD5:createHash("md5").update(body).digest("base64"),IfNoneMatch:"*"}));
 if(!put.ETag)throw new Error("gate_fixture_unconfirmed");
 const source={name:"upload_source",storageKey:key,etag:put.ETag,byteLength:body.length},grant=await storage.signSource(source,{leaseExpiresAt:new Date(Date.now()+120000),operationDeadlineAt:new Date(Date.now()+300000)});
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  if(request.method!=="POST"||new URL(request.url).pathname!=="/cleanup"||request.headers.get("authorization")!==`Bearer ${token}`)return Response.json({code:"gate_refused"},{status:403});
  try{
   await client.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
   let missing=false;try{await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}));}catch(error){missing=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404;}
   if(!missing)return Response.json({code:"gate_cleanup_unconfirmed"},{status:500});
   await writeFile(join(directory,"private-state.json"),JSON.stringify({bucket,key,cleaned:true}),{mode:0o600});
   return Response.json({deleted:1,verifiedMissing:true});
  }catch{return Response.json({code:"gate_cleanup_unconfirmed"},{status:500});}
 }});
 await writeFile(join(directory,"ready.json"),JSON.stringify({source:{...source,...grant,expiresAt:grant.expiresAt.toISOString()},cleanupUrl:`http://127.0.0.1:${server.port}/cleanup`,token}),{mode:0o600});
 console.log(JSON.stringify({message:"r2_source_prefix_gate_ready",requestedAccountVerified:true}));
}catch{console.error(JSON.stringify({message:"r2_source_prefix_gate_failed",recoveryJournalPresent:true}));process.exitCode=1;}
