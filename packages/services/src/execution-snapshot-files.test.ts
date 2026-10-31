import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSnapshotFile, hashSnapshotMigrations, readSnapshotJson, writeSnapshotProof } from "../scripts/execution-snapshot-files";

test("operator hashes the actual regular snapshot and ordered migration bytes; private proof cannot overwrite an existing artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "execution-proof-"));
  try {
    const snapshot = join(directory, "snapshot"); await writeFile(snapshot, "abc");
    expect(await hashSnapshotFile(snapshot)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const migrations = join(directory, "migrations"); await mkdir(migrations);
    for (const name of ["002_second", "001_first"]) { await mkdir(join(migrations, name)); await writeFile(join(migrations, name, "migration.sql"), name); }
    const before = await hashSnapshotMigrations(migrations);
    await writeFile(join(migrations, "001_first", "migration.sql"), "changed");
    expect(await hashSnapshotMigrations(migrations)).not.toBe(before);
    const proof = join(directory, "proof.json"); await writeSnapshotProof(proof, { hash: before });
    expect(await readSnapshotJson(proof)).toEqual({ hash: before });
    expect((await stat(proof)).mode & 0o777).toBe(0o600);
    await expect(writeSnapshotProof(proof, { overwritten: true })).rejects.toThrow();
    expect(JSON.parse(await readFile(proof, "utf8"))).toEqual({ hash: before });
    await symlink(snapshot, join(directory, "alias"));
    await expect(hashSnapshotFile(join(directory, "alias"))).rejects.toThrow("restore_snapshot_file_invalid");
    await writeFile(join(directory, "too-large"), " ".repeat(65_537));
    await expect(readSnapshotJson(join(directory, "too-large"))).rejects.toThrow("restore_snapshot_file_invalid");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
