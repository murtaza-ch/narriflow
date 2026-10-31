import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { MAX_EXPORT_BUNDLE_INPUT_BYTES, type ExportBundleManifest } from "@narriflow/validators";
import { createExportBundleArchive, hashFile } from "../../src/tasks/export-bundle";

const lock = JSON.parse(await readFile(new URL("../../runtime-lock.json", import.meta.url), "utf8"));
const manifestPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const archiverVersion = createRequire(import.meta.url)("archiver/package.json").version;
if (process.platform !== "linux" || process.arch !== "x64" || process.versions.bun !== lock.images.bun.ref.split(":").at(-1) || archiverVersion !== manifestPackage.dependencies.archiver) throw Error("bundle_gate_toolchain_invalid");
const work = await mkdtemp(join(tmpdir(), "bundle-maximum-input-")), path = join(work, "bundle.zip"), name = "project/001-fixture/9x16.mp4";
const controller = new AbortController(), timeout = setTimeout(() => controller.abort(Error("bundle_gate_deadline")), 45 * 60_000);
let active = 0, maximumActive = 0, transferred = 0, sampledRssBytes = process.memoryUsage().rss;
const started = performance.now(), sampler = setInterval(() => { sampledRssBytes = Math.max(sampledRssBytes, process.memoryUsage().rss); }, 25);
try {
  const manifest: ExportBundleManifest = { schemaVersion: 1, projectId: crypto.randomUUID(), operationId: crypto.randomUUID(), createdAt: "2026-10-31T00:00:00.000Z", excluded: [],
    included: [{ clipId: crypto.randomUUID(), exportId: crypto.randomUUID(), editorRevision: 1, files: [{ variantId: crypto.randomUUID(), aspectRatio: "9:16", name, sizeBytes: MAX_EXPORT_BUNDLE_INPUT_BYTES }] }] };
  const output = await createExportBundleArchive({ outputPath: path, manifest, signal: controller.signal,
    files: [{ name, sha256: "8479e43911dc45e89f934fe48d01297e16f51d17aa561d4d1c216b1ae0fcddca", open: async () => Readable.from((async function* () {
      active++;maximumActive = Math.max(maximumActive, active);const chunk = Buffer.alloc(65536);
      try { for (let left = MAX_EXPORT_BUNDLE_INPUT_BYTES; left > 0;) { controller.signal.throwIfAborted();const count = Math.min(left, chunk.length);left -= count;transferred += count;yield chunk.subarray(0, count); } }
      finally { active--; }
    })()) }] });
  const validation = await promisify(execFile)("python", ["-c", "import json,sys,zipfile,platform\nassert platform.python_version()==sys.argv[3]\nwith zipfile.ZipFile(sys.argv[1]) as archive:\n info=archive.getinfo(sys.argv[2])\n assert info.file_size==4294967296\n assert info.extract_version>=45\n assert archive.testzip() is None\n print(json.dumps({'uncompressedBytes':info.file_size,'zip64Version':info.extract_version,'crcVerified':True,'python':platform.python_version()}))", path, name, lock.platforms["linux-x64"].python.version], { signal: controller.signal, maxBuffer: 65536 });
  if (transferred !== MAX_EXPORT_BUNDLE_INPUT_BYTES || active !== 0 || maximumActive !== 1 || output.size > MAX_EXPORT_BUNDLE_INPUT_BYTES + 64 * 1024 ** 2) throw Error("bundle_gate_stream_invalid");
  const optional = async (file: string) => { try { return (await readFile(file, "utf8")).trim(); } catch { return null; } };
  const status = await optional("/proc/self/status"), highWater = status?.match(/^VmHWM:\s+(\d+) kB$/m);
  const peakProcessRssBytes = Math.max(sampledRssBytes, process.resourceUsage().maxRSS * 1024, highWater ? Number(highWater[1]) * 1024 : 0);
  const maximum = await optional("/sys/fs/cgroup/memory.max"), peak = await optional("/sys/fs/cgroup/memory.peak");
  console.log(JSON.stringify({ gate: "export-bundle-maximum-input", sourceBytes: transferred, sourceFixture: "one 4 GiB zero-byte stream; no source file", maximumConcurrentSourceStreams: maximumActive,
    outputBytes: output.size, outputSha256: await hashFile(path), peakProcessRssBytes, cgroupMemoryMaxBytes: maximum && /^\d+$/.test(maximum) ? Number(maximum) : null,
    cgroupMemoryPeakBytes: peak && /^\d+$/.test(peak) ? Number(peak) : null, elapsedMs: performance.now() - started, validation: JSON.parse(validation.stdout),
    runtime: { platform: process.platform, arch: process.arch, bun: process.versions.bun, archiver: archiverVersion }, providerRequests: 0, databaseRequests: 0, storageRequests: 0 }, null, 2));
} finally { clearTimeout(timeout);clearInterval(sampler);await rm(work, { recursive: true, force: true }); }
