import { expect, test } from "bun:test";
import { publicationExecutionInputHash, publicationReleaseAt, spreadScheduledPublish, type PublicationSchedule } from "./publication-dispatch";
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

test("scheduled posts spread over two minutes, never early, and a post keeps its slot",()=>{
 const scheduledFor=new Date("2026-11-06T09:00:00.000Z");
 const offsets=Array.from({length:200},(_,index)=>spreadScheduledPublish(`post-${index}`,scheduledFor).getTime()-scheduledFor.getTime());
 expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
 expect(Math.max(...offsets)).toBeLessThan(120_000);
 expect(new Set(offsets).size).toBeGreaterThan(190);
 expect(spreadScheduledPublish("post-1",scheduledFor)).toEqual(spreadScheduledPublish("post-1",scheduledFor));
});

test("only a planned publish is spread: post now, retries and unscheduled posts keep their exact time",()=>{
 const scheduledFor=new Date("2026-11-06T09:00:00.000Z"),createdAt=new Date("2026-11-06T08:00:00.000Z"),retry=new Date("2026-11-06T09:30:00.000Z"),postNow=new Date("2026-11-06T09:00:17.482Z");
 expect(publicationReleaseAt({id:"p",nextAttemptAt:null,scheduledFor:postNow,createdAt})).toEqual(postNow);
 expect(publicationReleaseAt({id:"p",nextAttemptAt:null,scheduledFor,createdAt})).toEqual(spreadScheduledPublish("p",scheduledFor));
 expect(publicationReleaseAt({id:"p",nextAttemptAt:retry,scheduledFor,createdAt})).toEqual(retry);
 expect(publicationReleaseAt({id:"p",nextAttemptAt:null,scheduledFor:null,createdAt})).toEqual(createdAt);
});
