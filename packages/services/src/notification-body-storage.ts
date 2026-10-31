import { createHash } from "node:crypto";
import {
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { NOTIFICATION_BODY_MAX_BYTES } from "@narriflow/validators/outbound-delivery";
import type {
	NotificationBodyPlan,
	NotificationBodyStorage,
} from "./outbound-delivery";
import type { ExecutionStorageConfig } from "./execution-storage";

/** Private immutable body I/O. The fetch handler is Workers-safe; no filesystem
 * transfer, Node HTTP agent, or URL-selected endpoint reaches this module. */
export function createNotificationBodyStorage(
	config: ExecutionStorageConfig,
	options: { client?: S3Client } = {},
): NotificationBodyStorage {
	if (
		!/^[a-f0-9]{32}$/.test(config.accountId) ||
		!config.bucket ||
		!config.accessKeyId ||
		!config.secretAccessKey
	)
		throw new Error("notification_storage_configuration_invalid");
	const client =
		options.client ??
		new S3Client({
			region: "auto",
			endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			requestHandler: new FetchHttpHandler({ requestTimeout: 10000 }),
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
			maxAttempts: 3,
		});
	function valid(plan: NotificationBodyPlan) {
		if (
			!/^notifications\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/body\.json$/.test(
				plan.storageKey,
			) ||
			!Number.isSafeInteger(plan.byteLength) ||
			plan.byteLength < 1 ||
			plan.byteLength > NOTIFICATION_BODY_MAX_BYTES ||
			!/^[a-f0-9]{64}$/.test(plan.sha256)
		)
			throw new Error("notification_body_invalid");
	}
	const metadata = (plan: NotificationBodyPlan) => ({
		"notification-sha256": plan.sha256,
	});
	return {
		async put(plan, bytes) {
			valid(plan);
			if (
				bytes.byteLength !== plan.byteLength ||
				createHash("sha256").update(bytes).digest("hex") !== plan.sha256
			)
				throw new Error("notification_body_invalid");
			await client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: plan.storageKey,
					Body: bytes,
					ContentLength: plan.byteLength,
					ContentType: "application/json",
					IfNoneMatch: "*",
					Metadata: metadata(plan),
				}),
				{ abortSignal: AbortSignal.timeout(10000) },
			);
		},
		async head(plan) {
			valid(plan);
			try {
				const result = await client.send(
					new HeadObjectCommand({
						Bucket: config.bucket,
						Key: plan.storageKey,
					}),
					{ abortSignal: AbortSignal.timeout(10000) },
				);
				if (
					result.ContentType !== "application/json" ||
					result.ContentLength !== plan.byteLength ||
					result.Metadata?.["notification-sha256"] !== plan.sha256 ||
					!result.ETag
				)
					throw new Error("notification_body_invalid");
				return {
					etag: result.ETag,
					byteLength: result.ContentLength,
					sha256: plan.sha256,
				};
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"name" in error &&
					(error.name === "NotFound" || error.name === "NoSuchKey")
				)
					return null;
				throw error;
			}
		},
		async read(plan) {
			valid(plan);
			if (!/^[\x21-\x7e]{1,160}$/.test(plan.etag))
				throw new Error("notification_body_invalid");
			const result = await client.send(
				new GetObjectCommand({
					Bucket: config.bucket,
					Key: plan.storageKey,
					IfMatch: plan.etag,
					Range: `bytes=0-${plan.byteLength - 1}`,
				}),
				{ abortSignal: AbortSignal.timeout(10000) },
			);
			if (
				!result.Body ||
				result.ETag !== plan.etag ||
				result.ContentLength !== plan.byteLength ||
				result.ContentType !== "application/json" ||
				result.Metadata?.["notification-sha256"] !== plan.sha256
			) {
				(result.Body as { destroy?: () => void } | undefined)?.destroy?.();
				throw new Error("notification_body_invalid");
			}
			return result.Body.transformToWebStream();
		},
	};
}
