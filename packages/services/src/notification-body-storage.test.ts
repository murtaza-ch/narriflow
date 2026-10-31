import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { createNotificationBodyStorage } from "./notification-body-storage";

test("notification bodies are conditional, exact ETag sources and never overwrite an existing key", async () => {
	const bytes = new TextEncoder().encode('{"id":"test"}'),
		plan = {
			storageKey: `notifications/${crypto.randomUUID()}/${crypto.randomUUID()}/body.json`,
			byteLength: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	let writes = 0,
		reads = 0;
	const client = {
		send: async (command: unknown) => {
			if (command instanceof PutObjectCommand) {
				writes++;
				expect(command.input.IfNoneMatch).toBe("*");
				expect(command.input.Metadata?.["notification-sha256"]).toBe(
					plan.sha256,
				);
				return {};
			}
			if (command instanceof GetObjectCommand) {
				reads++;
				expect(command.input.IfMatch).toBe('"body"');
				expect(command.input.Range).toBe(`bytes=0-${bytes.byteLength - 1}`);
			}
			if (
				command instanceof GetObjectCommand ||
				command instanceof HeadObjectCommand
			)
				return {
					ETag: '"body"',
					ContentLength: bytes.byteLength,
					ContentType: "application/json",
					Metadata: { "notification-sha256": plan.sha256 },
					Body: {
						transformToWebStream: () =>
							new ReadableStream({
								start(c) {
									c.enqueue(bytes);
									c.close();
								},
							}),
					},
				};
			throw new Error("Unexpected command");
		},
	} as unknown as S3Client;
	const storage = createNotificationBodyStorage(
		{
			accountId: "a".repeat(32),
			bucket: "private",
			accessKeyId: "gate",
			secretAccessKey: "gate",
		},
		{ client },
	);
	await expect(storage.put(plan, new Uint8Array([1]))).rejects.toThrow(
		"notification_body_invalid",
	);
	expect(writes).toBe(0);
	await storage.put(plan, bytes);
	expect(writes).toBe(1);
	expect((await storage.head(plan))?.etag).toBe('"body"');
	expect(
		await new Response(await storage.read({ ...plan, etag: '"body"' })).text(),
	).toBe('{"id":"test"}');
	expect(reads).toBe(1);
	await expect(
		storage.read({ ...plan, storageKey: "outside/body.json", etag: '"body"' }),
	).rejects.toThrow("notification_body_invalid");
	expect(reads).toBe(1);
});
