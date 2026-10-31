import { createHash } from "node:crypto";
import { GeneratedMediaValidationPending, type GeneratedMediaPublisher } from "./generated-media";
import type { BrandActorScope } from "./brand-ownership";
import type { GeneratedValidationPlan, NativeValidationInput } from "@narriflow/validators/native-validation";

export class GeneratedMediaPublicationError extends Error {
 constructor(readonly code:string){super(code);this.name="GeneratedMediaPublicationError";}
}
export function createGeneratedMediaPublisher(dependencies:{
 current(jobId:string):Promise<{validationJobId:string|null;validationInput:GeneratedValidationPlan|null}|null>;
 plan(jobId:string,claimId:string,source:GeneratedValidationPlan):Promise<GeneratedValidationPlan>;
 exists(source:GeneratedValidationPlan):Promise<boolean>;
 stage(input:{key:string;bytes:Uint8Array;contentType:string}):Promise<void>;
 admit(scope:BrandActorScope,request:{jobId:string;claimId:string;input:Extract<NativeValidationInput,{kind:"visual"}>}):Promise<{jobId:string}>;
 maxBytes?:number;
}):GeneratedMediaPublisher {
 const maxBytes=dependencies.maxBytes??20*1024*1024;
 return {async publish(input){
  if(!input.claimId)throw new GeneratedMediaPublicationError("generated_media_claim_lost");
  const current=await dependencies.current(input.jobId);
  if(!current)throw new GeneratedMediaPublicationError("generated_media_claim_lost");
  if(current.validationJobId)throw new GeneratedMediaValidationPending(current.validationJobId);
  let source=current.validationInput;
  const bytes=input.result?.bytes;
  if(input.result?.url)throw new GeneratedMediaPublicationError("generated_media_output_invalid");
  if(!source){
   if(!bytes)throw new GeneratedMediaPublicationError("generated_media_attempt_unavailable");
   if(input.result?.contentType!==input.resultContentType||bytes.length<1||bytes.length>maxBytes)throw new GeneratedMediaPublicationError("generated_media_output_invalid");
   const fingerprint=createHash("sha256").update(bytes).digest("hex");
   const extension=input.resultContentType==="image/png"?"png":input.resultContentType==="image/jpeg"?"jpg":"webp";
   const key=`workspaces/${input.scope.workspaceId}/generated-media-attempts/${input.jobId}/${input.claimId}/${fingerprint}.${extension}`;
   source=await dependencies.plan(input.jobId,input.claimId,{key,fingerprint,contentType:input.resultContentType,sizeBytes:bytes.length,sourceClaimLineage:input.claimId,parentAttempt:input.attempt,providerRef:input.providerRef});
  }
  if(source.parentAttempt!==input.attempt||source.providerRef!==input.providerRef||source.contentType!==input.resultContentType)throw new GeneratedMediaPublicationError("generated_media_claim_lost");
  if(bytes&&(bytes.length!==source.sizeBytes||createHash("sha256").update(bytes).digest("hex")!==source.fingerprint))throw new GeneratedMediaPublicationError("generated_media_output_invalid");
  if(!await dependencies.exists(source)){
   if(!bytes)throw new GeneratedMediaPublicationError("generated_media_attempt_unavailable");
   try{await dependencies.stage({key:source.key,bytes,contentType:source.contentType});}
   catch(error){if(!await dependencies.exists(source))throw error;}
  }
  try {
   const job=await dependencies.admit(input.scope,{jobId:input.jobId,claimId:input.claimId,input:{kind:"visual",key:source.key,contentType:source.contentType,sizeBytes:source.sizeBytes,fingerprint:source.fingerprint,title:input.title,provenance:"generated"}});
   throw new GeneratedMediaValidationPending(job.jobId);
  } catch(error){
   const parked=await dependencies.current(input.jobId);
   if(parked?.validationJobId)throw new GeneratedMediaValidationPending(parked.validationJobId);
   throw error;
  }
 }};
}
