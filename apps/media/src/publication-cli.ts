import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { publicationInputEnvelopeSchema } from "@narriflow/validators/publication-input";
import { publicationEphemeralSchema } from "@narriflow/validators/publication-execution";
import { executePublication } from "./publication";
const path = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => isAbsolute(value) && !value.includes("\0"));
const invocation = z.strictObject({
	work: path,
	envelope: publicationInputEnvelopeSchema,
	context: publicationEphemeralSchema,
	mediaPath: path,
	thumbnailPath: path.optional(),
	priorInstructionsPath: path.optional(),
	control: z.strictObject({
		origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/),
		token: z.string().regex(/^[a-f0-9]{64}$/),
	}),
});
async function privateFile(file: string, work: string, maximum: number) {
	const location = await realpath(file),
		root = await realpath(work),
		within = relative(root, location);
	if (within.startsWith("..") || isAbsolute(within) || location !== file)
		throw Error("publication_scratch_invalid");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const facts = await handle.stat();
		if (!facts.isFile() || facts.size < 1 || facts.size > maximum)
			throw Error("publication_input_invalid");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}
export async function runPublicationCli(options:{providerFetch?:typeof fetch}={}) {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const part of process.stdin) {
		length += part.length;
		if (length > 65536) throw Error("publication_command_invalid");
		chunks.push(part);
	}
	const wrapper = z
		.strictObject({ work: path, invocationPath: path })
		.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	if (
		(await realpath(dirname(wrapper.invocationPath))) !==
		(await realpath(wrapper.work))
	)
		throw Error("publication_scratch_invalid");
	const value = invocation.parse(
		JSON.parse(
			(
				await privateFile(wrapper.invocationPath, wrapper.work, 17 * 1024 ** 2)
			).toString("utf8"),
		),
	);
	if (value.work !== wrapper.work) throw Error("publication_scratch_invalid");
	for (const source of [
		value.mediaPath,
		value.thumbnailPath,
		value.priorInstructionsPath,
	].filter((item): item is string => Boolean(item))) {
		const actual = await realpath(source),
			within = relative(await realpath(value.work), actual);
		if (actual !== source || within.startsWith("..") || isAbsolute(within))
			throw Error("publication_scratch_invalid");
	}
	const controller = new AbortController(),
		cancel = () => controller.abort(Error("publication_cancelled"));
	process.once("SIGTERM", cancel);
	process.once("SIGINT", cancel);
	const timeout = setTimeout(cancel, 290000);
	const rpc = async (target: "command" | "instructions", request: unknown) => {
		const body = JSON.stringify({
			requestId: crypto.randomUUID(),
			...(request as object),
		});
		if (Buffer.byteLength(body) > 65536)
			throw Error("publication_metadata_too_large");
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await fetch(`${value.control.origin}/${target}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${value.control.token}`,
						"Content-Type": "application/json",
					},
					body,
					signal: AbortSignal.any([
						controller.signal,
						AbortSignal.timeout(45000),
					]),
					redirect: "error",
				});
				if (!response.ok) throw Error("publication_control_unconfirmed");
				const text = await response.text();
				if (Buffer.byteLength(text) > 65536)
					throw Error("publication_control_unconfirmed");
				return JSON.parse(text);
			} catch {
				if (attempt || controller.signal.aborted)
					throw Error("publication_control_unconfirmed");
			}
		}
		throw Error("publication_control_unconfirmed");
	};
	try {
		await executePublication({
			...value,
   providerFetch:options.providerFetch,
			signal: controller.signal,
			control: {
				command: (command) => rpc("command", { command }),
				instructions: (proof) => rpc("instructions", proof),
			},
		});
		process.stdout.write(JSON.stringify({ completed: true }));
	} finally {
		clearTimeout(timeout);
		process.removeListener("SIGTERM", cancel);
		process.removeListener("SIGINT", cancel);
	}
}
if(import.meta.main){try {await runPublicationCli();}catch{process.stderr.write(JSON.stringify({code:"publication_execution_unconfirmed"}));process.exitCode=1;}}
