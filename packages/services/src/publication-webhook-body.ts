import type { PublicationPlatformInput } from "./social-publication-platform";
/** Ordered serialization is shared by Worker signing and native delivery.
 * A fresh URL-only grant never enters durable input or a command receipt. */
export function publicationWebhookBody(
	input: Pick<
		PublicationPlatformInput,
		| "attemptId"
		| "idempotencyKey"
		| "socialPostId"
		| "projectId"
		| "platform"
		| "caption"
		| "scheduledFor"
		| "providerSettings"
		| "media"
	>,
	scoped: { url: string; expiresAt: Date },
) {
	return JSON.stringify({
		contractVersion: 1,
		event: "social.post.publish",
		attemptId: input.attemptId,
		idempotencyKey: input.idempotencyKey,
		socialPostId: input.socialPostId,
		projectId: input.projectId,
		platform: input.platform,
		caption: input.caption,
		scheduledFor: input.scheduledFor.toISOString(),
		providerSettings: input.providerSettings,
		media: {
			url: scoped.url,
			expiresAt: scoped.expiresAt.toISOString(),
			contentType: input.media.contentType,
			fileName: input.media.fileName,
			byteLength: input.media.sizeBytes,
			aspectRatio: input.media.aspectRatio,
		},
	});
}
