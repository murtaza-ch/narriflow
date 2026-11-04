import { createWriteStream } from "node:fs";
import { lstat,rm,stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { MAX_UPLOAD_SIZE_BYTES } from "@narriflow/validators/upload";
import { ingestDirectReadSchema,type IngestDirectRead } from "@narriflow/validators/execution";
import { driveDownloadRefusal } from "@narriflow/services/drive-source-contract";
import { readResponseTextBounded,assertResponseContentLength } from "@narriflow/services/url-policy";
import { guardedFetch,createByteLimitTransform,RemoteFetchError,UnsafeUrlError } from "./outbound-transport";

export class DirectSourceFailure extends Error {
 constructor(readonly code:string,readonly retryable=false){super(code);}
}
/** File hosts label media with these. Web pages still stop here; the probe decides what the bytes are. */
const GENERIC_MEDIA_CONTENT_TYPES=new Set(["application/octet-stream","binary/octet-stream","application/binary","application/x-binary","application/download","application/force-download","application/x-download","application/mp4","application/ogg","application/x-matroska"]);
/** One guarded read implementation for direct, RSS, Drive and Zoom sources. */
export async function downloadDirectSource(raw:IngestDirectRead,targetPath:string,options:{
 fetch?:typeof guardedFetch;signal?:AbortSignal;deadlineMs?:number;maxBytes?:number;delay?:(milliseconds:number)=>Promise<void>;
}={}){
 const input=ingestDirectReadSchema.parse(raw),maximum=options.maxBytes??MAX_UPLOAD_SIZE_BYTES;
 const deadline=options.deadlineMs??45*60_000;
 if(!Number.isSafeInteger(maximum)||maximum<=0||maximum>MAX_UPLOAD_SIZE_BYTES||!Number.isSafeInteger(deadline)||deadline<=0||deadline>45*60_000)throw new DirectSourceFailure("worker_invalid_payload");
 if(await lstat(targetPath).then(()=>true,()=>false))throw new DirectSourceFailure("source_target_invalid");
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(deadline)]):AbortSignal.timeout(deadline);
 for(let attempt=0;attempt<4;attempt++){
  signal.throwIfAborted();let response:Response|undefined,created=false;
  try{
   response=await(options.fetch??guardedFetch)(input.url,{signal,timeoutMs:deadline,headers:{accept:"audio/*, video/*, application/octet-stream;q=0.8","user-agent":"NarriflowBot/1.0 (+https://narriflow.app)",...(input.authorization?{authorization:input.authorization}:{})}});
   if(!response.ok||!response.body){
    if(input.provider==="drive"&&[401,403,404].includes(response.status)){
     const refusal=driveDownloadRefusal(response.status,await readResponseTextBounded(response,16*1024).catch(()=>""));
     if(refusal!=="transient")throw new DirectSourceFailure(refusal.code);
     throw new DirectSourceFailure("source_download_failed",true);
    }
    if(input.provider==="zoom"&&[401,403,404].includes(response.status))throw new DirectSourceFailure("zoom_recording_unavailable");
    throw new DirectSourceFailure("source_download_failed",response.status===429||response.status>=500);
   }
   assertResponseContentLength(response,maximum);
   const contentType=response.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
   if(!contentType||!contentType.startsWith("audio/")&&!contentType.startsWith("video/")&&!GENERIC_MEDIA_CONTENT_TYPES.has(contentType))throw new DirectSourceFailure("remote_media_invalid_content_type");
   const file=createWriteStream(targetPath,{flags:"wx",mode:0o600});created=true;
   await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),createByteLimitTransform(maximum),file,{signal});
   const size=(await stat(targetPath)).size;if(!size)throw new DirectSourceFailure("source_download_failed",true);
   return {byteLength:size,contentType};
  }catch(error){
   if(created)await rm(targetPath,{force:true});
   signal.throwIfAborted();
   const failure=error instanceof DirectSourceFailure?error:error instanceof UnsafeUrlError?new DirectSourceFailure("remote_url_unsafe"):
    error instanceof RemoteFetchError?new DirectSourceFailure(error.code==="remote_response_too_large"?"remote_media_too_large":error.code,error.code==="remote_download_failed"):
    new DirectSourceFailure("source_download_failed",true);
   if(attempt===3||!failure.retryable)throw failure;
   if(options.delay)await options.delay(2000*2**attempt);else await sleep(2000*2**attempt,undefined,{signal});
  }finally{if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>undefined);}
 }
 throw new DirectSourceFailure("source_download_failed",true);
}
