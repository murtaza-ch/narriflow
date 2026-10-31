import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const invalid = () => new Error("restore_snapshot_file_invalid");
async function readRegular(path: string, consume: (bytes: Uint8Array) => void, limit = Number.MAX_SAFE_INTEGER) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw invalid();
    let length = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      length += bytes.byteLength; if (length > limit) throw invalid(); consume(bytes);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== before.size) throw invalid();
  } finally { await handle.close(); }
}
export async function hashSnapshotFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  try { await readRegular(path, bytes => { hash.update(bytes); }); }
  catch { throw invalid(); }
  return hash.digest("hex");
}
export async function readSnapshotJson(path: string): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  try {
    await readRegular(path, bytes => { chunks.push(bytes); }, 65_536);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw invalid(); }
}
export async function hashSnapshotMigrations(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (!migrations.length || migrations.length > 4096 || entries.some(entry => entry.isSymbolicLink()) || migrations.some(name => !/^[a-z0-9_]+$/.test(name))) throw invalid();
  const manifest: [string, string][] = [];
  for (const name of migrations) manifest.push([name, await hashSnapshotFile(join(directory, name, "migration.sql"))]);
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
/** This operator artifact is evidence, not a credentials store. Never overwrite
 * an earlier snapshot's proof or print snapshot bytes. */
export async function writeSnapshotProof(path: string, proof: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
