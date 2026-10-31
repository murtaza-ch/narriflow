import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createExportBundleArchive } from "./export-bundle";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true}))); });

test("a real bundle opens frozen streams one at a time and preserves their exact names and bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(),"bundle-stream-")); directories.push(directory);
  const files = ["project/001-first/9x16.mp4","project/002-second/1x1.mp4"];
  const manifest = { schemaVersion: 1 as const, operationId: crypto.randomUUID(), projectId: crypto.randomUUID(), createdAt: "2026-10-31T00:00:00Z", excluded: [],
    included: files.map((name,index) => ({clipId:crypto.randomUUID(),exportId:crypto.randomUUID(),editorRevision:1,files:[{variantId:crypto.randomUUID(),aspectRatio: index ? "1:1" as const : "9:16" as const,name,sizeBytes:3}]})) };
  let active = 0, maximum = 0; const opened: string[] = [];
  const outputPath = join(directory,"bundle.zip");
  await createExportBundleArchive({ outputPath, manifest, files: files.map((name,index) => ({name,open: async () => {
    active++; maximum=Math.max(maximum,active); opened.push(name);
    return Readable.from((async function*(){try {yield Buffer.from([index,2,3]);}finally {active--;}})());
  }})) });
  expect(maximum).toBe(1); expect(opened).toEqual(files);
  const child = Bun.spawn(["unzip","-p",outputPath,files[1]!]);
  expect([...new Uint8Array(await new Response(child.stdout).arrayBuffer())]).toEqual([1,2,3]);
  expect(await child.exited).toBe(0);
});

test("a changed frozen input length or digest aborts the archive instead of producing a publishable ZIP", async () => {
  const directory = await mkdtemp(join(tmpdir(),"bundle-changed-")); directories.push(directory);
  const name="project/001-first/9x16.mp4";
  const manifest={schemaVersion:1 as const,operationId:crypto.randomUUID(),projectId:crypto.randomUUID(),createdAt:"2026-10-31T00:00:00Z",excluded:[],
    included:[{clipId:crypto.randomUUID(),exportId:crypto.randomUUID(),editorRevision:1,files:[{variantId:crypto.randomUUID(),aspectRatio:"9:16" as const,name,sizeBytes:3}]}]};
  await expect(createExportBundleArchive({outputPath:join(directory,"length.zip"),manifest,files:[{name,open:async()=>Readable.from([Buffer.from([1,2])])}]})).rejects.toThrow("export_bundle_source_changed");
  await expect(createExportBundleArchive({outputPath:join(directory,"digest.zip"),manifest,files:[{name,sha256:"a".repeat(64),open:async()=>Readable.from([Buffer.from([1,2,3])])}]})).rejects.toThrow("export_bundle_source_changed");
});
