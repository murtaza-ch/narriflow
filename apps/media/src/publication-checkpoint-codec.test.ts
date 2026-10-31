import { expect,test } from "bun:test";
import { createPublicationCheckpointCodec } from "./publication-checkpoint-codec";
import { derivePublicationPurposeKey,openPublicationPayload } from "@narriflow/services/publication-checkpoint-blob";
import type { PublicationEphemeral } from "@narriflow/validators/publication-execution";
import type { PublicationProviderOperation } from "@narriflow/services/social-publication-platform";
const master="c".repeat(64);
async function context(){const scope={deploymentEpoch:1,socialPostId:crypto.randomUUID(),attemptId:crypto.randomUUID(),claimId:crypto.randomUUID(),bindingHash:"a".repeat(64)};return {version:1,inputKey:{scope,key:await derivePublicationPurposeKey(master,scope,"input_state")},checkpointKey:{scope,key:await derivePublicationPurposeKey(master,scope,"linkedin_instructions")},account:null} satisfies PublicationEphemeral;}
test("large LinkedIn plans become one encrypted assignment and bounded per-part checkpoints, then resume the original upload",async()=>{
 const access=await context(),artifactId=crypto.randomUUID(),count=300,partBytes=4*1024**2;
 const instructions=Array.from({length:count},(_,index)=>({uploadUrl:`https://video.licdn.com/upload/${index}?grant=${"opaque".repeat(100)}`,firstByte:index*partBytes,lastByte:(index+1)*partBytes-1}));
 const state={owner:"urn:li:person:owner",videoUrn:"urn:li:video:one",uploadToken:"private-provider-token",uploadInstructions:instructions,uploadedPartIds:[] as string[]};
 let blob:Uint8Array|undefined,uploads=0;
 const codec=await createPublicationCheckpointCodec({context:access,totalBytes:count*partBytes,operation:null,upload:async bytes=>{uploads++;blob=bytes;return artifactId;}});
 const first=await codec.encode({kind:"linkedin_video_upload",state});
 expect(uploads).toBe(1);expect(blob!.length).toBeGreaterThan(64*1024);expect(new TextDecoder().decode(blob)).not.toContain("private-provider-token");
 expect(JSON.stringify(first)).not.toContain("uploadUrl");expect(JSON.stringify(first).length).toBeLessThan(1024);
 state.uploadedPartIds.push("part-0");const second=await codec.encode({kind:"linkedin_video_upload",state});expect(second.state.uploadedPartIdsAppend).toEqual(["part-0"]);expect(second.state.uploadedPartCount).toBe(1);expect(uploads).toBe(1);
 const stored={...second,state:{owner:state.owner,videoUrn:state.videoUrn,uploadToken:state.uploadToken,uploadInstructionsRef:{artifactId},uploadedPartIds:["part-0"]}};
 const renewed=await context();renewed.inputKey.scope={...access.inputKey.scope,claimId:renewed.inputKey.scope.claimId};renewed.checkpointKey.scope=renewed.inputKey.scope;
 const resumed=await createPublicationCheckpointCodec({context:{...renewed,priorCheckpointKey:{...access.checkpointKey,artifactId}},totalBytes:count*partBytes,operation:stored,priorInstructions:blob,upload:async()=>{throw Error("must not initialize/upload a replacement plan");}});
 expect(resumed.initial?.state.uploadInstructions).toEqual(instructions);expect(resumed.initial?.state.uploadedPartIds).toEqual(["part-0"]);
 const next=resumed.initial!;const ids=next.state.uploadedPartIds as string[];ids.push("part-1");expect((await resumed.encode(next)).state.uploadedPartIdsAppend).toEqual(["part-1"]);
 const changed={...next,state:{...next.state,videoUrn:"urn:li:video:replacement"}};await expect(resumed.encode(changed)).rejects.toThrow("publication_checkpoint_changed");
 const decoded=await openPublicationPayload(blob!,access.checkpointKey.key,access.checkpointKey.scope,"linkedin_instructions") as {uploadInstructions:unknown[]};expect(decoded.uploadInstructions).toHaveLength(count);
});
test("a different claim cannot decrypt a plan, and a checkpoint cannot regress or rewrite acknowledged parts",async()=>{
 const access=await context(),id=crypto.randomUUID();let bytes:Uint8Array|undefined;
 const codec=await createPublicationCheckpointCodec({context:access,totalBytes:1,operation:null,upload:async value=>{bytes=value;return id;}});
 const operation:PublicationProviderOperation={kind:"linkedin_video_upload",state:{owner:"owner",videoUrn:"urn:li:video:one",uploadToken:"",uploadInstructions:[{uploadUrl:"https://video.licdn.com/upload",firstByte:0,lastByte:0}],uploadedPartIds:["part"]}};
 await codec.encode(operation);await expect(codec.encode({...operation,state:{...operation.state,uploadedPartIds:[]}})).rejects.toThrow("publication_checkpoint_changed");
 await expect(openPublicationPayload(bytes!,access.checkpointKey.key,{...access.checkpointKey.scope,claimId:crypto.randomUUID()},"linkedin_instructions")).rejects.toThrow();
});
