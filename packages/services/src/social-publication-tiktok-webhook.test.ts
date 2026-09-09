import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	parseTikTokPublicationWebhook,
	TikTokPublicationWebhookError,
	verifyTikTokWebhookSignature,
} from "./social-publication-tiktok-webhook";

const NOW = new Date("2026-08-28T10:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const SECRET = "test-tiktok-client-secret";

function signature(rawBody: string, timestamp = TIMESTAMP) {
	const value = createHmac("sha256", SECRET)
		.update(`${timestamp}.${rawBody}`)
		.digest("hex");
	return `t=${timestamp},s=${value}`;
}

describe("TikTok publication webhook contract", () => {
	test("verifies the raw body signature and replay window", () => {
		const rawBody = '{"event":"post.publish.complete"}';
		expect(() =>
			verifyTikTokWebhookSignature({
				rawBody,
				signature: signature(rawBody),
				clientSecret: SECRET,
				now: NOW,
			}),
		).not.toThrow();
		expect(() =>
			verifyTikTokWebhookSignature({
				rawBody: `${rawBody} `,
				signature: signature(rawBody),
				clientSecret: SECRET,
				now: NOW,
			}),
		).toThrow(TikTokPublicationWebhookError);
		expect(() =>
			verifyTikTokWebhookSignature({
				rawBody,
				signature: signature(rawBody, String(Number(TIMESTAMP) - 301)),
				clientSecret: SECRET,
				now: NOW,
			}),
		).toThrow("replay window");
	});

	test("parses current content-posting events and rejects a different app", () => {
		const event = JSON.stringify({
			client_key: "client-key",
			event: "post.publish.publicly_available",
			create_time: Number(TIMESTAMP),
			user_openid: "creator",
			content: JSON.stringify({
				publish_id: "publish-1",
				post_id: 123456789,
				publish_type: "DIRECT_POST",
			}),
		});
		expect(parseTikTokPublicationWebhook(event, "client-key")).toEqual({
			event: "post.publish.publicly_available",
			publishId: "publish-1",
			postId: "123456789",
			reason: null,
			publishType: "DIRECT_POST",
		});
		expect(() => parseTikTokPublicationWebhook(event, "other-client")).toThrow(
			"client key",
		);
	});

	test("ignores unrelated events and validates serialized content", () => {
		expect(
			parseTikTokPublicationWebhook(
				JSON.stringify({
					client_key: "client-key",
					event: "authorization.removed",
				}),
				"client-key",
			),
		).toBeNull();
		expect(() =>
			parseTikTokPublicationWebhook(
				JSON.stringify({
					client_key: "client-key",
					event: "post.publish.failed",
					content: "not-json",
				}),
				"client-key",
			),
		).toThrow("serialized JSON");
	});
});
