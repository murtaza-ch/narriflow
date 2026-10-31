import { expect, test } from "bun:test";
import { publicationExecutionInputHash, type PublicationSchedule } from "./publication-dispatch";
const post={id:"p",workspaceId:"w",projectId:"project",createdByUserId:"actor",deploymentEpoch:1,generation:2,scheduleRevision:3,immutableRequestHash:"frozen",scheduledFor:new Date("2026-10-31T10:00:00Z"),standingGrantId:null,standingGrantRevision:null,frozenState:{id:"f",clipExportId:"e",clipExportVariantId:"v",editorRevision:7,exportFingerprint:"export",platform:"youtube_shorts",socialAccountId:"a",capabilityVersion:"c",providerSettings:{privacyStatus:"private",madeForKids:false},caption:"private copy"}} as PublicationSchedule;
test("publication identity binds schedule and physical cycle independently",()=>{
 const hash=publicationExecutionInputHash(post);
 expect(hash).toMatch(/^[a-f0-9]{64}$/);
 expect(publicationExecutionInputHash({...post,generation:3})).not.toBe(hash);
 expect(publicationExecutionInputHash({...post,scheduleRevision:4})).not.toBe(hash);
 expect(publicationExecutionInputHash({...post,status:"processing",nextAttemptAt:new Date()})).toBe(hash);
 expect(publicationExecutionInputHash({...post,frozenState:{...post.frozenState!,caption:"changed"}})).not.toBe(hash);
 expect(publicationExecutionInputHash({...post,frozenState:{...post.frozenState!,providerSettings:{madeForKids:false,privacyStatus:"private"}}})).toBe(hash);
 expect(publicationExecutionInputHash({...post,frozenState:{...post.frozenState!,providerSettings:{privacyStatus:"public",madeForKids:false}}})).not.toBe(hash);
});
