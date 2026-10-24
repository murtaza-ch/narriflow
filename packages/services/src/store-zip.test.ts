import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeZip } from "./store-zip";

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "store-zip-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function unzip(...args: string[]) {
  const child = Bun.spawn(["unzip", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, exitCode };
}

test("a ZIP of text files passes the unzip integrity test and restores each file byte for byte", async () => {
  const path = join(directory, "timeline.zip");
  const entries = [
    { name: "clip-v3.xml", content: '<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="5"/>\n' },
    { name: "clip-v3.srt", content: "1\n00:00:00,500 --> 00:00:01,600\nCafé, ünïcode ✓\n\n" },
  ];
  await writeFile(path, storeZip(entries, new Date(Date.UTC(2026, 9, 24, 13, 30, 10))));

  expect((await unzip("-t", path)).exitCode).toBe(0);
  expect((await unzip("-Z1", path)).stdout.split("\n").filter(Boolean)).toEqual(["clip-v3.xml", "clip-v3.srt"]);
  for (const entry of entries) expect((await unzip("-p", path, entry.name)).stdout).toBe(entry.content);
  expect((await unzip("-Z", path)).stdout).toContain("26-Oct-24 13:30");
});
