import {z} from "zod";
/** Private encrypted provider payload; never a Workflow or API response. */
export const notificationDeliveryPayloadSchema=z.strictObject({
 to:z.string().email().max(320),from:z.string().min(1).max(512),subject:z.string().min(1).max(512),
 html:z.string().max(65536).optional(),text:z.string().max(65536).optional(),
}).refine(value=>Boolean(value.html?.trim()||value.text?.trim()));
export const notificationDeliveryFactsSchema=z.strictObject({clipCount:z.number().int().nonnegative().nullable(),reason:z.string().max(2000).nullable()});

export const notificationDeliveryEnvelopeSchema=z.strictObject({contextFingerprint:z.string().regex(/^[a-f0-9]{64}$/),request:notificationDeliveryPayloadSchema});
