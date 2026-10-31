import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { executeGeneratedImage } from "./generated-image";
const command = {
	kind: "generated_image" as const,
	mode: "generate" as const,
	jobId: crypto.randomUUID(),
	requestId: crypto.randomUUID(),
	inputHash: "a".repeat(64),
	prompt: "A mountain scene",
	aspectRatio: "9:16" as const,
	style: "editorial" as const,
	model: "native-test",
	quality: "medium" as const,
	maxOutputBytes: 20 * 1024 * 1024,
};
describe("native generated image", () => {
	test("one fixed-origin POST is fully decoded and validated before returning its assigned result facts", async () => {
		const work = await mkdtemp(join(tmpdir(), "generated-image-gate-"));
		let posts = 0;
		const png = await sharp({
			create: { width: 8, height: 12, channels: 4, background: "blue" },
		})
			.png()
			.toBuffer();
		try {
			const output = join(work, "validated.png"),
				binaryArtifactId = crypto.randomUUID();
			const evidence = await executeGeneratedImage(command, {
				outputPath: output,
				binaryArtifactId,
				work,
				apiKey: "dedicated-native-key",
				signal: new AbortController().signal,
				fetch: async (url, init) => {
					expect(url).toBe("https://api.openai.com/v1/images/generations");
					expect(init?.method).toBe("POST");
					expect(init?.redirect).toBe("error");
					expect(new Headers(init?.headers).get("Authorization")).toBe(
						"Bearer dedicated-native-key",
					);
					posts++;
					return Response.json(
						{ data: [{ b64_json: png.toString("base64") }] },
						{ headers: { "x-request-id": "native-request" } },
					);
				},
			});
			expect(posts).toBe(1);
			expect(evidence).toMatchObject({
				outcome: "completed",
				providerRef: "native-request",
				usageImages: 1,
				binaryArtifactId,
				image: {
					width: 8,
					height: 12,
					byteLength: png.byteLength,
					mediaKind: "image",
				},
			});
			expect(await readFile(output)).toEqual(png);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
	test("a lost provider response becomes unknown with zero automatic resubmission", async () => {
		const work = await mkdtemp(join(tmpdir(), "generated-image-gate-"));
		let posts = 0;
		try {
			const evidence = await executeGeneratedImage(command, {
				outputPath: join(work, "validated.png"),
				binaryArtifactId: crypto.randomUUID(),
				work,
				apiKey: "native",
				signal: new AbortController().signal,
				fetch: async () => {
					posts++;
					throw new Error("secret provider details");
				},
			});
			expect(posts).toBe(1);
			expect(evidence).toMatchObject({
				outcome: "unknown",
				code: "generated_media_provider_outcome_unknown",
				retryable: false,
			});
			expect(JSON.stringify(evidence)).not.toContain("secret provider details");
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
	test("invalid pixel bytes cannot become a completed asset and known429 retains retry metadata", async () => {
		const work = await mkdtemp(join(tmpdir(), "generated-image-gate-"));
		try {
			const base = {
				outputPath: join(work, "validated.png"),
				binaryArtifactId: crypto.randomUUID(),
				work,
				apiKey: "native",
				signal: new AbortController().signal,
			};
			expect(
				await executeGeneratedImage(command, {
					...base,
					fetch: async () =>
						Response.json({
							data: [
								{ b64_json: Buffer.from("not an image").toString("base64") },
							],
						}),
				}),
			).toMatchObject({
				outcome: "failed",
				code: "generated_media_output_invalid",
				retryable: false,
			});
			expect(
				await executeGeneratedImage(command, {
					...base,
					fetch: async () =>
						Response.json(
							{ error: { code: "rate_limit" } },
							{ status: 429, headers: { "retry-after": "12" } },
						),
				}),
			).toMatchObject({
				outcome: "failed",
				code: "generated_media_provider_rate_limited",
				retryable: true,
				retryAfterMs: 12000,
			});
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
	test("recovery validates only the exact local sealed source and never touches the provider", async () => {
		const work = await mkdtemp(join(tmpdir(), "generated-image-gate-"));
		const png = await sharp({
			create: { width: 4, height: 4, channels: 4, background: "red" },
		})
			.png()
			.toBuffer();
		try {
			const { createHash } = await import("node:crypto");
			const source = join(work, "source.png");
			await writeFile(source, png, { flag: "wx" });
			const evidence = await executeGeneratedImage(
				{
					kind: "generated_image",
					mode: "recover",
					jobId: command.jobId,
					requestId: command.requestId,
					inputHash: command.inputHash,
					providerRef: "known-accepted",
					maxOutputBytes: command.maxOutputBytes,
					expected: {
						sha256: createHash("sha256").update(png).digest("hex"),
						byteLength: png.byteLength,
						contentType: "image/png",
					},
				},
				{
					outputPath: join(work, "validated.png"),
					sourcePath: source,
					binaryArtifactId: crypto.randomUUID(),
					work,
					signal: new AbortController().signal,
					fetch: async () => {
						throw new Error("Must not POST");
					},
				},
			);
			expect(evidence).toMatchObject({
				outcome: "completed",
				providerRef: "known-accepted",
			});
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
});
