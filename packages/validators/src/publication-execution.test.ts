import {expect,test} from "bun:test";
import {publicationNativeCommandSchema,publicationNativeReplySchema} from "./publication-execution";
test("publication control is finite, bounded and replies contain no credentials or scoped URLs",()=>{
 expect(publicationNativeCommandSchema.parse({kind:"provider_call",operation:"read"})).toEqual({kind:"provider_call",operation:"read"});
 expect(publicationNativeCommandSchema.safeParse({kind:"provider_call",operation:"anything",accessToken:"secret"}).success).toBe(false);
 expect(publicationNativeCommandSchema.safeParse({kind:"checkpoint",operation:{kind:"upload",state:{large:"a".repeat(64*1024)}}}).success).toBe(false);
 for(const field of ["accessToken","signedUrl","url","media","checkpoint"])
  expect(publicationNativeReplySchema.safeParse({kind:"recorded",[field]:"private"}).success).toBe(false);
});

test("publication context rejects master keys, noncanonical keys and large credentials",async()=>{
 const {publicationEphemeralSchema}=await import("./publication-execution");
 const scope={deploymentEpoch:1,socialPostId:crypto.randomUUID(),attemptId:crypto.randomUUID(),claimId:crypto.randomUUID(),bindingHash:"a".repeat(64)},key={scope,key:Buffer.alloc(32,7).toString("base64url")};
 const value={version:1,inputKey:key,checkpointKey:key,account:null};
 expect(publicationEphemeralSchema.safeParse(value).success).toBe(true);
 expect(publicationEphemeralSchema.safeParse({...value,masterKey:"never"}).success).toBe(false);
 expect(publicationEphemeralSchema.safeParse({...value,inputKey:{scope,key:"b".repeat(43)}}).success).toBe(false);
});

test("LinkedIn instruction blobs freeze exact contiguous ranges and known HTTPS upload origins",async()=>{
 const {linkedInInstructionBlobSchema}=await import("./publication-execution");
 const value={version:1,kind:"linkedin_upload_instructions",owner:"urn:li:person:fixture",videoUrn:"urn:li:video:fixture",uploadToken:"",totalBytes:8,uploadInstructions:[{uploadUrl:"https://www.linkedin.com/dms-uploads/fixture",firstByte:0,lastByte:3},{uploadUrl:"https://www.linkedin.com/dms-uploads/fixture2",firstByte:4,lastByte:7}]};
 expect(linkedInInstructionBlobSchema.safeParse(value).success).toBe(true);
 expect(linkedInInstructionBlobSchema.safeParse({...value,totalBytes:9}).success).toBe(false);
 expect(linkedInInstructionBlobSchema.safeParse({...value,uploadInstructions:[{...value.uploadInstructions[0],uploadUrl:"https://127.0.0.1/private"},value.uploadInstructions[1]]}).success).toBe(false);
});
