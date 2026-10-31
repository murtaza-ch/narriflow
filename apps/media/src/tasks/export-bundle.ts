import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import archiver from "archiver";
import { exportBundleManifestSchema, MAX_EXPORT_BUNDLE_INPUT_BYTES, type ExportBundleManifest } from "@narriflow/validators";


export async function createExportBundleArchive(input: {
  outputPath: string;
  manifest: ExportBundleManifest;
  files: Array<({ path: string } | { open(): Promise<Readable>; sha256?: string }) & { name: string }>;
  signal?: AbortSignal;
}) {
  const manifest = exportBundleManifestSchema.parse(input.manifest);
  const entries = manifest.included.flatMap(item => item.files);
  const names = new Set(entries.map(entry => entry.name));
  if (names.size !== entries.length || input.files.length !== entries.length || new Set(input.files.map(file => file.name)).size !== names.size || input.files.some(file => !names.has(file.name))) throw new Error("export_bundle_manifest_invalid");
  const output = createWriteStream(input.outputPath, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: 6 } });
  let outputBytes = 0;
  const outputLimit = new Transform({ transform(chunk, _encoding, done) {
    outputBytes += chunk.length;
    done(outputBytes > MAX_EXPORT_BUNDLE_INPUT_BYTES + 64 * 1024 ** 2 ? new Error("export_bundle_output_too_large") : null,chunk);
  } });
  const completion = pipeline(archive, outputLimit, output, { signal: input.signal });
  void completion.catch(() => {});
  archive.append(`${JSON.stringify(manifest, null, 2)}\n`, {
    name: "manifest.json",
  });
  try { for (const file of input.files) {
    const entry = entries.find(entry => entry.name === file.name)!;
    const source = Readable.from((async function* () {
      const stream = "path" in file ? createReadStream(file.path) : await file.open();
      let length = 0; const hash = createHash("sha256");
      for await (const chunk of stream) {
        input.signal?.throwIfAborted(); length += chunk.length; hash.update(chunk);
        if (length > entry.sizeBytes) throw new Error("export_bundle_source_changed");
        yield chunk;
      }
      if (length !== entry.sizeBytes || ("sha256" in file && file.sha256 && hash.digest("hex") !== file.sha256)) throw new Error("export_bundle_source_changed");
    })());
    const consumed = new Promise<void>((resolve,reject) => {
      const cleanup = () => { archive.off("entry",entry); archive.off("error",failed); };
      const entry = (value: { name: string }) => { if (value.name === file.name) { cleanup(); resolve(); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      archive.on("entry",entry); archive.once("error",failed);
    });
    source.on("error",error => archive.destroy(error));
    archive.append(source, { name: file.name });
    await consumed;
  }
  await archive.finalize(); await completion; }
  catch (error) { archive.destroy(); await completion.catch(() => {}); throw error; }
  return stat(input.outputPath);
}

export async function hashFile(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export function exportBundleStorageKeys(projectId: string, operationId: string, attemptId: string) {
  const prefix = `projects/${projectId}/campaign-operations/${operationId}`;
  return {
    attemptKey: `${prefix}/attempts/${attemptId}.zip`,
    finalKey: `${prefix}/completed/${attemptId}.zip`,
  };
}

