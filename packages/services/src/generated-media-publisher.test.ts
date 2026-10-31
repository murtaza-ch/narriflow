import { expect,test } from "bun:test";
import { createHash } from "node:crypto";
import { createGeneratedMediaPublisher } from "./generated-media-publisher";
import { GeneratedMediaValidationPending } from "./generated-media";
import type { GeneratedValidationPlan } from "@narriflow/validators/native-validation";

const scope={actorUserId:"00000000-0000-4000-8000-000000000001",workspaceId:"00000000-0000-4000-8000-000000000002",workspaceOwnerUserId:"00000000-0000-4000-8000-000000000001",role:"owner" as const,status:"active" as const,pricingTier:"business",isPersonalWorkspace:true};
const input={jobId:"00000000-0000-4000-8000-000000000003",claimId:"00000000-0000-4000-8000-000000000004",attempt:1,providerRef:"openai:one",scope,title:"Generated frame",resultContentType:"image/png" as const,result:{contentType:"image/png" as const,bytes:new Uint8Array([137,80,78,71])}};
const planned:GeneratedValidationPlan={key:`workspaces/${scope.workspaceId}/generated-media-attempts/${input.jobId}/${input.claimId}/image.png`,contentType:"image/png",sizeBytes:4,fingerprint:createHash("sha256").update(input.result.bytes).digest("hex"),sourceClaimLineage:input.claimId,parentAttempt:1,providerRef:input.providerRef};
test("the immutable source plan commits before upload; only a native child may publish the asset",async()=>{
 const events:string[]=[];let request:unknown;
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:null,validationInput:null}),plan:async(_id,_claim,source)=>{events.push("plan");return source;},exists:async()=>false,stage:async stage=>{events.push("stage");expect(stage.key).toContain(`/${input.jobId}/${input.claimId}/`);expect(stage.bytes).toBe(input.result.bytes);},admit:async(_scope,value)=>{events.push("admit");request=value;return{jobId:"validation1"};}});
 await expect(publisher.publish(input)).rejects.toBeInstanceOf(GeneratedMediaValidationPending);
 expect(events).toEqual(["plan","stage","admit"]);expect(request).toMatchObject({jobId:input.jobId,claimId:input.claimId,input:{kind:"visual",sizeBytes:4,provenance:"generated"}});
});
test("a lost upload ACK reattaches the exact source after HEAD and never selects another object",async()=>{
 let uploaded=false,stages=0;
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:null,validationInput:null}),plan:async()=>planned,exists:async source=>{expect(source).toEqual(planned);return uploaded;},stage:async()=>{stages++;uploaded=true;throw new Error("ACK lost");},admit:async(_scope,request)=>{expect(request.input.key).toBe(planned.key);return{jobId:"child1"};}});
 await expect(publisher.publish(input)).rejects.toMatchObject({validationJobId:"child1"});expect(stages).toBe(1);
});
test("a fresh coordinator claim resumes the saved source without provider bytes or another upload",async()=>{
 let stages=0;const claimId="00000000-0000-4000-8000-000000000005";
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:null,validationInput:planned}),plan:async()=>{throw new Error("Plan is frozen");},exists:async()=>true,stage:async()=>{stages++;},admit:async(_scope,request)=>{expect(request.claimId).toBe(claimId);expect(request.input.key).toBe(planned.key);return{jobId:"child1"};}});
 await expect(publisher.publish({...input,claimId,result:undefined})).rejects.toMatchObject({validationJobId:"child1"});expect(stages).toBe(0);
});
test("a missing saved source is an unknown outcome; it cannot trigger a blind provider resubmit",async()=>{
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:null,validationInput:planned}),plan:async()=>planned,exists:async()=>false,stage:async()=>{throw new Error("No bytes available");},admit:async()=>{throw new Error("No source to admit");}});
 await expect(publisher.publish({...input,result:undefined})).rejects.toMatchObject({code:"generated_media_attempt_unavailable"});
});
test("replay after an admitted but unacknowledged dispatch keeps the existing child and never stages again",async()=>{
 let stages=0,admissions=0;
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:"existing-child",validationInput:planned}),plan:async()=>planned,exists:async()=>true,stage:async()=>{stages++;},admit:async()=>{admissions++;throw new Error("unreachable");}});
 await expect(publisher.publish(input)).rejects.toMatchObject({validationJobId:"existing-child"});expect(stages).toBe(0);expect(admissions).toBe(0);
});
test("unexpected provider URLs are rejected before staging or any outbound connection",async()=>{
 let stages=0;
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:null,validationInput:null}),plan:async()=>planned,exists:async()=>false,stage:async()=>{stages++;},admit:async()=>{throw new Error("unreachable");}});
 await expect(publisher.publish({...input,result:{contentType:"image/png",url:"http://127.0.0.1/private"}})).rejects.toMatchObject({code:"generated_media_output_invalid"});expect(stages).toBe(0);
});

test("a completed provider response lost before source planning remains unknown rather than releasing or resubmitting",async()=>{
 const publisher=createGeneratedMediaPublisher({current:async()=>({validationJobId:null,validationInput:null}),plan:async()=>planned,exists:async()=>false,stage:async()=>{throw new Error("No bytes");},admit:async()=>{throw new Error("No source");}});
 await expect(publisher.publish({...input,result:undefined})).rejects.toMatchObject({code:"generated_media_attempt_unavailable"});
});
