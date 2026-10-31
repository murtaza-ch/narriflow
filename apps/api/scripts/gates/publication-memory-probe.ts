import { createAssignedArtifactStorage } from "../../src/domains/execution/artifact-storage";
import { openPublicationPayload,derivePublicationPurposeKey,publicationCheckpointBindingHash } from "@narriflow/services/publication-checkpoint-blob";
import { linkedInInstructionBlobSchema } from "@narriflow/validators/publication-execution";
export const PUBLICATION_MEMORY_FIXTURE={key:"__serverless-cutover-gates/20261031/publication/instructions-16MiB.bin",artifactId:"00000000-0000-4000-8000-000000000004",master:"public-synthetic-publication-memory-fixture-only",scope:{deploymentEpoch:1,socialPostId:"00000000-0000-4000-8000-000000000001",attemptId:"00000000-0000-4000-8000-000000000002",claimId:"00000000-0000-4000-8000-000000000003",bindingHash:"a".repeat(64)}};
const isolateId=crypto.randomUUID();
/** Protected platform-gate host calls only this fixed, credential-free fixture.
 * Two reads/decryptions intentionally share a single actual Cloudflare isolate. */
export async function probePublicationMemory(bucket:R2Bucket,copies:1|2){
 if(copies!==1&&copies!==2)throw Error("publication_probe_invalid");
 const fixture=PUBLICATION_MEMORY_FIXTURE,head=await bucket.head(fixture.key);
 if(!head||head.size!==16*1024**2||!head.customMetadata?.["fixture-sha256"])throw Error("publication_probe_fixture_missing");
 const artifact={artifactId:fixture.artifactId,role:"publication_checkpoint" as const,bindingHash:publicationCheckpointBindingHash(fixture.scope),storageKey:fixture.key,etag:head.httpEtag,byteLength:BigInt(head.size),contentType:"application/octet-stream",sha256:head.customMetadata["fixture-sha256"]};
 const storage=createAssignedArtifactStorage(bucket),key=await derivePublicationPurposeKey(fixture.master,fixture.scope,"linkedin_instructions");
 const results=await Promise.all(Array.from({length:copies},async()=>{
  const cipher=await storage.readBytes(artifact,16*1024**2);
  const instructions=linkedInInstructionBlobSchema.parse(await openPublicationPayload(cipher,key,fixture.scope,"linkedin_instructions"));
  return {byteLength:cipher.byteLength,instructions:instructions.uploadInstructions.length,totalBytes:instructions.totalBytes};
 }));return {runtime:"cloudflare-workerd",isolateId,copies,results};
}
