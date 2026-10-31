import { z } from "zod";
import { EXECUTION_TRANSFER_PART_BYTES } from "./execution-transfer";

/** Notifications use the existing bounded private-object contract, not inline payload bytes. */
export const NOTIFICATION_BODY_MAX_BYTES = EXECUTION_TRANSFER_PART_BYTES;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const notificationHeadersSchema=z.strictObject({
 "content-type":z.literal("application/json"),"user-agent":z.literal("Narriflow-Callbacks/1"),
 "webhook-id":z.string().uuid(),"webhook-timestamp":z.string().regex(/^\d{10,11}$/),
 "webhook-signature":z.string().min(1).max(4096).regex(/^v1,[A-Za-z0-9+/]+={0,2}(?: v1,[A-Za-z0-9+/]+={0,2})*$/),
});
export const signedNotificationCommandSchema=z.strictObject({
 kind:z.literal("signed_notification"),deliveryId:z.string().uuid(),eventId:z.string().uuid(),workspaceId:z.string().uuid(),inputHash:digest,
 url:z.url().max(2048).refine(value=>{const url=new URL(value);return url.protocol==="https:"&&url.port===""&&!url.username&&!url.password;}),
 body:z.strictObject({source:z.literal("notification_body"),sha256:digest,byteLength:z.number().int().positive().max(NOTIFICATION_BODY_MAX_BYTES)}),
 headers:notificationHeadersSchema,
}).refine(value=>value.headers["webhook-id"]===value.eventId);
export const notificationReceiptSchema=z.strictObject({
 version:z.literal(1),kind:z.literal("signed_notification"),deliveryId:z.string().uuid(),eventId:z.string().uuid(),workspaceId:z.string().uuid(),inputHash:digest,bodySha256:digest,
 status:z.number().int().min(100).max(599).nullable(),durationMs:z.number().int().nonnegative().max(120000),
 errorCode:z.enum(["remote_download_failed","remote_fetch_timeout","remote_redirect_invalid","remote_redirect_limit","remote_response_too_large","remote_url_unsafe"]).nullable(),
});
export type SignedNotificationCommand=z.infer<typeof signedNotificationCommandSchema>;
export type NotificationReceipt=z.infer<typeof notificationReceiptSchema>;
