import { z } from "zod";
const code=z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/);
const operation=z.strictObject({kind:z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),state:z.record(z.string(),z.json()),lookupKey:z.string().min(1).max(2048).optional()});
const receipt=z.strictObject({receiptId:z.string().min(1).max(2048),deliveryMode:z.enum(["direct","tiktok_inbox"]).optional(),platformPostIds:z.array(z.string().min(1).max(2048)).max(100).optional(),platformPostId:z.string().min(1).max(2048).nullable(),externalUrl:z.string().url().max(2048).nullable(),providerProcessingStatus:z.enum(["processing","succeeded","failed"]).nullable().optional(),providerProcessingFailureCode:code.nullable().optional(),providerVisibility:z.string().min(1).max(100).nullable().optional()});
export const publicationNativeCommandSchema=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("checkpoint"),operation}),
 z.strictObject({kind:z.literal("provider_call"),operation:z.enum(["initialize","upload","submit","read","cleanup"])}),
 z.strictObject({kind:z.literal("accepted"),receipt}),
 z.strictObject({kind:z.literal("pending"),receiptId:z.string().min(1).max(2048),operation,nextCheckAt:z.iso.datetime(),submissionStarted:z.boolean().optional()}),
 z.strictObject({kind:z.literal("unknown"),code,operation:operation.nullable(),retryAfterMs:z.number().int().nonnegative().max(86400000).nullable().optional()}),
 z.strictObject({kind:z.literal("failed"),failure:z.strictObject({code,phase:z.enum(["preparation","upload","submission","reconciliation","cleanup"]),disposition:z.enum(["safe_retry","permanent","attention"]),retryAfterMs:z.number().int().nonnegative().max(86400000).nullable(),safeToRepublishAfterSubmission:z.boolean().optional(),evidence:z.record(z.string(),z.json()).optional()})}),
 z.strictObject({kind:z.literal("interrupted")}),
]).refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=48*1024,"Publication metadata exceeds48KiB");
/** Inbox replies contain outcome metadata only. Credentials and scoped URLs
 * are returned by the separately authorized work-package transport. */
export const publicationNativeReplySchema=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("recorded")}),
 z.strictObject({kind:z.literal("settled"),outcome:z.enum(["posted","inbox_delivered","failed","needs_attention","processing","reconciling","retry_scheduled","interrupted"]),attemptId:z.string().uuid(),socialPostId:z.string().uuid(),nextActionAt:z.iso.datetime().optional(),nextAttemptId:z.string().uuid().optional(),code:code.optional()}),
]);
export type PublicationNativeCommand=z.infer<typeof publicationNativeCommandSchema>;
export type PublicationNativeReply=z.infer<typeof publicationNativeReplySchema>;
