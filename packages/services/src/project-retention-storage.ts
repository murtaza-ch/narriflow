import { createHash } from "node:crypto";
import { GetObjectCommand,HeadObjectCommand,PutObjectCommand,S3Client } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ExecutionStorageConfig } from "./execution-storage";
import type { ProjectDeletionProof } from "./project-retention-execution";
const invalid=()=>Error("project_deletion_receipt_invalid");
const maximum=8192;
function encode(key:string,proof:ProjectDeletionProof){if(proof.version!==1||proof.countBasis!=="acknowledged_exact_keys"||proof.byteBasis!=="known_committed_bytes"||!/^[a-f0-9]{64}$/.test(proof.projectIdHash)||key!==`retention-receipts/v1/${proof.projectIdHash}.json`||!Number.isSafeInteger(proof.objectCount)||proof.objectCount<0||!/^\d{1,30}$/.test(proof.totalBytes)||!proof.retentionPolicyKey||proof.retentionPolicyKey.length>100||![proof.expiresAt,proof.purgeCompletedAt,proof.deleteAfter].every(value=>Number.isSafeInteger(new Date(value).getTime()))||new Date(proof.deleteAfter)<=new Date(proof.purgeCompletedAt))throw invalid();const bytes=new TextEncoder().encode(JSON.stringify({version:proof.version,countBasis:proof.countBasis,byteBasis:proof.byteBasis,projectIdHash:proof.projectIdHash,retentionPolicyKey:proof.retentionPolicyKey,expiresAt:proof.expiresAt,purgeCompletedAt:proof.purgeCompletedAt,objectCount:proof.objectCount,totalBytes:proof.totalBytes,deleteAfter:proof.deleteAfter}));if(bytes.byteLength>maximum)throw invalid();return bytes;}
/** The only destination is the hash-addressed deletion-proof namespace in the
 * configured private bucket. Response loss can verify the same immutable proof;
 * it cannot overwrite another receipt or accept a caller-selected URL. */
export function createProjectDeletionReceiptStorage(config:ExecutionStorageConfig,options:{client?:S3Client}={}){
 if(!/^[a-f0-9]{32}$/.test(config.accountId)||!config.bucket||!config.accessKeyId||!config.secretAccessKey)throw Error("project_deletion_receipt_configuration_invalid");
 const client=options.client??new S3Client({region:"auto",endpoint:`https://${config.accountId}.r2.cloudflarestorage.com`,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestHandler:new FetchHttpHandler({requestTimeout:10000}),requestChecksumCalculation:"WHEN_REQUIRED",responseChecksumValidation:"WHEN_REQUIRED",maxAttempts:1});
 return {async writeDeletionReceipt(key:string,proof:ProjectDeletionProof){const bytes=encode(key,proof),sha256=createHash("sha256").update(bytes).digest("hex"),signal=()=>({abortSignal:AbortSignal.timeout(10000)});
  try{const result=await client.send(new PutObjectCommand({Bucket:config.bucket,Key:key,Body:bytes,ContentType:"application/json",IfNoneMatch:"*",Metadata:{"deletion-proof-sha256":sha256}}),signal());if(!result.ETag||!/^"[^"\r\n]+"$/.test(result.ETag))throw Error("project_deletion_receipt_ack_unknown");return;}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412&&(error as {name?:string}).name!=="PreconditionFailed")throw error;}
  const head=await client.send(new HeadObjectCommand({Bucket:config.bucket,Key:key}),signal());if(!head.ETag||head.ContentType!=="application/json"||head.ContentLength!==bytes.byteLength||head.Metadata?.["deletion-proof-sha256"]!==sha256)throw invalid();
  const value=await client.send(new GetObjectCommand({Bucket:config.bucket,Key:key,IfMatch:head.ETag,Range:`bytes=0-${bytes.byteLength-1}`}),signal());if(!value.Body||value.ETag!==head.ETag||value.ContentLength!==bytes.byteLength)throw invalid();const reader=value.Body.transformToWebStream().getReader(),hash=createHash("sha256");let total=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))throw invalid();total+=chunk.value.byteLength;if(total>bytes.byteLength)throw invalid();hash.update(chunk.value);}if(total!==bytes.byteLength||hash.digest("hex")!==sha256)throw invalid();}finally{await reader.cancel().catch(()=>{});if(typeof reader.releaseLock==="function")reader.releaseLock();}
 }};
}
