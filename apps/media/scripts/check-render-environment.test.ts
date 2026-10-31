import { expect, test } from "bun:test";
import { fingerprintDifferences, fingerprintId, leanFingerprintId, type RuntimeFingerprint } from "./check-render-environment";

function runtime(packages: Record<string, string>): RuntimeFingerprint {
  return {
    platform: "linux-x64", os: "debian trixie 13", bun: "1.3.6",
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
  const facts = { profile: "lean", bun: "1.3.6", python, ffmpeg: "7.1.5", ffprobe: "7.1.5", deno: "2.9.5", tokenImage: "locked" };
  const reordered = { ...facts, python: { ...python, packages: { requests: "2.34.2", pip: "25.1.1" } } };
  expect(leanFingerprintId(facts)).toBe(leanFingerprintId(reordered));
  expect(leanFingerprintId(facts)).not.toBe(leanFingerprintId({ ...reordered, python: { ...python, packages: { requests: "2.34.3", pip: "25.1.1" } } }));
});
