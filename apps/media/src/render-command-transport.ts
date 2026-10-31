import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Linux MAX_ARG_STRLEN is 32 4-KiB pages, including the terminating NUL.
export const MAX_INLINE_FILTERGRAPH_BYTES = 128 * 1024 - 1;

/** Move only oversized graphs to the attempt's scratch directory. Admission and
 * telemetry still measure the original command, including every graph byte.
 * FFmpeg 7.1.5 supports filter_complex_script; the file contains no added newline. */
export async function transportRenderCommand(input: {
	args: readonly string[];
	directory: string;
	writeGraph?: (path: string, graph: string) => Promise<void>;
}): Promise<string[]> {
	const args = [...input.args];
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] !== "-filter_complex") continue;
		const graph = args[index + 1]!;
		if (Buffer.byteLength(graph, "utf8") <= MAX_INLINE_FILTERGRAPH_BYTES)
			continue;
		const hash = createHash("sha256").update(graph).digest("hex");
		const path = join(input.directory, `filtergraph-${hash}.ffscript`);
		await (
			input.writeGraph ??
			((path, graph) =>
				writeFile(path, graph, { encoding: "utf8", mode: 0o600 }))
		)(path, graph);
		args[index] = "-filter_complex_script";
		args[index + 1] = path;
		index += 1;
	}
	return args;
}
