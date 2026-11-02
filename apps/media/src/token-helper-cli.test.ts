import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishTokenHelperReadiness } from "./token-helper-cli";

const owner = "a".repeat(32);

test("a reader cannot observe readiness before the complete owned document is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-ready-"));
  const ready = join(directory, "ready.json");
  const created = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const publishing = publishTokenHelperReadiness(ready, owner, 18416, async (path, body, options) => {
    const file = await open(path, options.flag, options.mode);
    try {
      created.resolve();
      await release.promise;
      await file.writeFile(body);
    } finally { await file.close(); }
  });
  try {
    await created.promise;
    expect(await Bun.file(ready).exists()).toBe(false);
    release.resolve();
    await publishing;
    expect(JSON.parse(await readFile(ready, "utf8"))).toEqual({ owner, version: "2.0.0", url: "http://127.0.0.1:18416" });
    expect((await stat(ready)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["ready.json"]);
  } finally {
    release.resolve();
    await publishing.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness publication preserves an existing file and leaves no staged file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-ready-existing-"));
  const ready = join(directory, "ready.json");
  try {
    await writeFile(ready, "another owner's readiness", { flag: "wx", mode: 0o600 });
    await expect(publishTokenHelperReadiness(ready, owner, 18416)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(ready, "utf8")).toBe("another owner's readiness");
    expect(await readdir(directory)).toEqual(["ready.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
