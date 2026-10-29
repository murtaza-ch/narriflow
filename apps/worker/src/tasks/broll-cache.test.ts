import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brollAssetCachePath,
  getCachedBrollAssetPath,
  pruneBrollAssetCache,
  saveBrollAssetToCache,
} from "./broll";

const MIB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

describe("bounded B-roll asset cache", () => {
  let root = "";
  let directory = "";
  let sourcePath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "narriflow-broll-cache-bounds-"));
    directory = join(root, "cache");
    sourcePath = join(root, "source.mp4");
    await writeFile(sourcePath, Buffer.alloc(MIB));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  async function seed(name: string, bytes: number, ageMs: number): Promise<string> {
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await writeFile(path, Buffer.alloc(bytes));
    const at = new Date(Date.now() - ageMs);
    await utimes(path, at, at);
    return path;
  }

  test("saves into the given directory and reads it back within the lifetime", async () => {
    const url = "https://cdn.pexels.com/a.mp4";
    await saveBrollAssetToCache(url, sourcePath, { directory, maxBytes: 10 * MIB });
    expect(await getCachedBrollAssetPath(url, HOUR, directory)).toBe(brollAssetCachePath(url, directory));
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.mp4$/)]);
  });

  test("evicts the oldest assets so the new one fits under the byte bound", async () => {
    await seed("a.mp4", MIB, 3 * HOUR);
    await seed("b.mp4", MIB, 2 * HOUR);
    await seed("c.mp4", MIB, 1 * HOUR);
    await saveBrollAssetToCache("https://cdn.pexels.com/new.mp4", sourcePath, { directory, maxBytes: 3 * MIB, ttlMs: 24 * HOUR });
    const left = new Set(await readdir(directory));
    expect(left.has("a.mp4")).toBe(false);
    expect(left.has("b.mp4")).toBe(true);
    expect(left.has("c.mp4")).toBe(true);
    expect(left.size).toBe(3);
  });

  test("removes expired assets even when the bound has room", async () => {
    await seed("expired.mp4", MIB, 30 * HOUR);
    await seed("fresh.mp4", MIB, 1 * HOUR);
    const result = await pruneBrollAssetCache({ directory, maxBytes: 100 * MIB, ttlMs: 24 * HOUR });
    expect(result).toEqual({ removedFiles: 1, removedBytes: MIB, remainingBytes: MIB });
    expect(await readdir(directory)).toEqual(["fresh.mp4"]);
  });

  test("an asset larger than the whole bound is not cached and evicts nothing", async () => {
    await seed("keep.mp4", MIB, HOUR);
    await saveBrollAssetToCache("https://cdn.pexels.com/huge.mp4", sourcePath, { directory, maxBytes: MIB / 2 });
    expect(await readdir(directory)).toEqual(["keep.mp4"]);
  });

  test("a failed write removes its temporary file and leaves the cache valid", async () => {
    const url = "https://cdn.pexels.com/blocked.mp4";
    // A directory in the asset's place makes the final rename fail after the copy succeeded.
    await mkdir(brollAssetCachePath(url, directory), { recursive: true });
    await saveBrollAssetToCache(url, sourcePath, { directory, maxBytes: 10 * MIB });
    const names = await readdir(directory);
    expect(names.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("a missing source never throws and creates nothing", async () => {
    await expect(
      saveBrollAssetToCache("https://cdn.pexels.com/missing.mp4", join(root, "nope.mp4"), { directory }),
    ).resolves.toBeUndefined();
    await expect(stat(directory)).rejects.toThrow();
  });

  test("sweeps a dead writer's temporary file but not a live writer's", async () => {
    await seed("x.mp4.tmp-111-1", MIB, 11 * 60 * 1000);
    await seed("y.mp4.tmp-222-2", MIB, 1000);
    await pruneBrollAssetCache({ directory, maxBytes: 100 * MIB, ttlMs: 24 * HOUR });
    expect(await readdir(directory)).toEqual(["y.mp4.tmp-222-2"]);
  });

  test("pruning a cache directory that does not exist is a no-op", async () => {
    expect(await pruneBrollAssetCache({ directory: join(root, "absent") })).toEqual({
      removedFiles: 0,
      removedBytes: 0,
      remainingBytes: 0,
    });
  });
});
