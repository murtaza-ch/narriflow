import { constants } from "node:fs";
import { open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { generatedImageCommandSchema } from "@narriflow/validators/generated-image-execution";
import { executeGeneratedImage } from "./generated-image";
const path = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => isAbsolute(value) && !value.includes("\0"));
const inputSchema = z.strictObject({
	commandPath: path,
	work: path,
	outputPath: path,
	evidencePath: path,
	binaryArtifactId: z.string().uuid(),
	sourcePath: path.optional(),
});
async function main() {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > 65536) throw new Error("generated_image_command_invalid");
		chunks.push(chunk);
	}
	const input = inputSchema.parse(
		JSON.parse(Buffer.concat(chunks).toString("utf8")),
	);
	if (
		(await realpath(dirname(input.commandPath))) !==
		(await realpath(input.work))
	)
		throw new Error("generated_image_scratch_invalid");
	const handle = await open(
		input.commandPath,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	let command;
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size < 1 || info.size > 256 * 1024)
			throw new Error("generated_image_command_invalid");
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const part of handle.createReadStream({
			autoClose: false,
			highWaterMark: 65536,
		})) {
			length += part.length;
			if (length > 256 * 1024)
				throw new Error("generated_image_command_invalid");
			chunks.push(Buffer.from(part));
		}
		command = generatedImageCommandSchema.parse(
			JSON.parse(Buffer.concat(chunks).toString("utf8")),
		);
	} finally {
		await handle.close();
	}
	if (
		(await realpath(dirname(input.evidencePath))) !==
		(await realpath(input.work))
	)
		throw new Error("generated_image_scratch_invalid");
	const controller = new AbortController(),
		cancel = () => controller.abort(new Error("generated_image_cancelled"));
	process.once("SIGTERM", cancel);
	process.once("SIGINT", cancel);
	const timeout = setTimeout(cancel, 240000);
	try {
		const evidence = await executeGeneratedImage(command, {
			...input,
			apiKey:
				command.mode === "generate" ? process.env.OPENAI_API_KEY : undefined,
			signal: controller.signal,
		});
		const body = JSON.stringify(evidence);
		if (Buffer.byteLength(body) > 65536)
			throw new Error("generated_image_evidence_invalid");
		await writeFile(input.evidencePath, body, { flag: "wx", mode: 0o600 });
		process.stdout.write(`${JSON.stringify({ completed: true })}\n`);
	} finally {
		clearTimeout(timeout);
		process.removeListener("SIGTERM", cancel);
		process.removeListener("SIGINT", cancel);
	}
}
if (import.meta.main)
	main().catch(() => {
		console.error(
			JSON.stringify({
				level: "error",
				message: "generated_image_failed",
				errorCode: "generated_image_failed",
			}),
		);
		process.exitCode = 1;
	});
