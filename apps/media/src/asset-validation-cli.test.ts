import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
async function scratch() { const path = await mkdtemp(join(tmpdir(), "nf-validation-")); disposals.push(() => rm(path, { recursive: true, force: true })); return path; }
async function cli(input: unknown) {
  const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/asset-validation-cli.ts`], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, DATABASE_URL: "postgresql://poison.invalid/no", UPSTASH_REDIS_URL: "redis://poison.invalid:1" } });
  child.stdin.write(JSON.stringify(input)); child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}
test("a native validation job seals exact font bytes and usable metrics without backend credentials", async () => {
  const directory = await scratch();
  const bytes = await readFile(`${import.meta.dir}/../../../packages/caption-fonts/fonts/Anton-Regular.ttf`);
  const sourcePath = join(directory, "input.ttf"); const outputPath = join(directory, "validated.ttf");
  await writeFile(sourcePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await cli({ kind: "font", sourcePath, outputPath, expected: { contentType: "font/ttf", byteLength: bytes.length, sha256 } });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "font", sha256, byteLength: bytes.length, family: "Anton", format: "ttf", face: { assName: "Anton Regular" } });
  expect((JSON.parse(result.stdout).face as { ascent: number }).ascent).toBeCloseTo(1.4043, 4);
  expect(await readFile(outputPath)).toEqual(bytes);
  expect(result.stderr).not.toContain("poison.invalid");
});
test("a native image job decodes bounded pixels and rejects a claimed MIME or fingerprint mismatch before publication", async () => {
  const directory = await scratch();
  const { default: sharp } = await import("sharp");
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#4488bb" } }).png().toBuffer();
  const sourcePath = join(directory, "input.png"); await writeFile(sourcePath, bytes);
  const expected = { contentType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const result = await cli({ kind: "visual", sourcePath, outputPath: join(directory, "validated.png"), expected });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "visual", mediaKind: "image", width: 32, height: 24, durationSec: null, contentType: "image/png" });
  for (const changed of [{ ...expected, contentType: "image/jpeg" }, { ...expected, sha256: "0".repeat(64) }]) {
    const outputPath = join(directory, "rejected.png");
    const rejected = await cli({ kind: "visual", sourcePath, outputPath, expected: changed });
    expect(rejected.exit).toBe(1); expect(rejected.stdout).toBe(""); await expect(access(outputPath)).rejects.toBeDefined();
  }
});
test("font collections and truncated valid signatures cannot produce validated outputs", async () => {
  const directory = await scratch();
  for (const bytes of [Buffer.from("ttcf"), Buffer.from("nope"), Buffer.from([0, 1, 0, 0]), Buffer.from("OTTO"), Buffer.from("wOF2")]) {
    const sourcePath = join(directory, "malformed.ttf"); await writeFile(sourcePath, bytes);
    const outputPath = join(directory, "forbidden.ttf");
    const rejected = await cli({ kind: "font", sourcePath, outputPath, expected: { contentType: "font/ttf", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
    expect(rejected.exit).toBe(1); expect(rejected.stdout).toBe(""); await expect(access(outputPath)).rejects.toBeDefined();
  }
});
test("local MP4 validation and thumbnail extraction produce sealed measured outputs", async () => {
  const directory = await scratch(); const sourcePath = join(directory, "input.mp4");
  const made = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=blue:s=32x24:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", sourcePath], { stdout: "pipe", stderr: "pipe" });
  expect(await made.exited).toBe(0);
  const bytes = await readFile(sourcePath);
  const expected = { contentType: "video/mp4", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const visual = await cli({ kind: "visual", sourcePath, outputPath: join(directory, "validated.mp4"), expected });
  expect(visual.exit).toBe(0); expect(JSON.parse(visual.stdout)).toMatchObject({ kind: "visual", contentType: "video/mp4", mediaKind: "video", width: 32, height: 24, durationSec: 1 });
  const outputPath = join(directory, "frame.jpg");
  const thumbnail = await cli({ kind: "thumbnail", sourcePath, outputPath, expected, sourceTimeMs: 500 });
  expect(thumbnail.exit).toBe(0); expect(JSON.parse(thumbnail.stdout)).toMatchObject({ kind: "thumbnail", contentType: "image/jpeg", mediaKind: "image", width: 32, height: 24, durationSec: null });
  const image = await readFile(outputPath);
  expect([...image.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  expect(JSON.parse(thumbnail.stdout).sha256).toBe(createHash("sha256").update(image).digest("hex"));
});
