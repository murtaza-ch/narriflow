import {expect,test} from "bun:test";
import {hkdfSync} from "node:crypto";
import {derivePublicationPurposeKey,sealPublicationPayload,openPublicationPayload} from "./publication-checkpoint-blob";
const scope={deploymentEpoch:1,socialPostId:"00000000-0000-4000-8000-000000000001",attemptId:"00000000-0000-4000-8000-000000000002",claimId:"00000000-0000-4000-8000-000000000003",bindingHash:"a".repeat(64)};
test("publication keys match independent HKDF and separate purpose, epoch and claim",async()=>{
 const secret=Buffer.alloc(32,7),key=await derivePublicationPurposeKey(secret.toString("base64"),scope,"linkedin_instructions");
 const independent=Buffer.from(hkdfSync("sha256",secret,Buffer.from("narriflow-publication-blob-v1"),Buffer.from(JSON.stringify(["narriflow-publication-v1","linkedin_instructions",1,scope.socialPostId,scope.attemptId,scope.claimId,scope.bindingHash])),32)).toString("base64url");
 expect(key).toBe(independent);
 expect(await derivePublicationPurposeKey(secret.toString("base64"),scope,"input_state")).not.toBe(key);
 expect(await derivePublicationPurposeKey(secret.toString("base64"),{...scope,deploymentEpoch:2},"linkedin_instructions")).not.toBe(key);
 const bytes=await sealPublicationPayload({privateUrl:"https://www.linkedin.com/private?grant=secret"},key,scope,"linkedin_instructions");
 expect(Buffer.from(bytes).toString("utf8")).not.toContain("secret");
 expect(await openPublicationPayload(bytes,key,scope,"linkedin_instructions")).toEqual({privateUrl:"https://www.linkedin.com/private?grant=secret"});
 await expect(openPublicationPayload(bytes,key,{...scope,claimId:scope.attemptId},"linkedin_instructions")).rejects.toThrow("publication_checkpoint_invalid");
 const changed=bytes.slice();changed[changed.length-1]^=1;
 await expect(openPublicationPayload(changed,key,scope,"linkedin_instructions")).rejects.toThrow("publication_checkpoint_invalid");
});
