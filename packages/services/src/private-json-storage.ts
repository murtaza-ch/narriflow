import { isExecutionInputKey } from "./execution-input-key";
import {
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ExecutionStorageConfig } from "./execution-storage";
import { WorkflowFailure } from "./workflow-attempt-contract";

const maximum = 16_777_216;
export interface PrivateJsonObject {
	storageKey: string;
	etag: string;
	byteLength: number;
	sha256: string;
}
export interface PrivateJsonStorage {
	write(
		key: string,
		bytes: Uint8Array,
	): Promise<Omit<PrivateJsonObject, "storageKey">>;
	inspect(plan: {
		storageKey: string;
		byteLength: number;
		sha256: string;
	}): Promise<Omit<PrivateJsonObject, "storageKey"> | null>;
	read(object: PrivateJsonObject): Promise<Uint8Array>;
}
function failure(
	code:
		| "execution_input_reference_invalid"
		| "execution_input_changed"
		| "execution_input_unavailable",
) {
	return new WorkflowFailure(
		code,
		code === "execution_input_unavailable" ? "retryable" : "permanent",
		code.replaceAll("_", " "),
	);
}
function status(error: unknown) {
	return (error as { $metadata?: { httpStatusCode?: number } } | null)
		?.$metadata?.httpStatusCode;
}
function etag(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 160 &&
		/^"[\x21\x23-\x7e]+"$/.test(value)
	);
}
async function hash(bytes: Uint8Array) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Conditional private capsule I/O for preparation and render inputs. The
 * caller persists an exact-key cleanup intent before calling write. */
export function createPrivateJsonStorage(
	config: ExecutionStorageConfig,
	options: { client?: S3Client } = {},
): PrivateJsonStorage {
	if (
		!/^[a-f0-9]{32}$/.test(config.accountId) ||
		!config.bucket ||
		!config.accessKeyId ||
		!config.secretAccessKey
	)
		throw new Error("execution_input_configuration_invalid");
	const client =
		options.client ??
		new S3Client({
			region: "auto",
			endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			requestHandler: new FetchHttpHandler({ requestTimeout: 10_000 }),
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
			maxAttempts: 3,
		});
	async function provider<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof WorkflowFailure) throw error;
			if (
				[404, 412].includes(status(error) ?? 0) ||
				["NoSuchKey", "NotFound", "PreconditionFailed"].includes(
					(error as { name?: string } | null)?.name ?? "",
				)
			)
				throw failure("execution_input_changed");
			throw failure("execution_input_unavailable");
		}
	}
	async function read(reference: PrivateJsonObject): Promise<Uint8Array> {
		if (
			!isExecutionInputKey(reference.storageKey) ||
			!etag(reference.etag) ||
			!/^[a-f0-9]{64}$/.test(reference.sha256) ||
			!Number.isSafeInteger(reference.byteLength) ||
			reference.byteLength < 1 ||
			reference.byteLength > maximum
		)
			throw failure("execution_input_reference_invalid");
		return provider(async () => {
			const response = await client.send(
				new GetObjectCommand({
					Bucket: config.bucket,
					Key: reference.storageKey,
					IfMatch: reference.etag,
					Range: `bytes=0-${reference.byteLength - 1}`,
				}),
				{ abortSignal: AbortSignal.timeout(10_000) },
			);
			if (!response.Body) throw failure("execution_input_changed");
			const stream = response.Body.transformToWebStream();
			if (
				response.ETag !== reference.etag ||
				response.ContentLength !== reference.byteLength ||
				response.ContentType !== "application/json" ||
				response.Metadata?.["execution-input-sha256"] !== reference.sha256
			) {
				await stream.cancel().catch(() => {});
				throw failure("execution_input_changed");
			}
			const reader = stream.getReader(),
				chunks: Uint8Array[] = [];
			let length = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					if (
						!(chunk.value instanceof Uint8Array) ||
						length + chunk.value.byteLength > reference.byteLength
					)
						throw failure("execution_input_changed");
					length += chunk.value.byteLength;
					chunks.push(chunk.value);
				}
				if (length !== reference.byteLength)
					throw failure("execution_input_changed");
				const bytes = new Uint8Array(length);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				if ((await hash(bytes)) !== reference.sha256)
					throw failure("execution_input_changed");
				return bytes;
			} catch (error) {
				await reader.cancel().catch(() => {});
				throw error;
			} finally {
				reader.releaseLock();
			}
		});
	}
	async function inspect(plan: {
		storageKey: string;
		byteLength: number;
		sha256: string;
	}) {
		if (
			!isExecutionInputKey(plan.storageKey) ||
			!Number.isSafeInteger(plan.byteLength) ||
			plan.byteLength < 1 ||
			plan.byteLength > maximum ||
			!/^[a-f0-9]{64}$/.test(plan.sha256)
		)
			throw failure("execution_input_reference_invalid");
		let head;
		try {
			head = await client.send(
				new HeadObjectCommand({ Bucket: config.bucket, Key: plan.storageKey }),
				{ abortSignal: AbortSignal.timeout(10_000) },
			);
		} catch (error) {
			if (
				status(error) === 404 ||
				["NoSuchKey", "NotFound"].includes((error as { name?: string })?.name ?? "")
			)
				return null;
			throw failure("execution_input_unavailable");
		}
		if (
			!etag(head.ETag) ||
			head.ContentLength !== plan.byteLength ||
			head.ContentType !== "application/json" ||
			head.Metadata?.["execution-input-sha256"] !== plan.sha256
		)
			throw failure("execution_input_changed");
		return {
			etag: head.ETag,
			byteLength: plan.byteLength,
			sha256: plan.sha256,
		};
	}
	return {
		read,
		inspect,
		async write(storageKey, bytes) {
			if (
				!isExecutionInputKey(storageKey) ||
				!(bytes instanceof Uint8Array) ||
				!bytes.byteLength ||
				bytes.byteLength > maximum
			)
				throw failure("execution_input_reference_invalid");
			const sha256 = await hash(bytes);
			return provider(async () => {
				let putEtag: string | undefined,
					uncertain = false;
				try {
					const result = await client.send(
						new PutObjectCommand({
							Bucket: config.bucket,
							Key: storageKey,
							Body: bytes,
							ContentLength: bytes.byteLength,
							ContentType: "application/json",
							IfNoneMatch: "*",
							Metadata: { "execution-input-sha256": sha256 },
						}),
						{ abortSignal: AbortSignal.timeout(10_000) },
					);
					putEtag = result.ETag;
				} catch {
					uncertain = true;
				}
				let head;
				try {
					head = await client.send(
						new HeadObjectCommand({ Bucket: config.bucket, Key: storageKey }),
						{ abortSignal: AbortSignal.timeout(10_000) },
					);
				} catch (error) {
					if (uncertain) throw failure("execution_input_unavailable");
					throw error;
				}
				if (
					!etag(head.ETag) ||
					head.ContentLength !== bytes.byteLength ||
					head.ContentType !== "application/json" ||
					head.Metadata?.["execution-input-sha256"] !== sha256 ||
					(!uncertain && head.ETag !== putEtag)
				)
					throw failure("execution_input_changed");
				const reference = {
					storageKey,
					etag: head.ETag,
					byteLength: bytes.byteLength,
					sha256,
				};
				// A timeout may mean the object was written. A matching HEAD alone is
				// insufficient: confirm the immutable object's actual bytes as well.
				if (uncertain) await read(reference);
				return {
					etag: reference.etag,
					byteLength: reference.byteLength,
					sha256,
				};
			});
		},
	};
}
