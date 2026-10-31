import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import { type ExportBundleManifest } from "@narriflow/validators";


export async function createExportBundleArchive(input: {
  outputPath: string;
  manifest: ExportBundleManifest;
  files: Array<{ path: string; name: string }>;
}) {
  const output = createWriteStream(input.outputPath, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: 6 } });
  const completion = pipeline(archive, output);
  archive.append(`${JSON.stringify(input.manifest, null, 2)}\n`, {
    name: "manifest.json",
  });
  for (const file of input.files) archive.append(createReadStream(file.path), { name: file.name });
  await archive.finalize();
  await completion;
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

