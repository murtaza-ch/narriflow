import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintDifferences, fingerprintId, leanFingerprintId, SCRIPT_SPECIMENS, scriptSpecimenFingerprint, type RuntimeFingerprint } from "./check-render-environment";

function runtime(packages: Record<string, string>): RuntimeFingerprint {
  return {
    platform: "linux-x64", os: "debian trixie 13", bun: "1.4.4",
    ffmpeg: { path: "/usr/bin/ffmpeg", versionLine: "ffmpeg7.1.5", configuration: "pinned", libraries: [], sha256: "a".repeat(64) },
    ffprobe: { path: "/usr/bin/ffprobe", versionLine: "ffprobe7.1.5", sha256: "b".repeat(64) },
    linkedLibraries: [], filters: {}, encoders: {}, fontconfig: "fontconfig2.15.0", fontProbes: [],
    glyphRender: { sha256: "c".repeat(32), error: null }, scriptRender: {}, captionFonts: {}, fallbackFonts: {},
    model: { path: "/model.onnx", sha256: "d".repeat(64) },
    python: { version: "3.13.5", packages, wheelProbeError: null },
  };
}

test("runtime identity ignores Python distribution enumeration order but detects a changed wheel", () => {
  const a = runtime({ numpy: "2.5.4", pip: "25.1.1", "yt-dlp": "2026.8.19" });
  const reordered = runtime({ "yt-dlp": "2026.8.19", numpy: "2.5.4", pip: "25.1.1" });
  expect(fingerprintId(a)).toBe(fingerprintId(reordered));
  expect(fingerprintDifferences(a, reordered)).toEqual([]);
  const changed = runtime({ "yt-dlp": "2026.8.19", numpy: "2.5.5", pip: "25.1.1" });
  expect(fingerprintId(a)).not.toBe(fingerprintId(changed));
  expect(fingerprintDifferences(a, changed)).toEqual(["python"]);
});

test("lean identity applies the same distribution ordering", () => {
  const python = runtime({ pip: "25.1.1", requests: "2.34.2" }).python;
  const facts = { profile: "lean", bun: "1.4.4", python, ffmpeg: "7.1.5", ffprobe: "7.1.5", deno: "2.9.5", tokenImage: "locked" };
  const reordered = { ...facts, python: { ...python, packages: { requests: "2.34.2", pip: "25.1.1" } } };
  expect(leanFingerprintId(facts)).toBe(leanFingerprintId(reordered));
  expect(leanFingerprintId(facts)).not.toBe(leanFingerprintId({ ...reordered, python: { ...python, packages: { requests: "2.34.3", pip: "25.1.1" } } }));
});

const blank = "a".repeat(32), drawn = "b".repeat(32);
function frameChecksums() {
  return ["#format: frame checksums", "#version: 2", "#hash: MD5", "#tb 0: 1/1",
    ...Array.from({ length: 28 }, (_, frame) => `0, ${frame}, ${frame}, 1, 230400, ${frame ? drawn : blank}`)].join("\n") + "\n";
}

async function withProbe(stdout: string, code: number, inspect: (probe: { executable: string; directory: string; calls(): Promise<Array<{ args: string[]; ass: string }>> }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-specimen-test-"));
  try {
    const executable = join(directory, "ffmpeg"), log = join(directory, "calls.jsonl"), output = join(directory, "stdout");
    await writeFile(output, stdout);
    await writeFile(executable, `#!${process.execPath}\nimport {readFile,appendFile} from 'node:fs/promises';
const args=process.argv.slice(2),filter=args[args.indexOf('-vf')+1],path=/ass='([^']+)'/.exec(filter)[1];
const ass=await readFile(path,'utf8');await appendFile(${JSON.stringify(log)},JSON.stringify({args,ass})+'\\n');
if(args.includes('framemd5'))process.stdout.write(await readFile(${JSON.stringify(output)},'utf8'));
else console.log('MD5='+(path.endsWith('/empty.ass')?${JSON.stringify(blank)}:${JSON.stringify(drawn)}));
process.exit(${code});\n`);
    await chmod(executable, 0o700);
    await inspect({ executable, directory, calls: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("all 27 shaping specimens and their blank control use one bounded FFmpeg render", async () => {
  await withProbe(frameChecksums(), 0, async probe => {
    const result = await scriptSpecimenFingerprint(probe.executable, probe.directory);
    expect(Object.keys(result)).toEqual(SCRIPT_SPECIMENS.map(specimen => specimen.id));
    expect(Object.values(result)).toEqual(Array(27).fill(drawn));
    const calls = await probe.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("framemd5");
    expect(calls[0]!.args.slice(calls[0]!.args.indexOf("-frames:v"), calls[0]!.args.indexOf("-frames:v") + 2)).toEqual(["-frames:v", "28"]);
    for (const specimen of SCRIPT_SPECIMENS) {
      expect(calls[0]!.ass).toContain(specimen.text);
      expect(calls[0]!.ass).toContain(`\\fn${specimen.face}`);
    }
  });
});

for (const mode of ["missing", "extra", "truncated", "reordered", "wrong_stream", "wrong_size", "failed"] as const)
  test(`a ${mode} checksum stream cannot qualify any shaping specimen`, async () => {
    let stdout = frameChecksums();
    if (mode === "missing") stdout = stdout.trim().split("\n").slice(0, -1).join("\n");
    if (mode === "extra") stdout += `0, 28, 28, 1, 230400, ${drawn}\n`;
    if (mode === "truncated") stdout = stdout.slice(0, -10);
    if (mode === "reordered") stdout = stdout.replace("0, 1, 1,", "0, 2, 2,");
    if (mode === "wrong_stream") stdout = stdout.replace("0, 1, 1,", "1, 1, 1,");
    if (mode === "wrong_size") stdout = stdout.replace("230400", "230399");
    await withProbe(stdout, mode === "failed" ? 1 : 0, async probe => {
      expect(Object.values(await scriptSpecimenFingerprint(probe.executable, probe.directory))).toEqual(Array(27).fill(null));
      const calls = await probe.calls();
      expect(calls).toHaveLength(1);
      const path = /ass='([^']+)'/.exec(calls[0]!.args[calls[0]!.args.indexOf("-vf") + 1]!)![1]!;
      await expect(readFile(path)).rejects.toThrow();
    });
  });

test("a blank specimen remains a failed capability while other scripts retain their hashes", async () => {
  await withProbe(frameChecksums().replace(`0, 1, 1, 1, 230400, ${drawn}`, `0, 1, 1, 1, 230400, ${blank}`), 0, async probe => {
    const result = await scriptSpecimenFingerprint(probe.executable, probe.directory);
    expect(result.latin).toBeNull();
    expect(Object.values(result).slice(1)).toEqual(Array(26).fill(drawn));
  });
});
