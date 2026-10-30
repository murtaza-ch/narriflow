import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FIXTURE_DIR,
  buildReport,
  canonicalJson,
  classifyColor,
  compareCase,
  evaluateAssertion,
  firstBurstSec,
  loadInputs,
  pathNormalizer,
  runSuite,
  stageFixtures,
  twinMismatches,
  verifySuite,
  FingerprintMismatch,
  type Assertion,
  type CaptureFile,
  type CaseRecord,
  type Inputs,
} from "./render-golden";
import {
  collectRuntimeFingerprint,
  fingerprintDifferences,
  fingerprintId,
  loadLock,
  lockFindings,
  pipRequirements,
} from "./check-render-environment";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CASE = "solo-auto-vertical";

let work: string;
let fixtureDir: string;
let cacheDir: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "render-golden-test-"));
  fixtureDir = join(work, "fixtures");
  cacheDir = join(work, "cache");
  await cp(FIXTURE_DIR, fixtureDir, { recursive: true });
  // Pin the temp manifest for whatever toolchain runs the test; the committed pins stay untouched.
  const fingerprint = await collectRuntimeFingerprint({ repoRoot: REPO_ROOT, lock: loadLock() });
  const { fixtureToolchainId } = await import("./check-render-environment");
  await stageFixtures({ manifest: loadInputs(fixtureDir).manifest, toolchainId: fixtureToolchainId(fingerprint), ids: ["talk-720p"], cacheDir, pin: true, manifestPath: join(fixtureDir, "manifest.json") });
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("canonical JSON and assertions", () => {
  test("orders keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });

  test("evaluates every comparison, resolves refs, and treats an unmeasured metric as failing", () => {
    const m = { a: 5, s: "x", q: "RGBY", expected: "RGBY" };
    const check = (assertion: Omit<Assertion, "id">) => evaluateAssertion({ id: "t", ...assertion }, m).pass;
    expect(check({ metric: "a", op: "eq", value: 5 })).toBe(true);
    expect(check({ metric: "a", op: "ne", value: 5 })).toBe(false);
    expect(check({ metric: "a", op: "lte", value: 5 })).toBe(true);
    expect(check({ metric: "a", op: "gte", value: 6 })).toBe(false);
    expect(check({ metric: "a", op: "between", value: [4, 6] })).toBe(true);
    expect(check({ metric: "a", op: "absLte", value: 5 })).toBe(true);
    expect(check({ metric: "s", op: "in", value: ["x", "y"] })).toBe(true);
    expect(check({ metric: "q", op: "eq", value: { ref: "expected" } })).toBe(true);
    expect(check({ metric: "missing", op: "eq", value: 1 })).toBe(false);
  });

  test("classifies the quadrant colors and finds a burst", () => {
    expect(classifyColor(250, 5, 5)).toBe("R");
    expect(classifyColor(5, 120, 5)).toBe("G");
    expect(classifyColor(5, 5, 250)).toBe("B");
    expect(classifyColor(250, 250, 5)).toBe("Y");
    expect(classifyColor(128, 128, 128)).toBe("?");
    const rate = 48000;
    const samples = new Float32Array(rate * 2);
    for (let i = Math.round(rate * 0.5); i < Math.round(rate * 0.6); i++) samples[i] = 0.4 * Math.sin((2 * Math.PI * 1500 * i) / rate);
    expect(firstBurstSec(samples, rate, 1)).toBeCloseTo(0.5, 1);
    expect(firstBurstSec(new Float32Array(rate), rate, 1)).toBeNull();
  });

  test("normalizes attempt-local paths and HTTP origins in longest-first order", () => {
    const normalize = pathNormalizer([["/tmp/run", "{case}"], ["/tmp/run/fixtures", "{fixtures}"]]);
    expect(normalize("/tmp/run/fixtures/a.mp4 /tmp/run/out.mp4 http://127.0.0.1:5123/x")).toBe("{fixtures}/a.mp4 {case}/out.mp4 {http}/x");
  });
});

describe("pinned environment", () => {
  test("the fingerprint records the resolved fallback font files, their hashes and the model hash", async () => {
    const fingerprint = await collectRuntimeFingerprint({ repoRoot: REPO_ROOT, lock: loadLock() });
    const resolved = fingerprint.fontProbes.filter((probe) => probe.file);
    expect(resolved.length).toBeGreaterThan(5);
    for (const probe of resolved) expect(probe.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint.glyphRender.sha256).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint.model.sha256).toBe(loadLock().platforms["linux-x64"]!.model.sha256);
    expect(Object.keys(fingerprint.captionFonts).length).toBe(Object.keys(loadLock().captionFonts.sha256).length);
  });

  test("a changed vendored font, face model or FFmpeg build changes the fingerprint and is named", async () => {
    const lock = loadLock();
    const fingerprint = await collectRuntimeFingerprint({ repoRoot: REPO_ROOT, lock });
    const font = clone(fingerprint);
    font.captionFonts[Object.keys(font.captionFonts)[0]!] = "0".repeat(64);
    const model = clone(fingerprint);
    model.model.sha256 = "1".repeat(64);
    const build = clone(fingerprint);
    build.ffmpeg.sha256 = "2".repeat(64);
    const glyphs = clone(fingerprint);
    glyphs.glyphRender.sha256 = "3".repeat(32);
    expect(fingerprintDifferences(fingerprint, font)).toEqual(["captionFonts"]);
    expect(fingerprintDifferences(fingerprint, model)).toEqual(["model"]);
    expect(fingerprintDifferences(fingerprint, build)).toEqual(["ffmpeg"]);
    expect(fingerprintDifferences(fingerprint, glyphs)).toEqual(["glyphRender"]);
    for (const changed of [font, model, build, glyphs]) expect(fingerprintId(changed)).not.toBe(fingerprintId(fingerprint));
    const findings = await lockFindings(font, lock, "image");
    expect(findings.some((finding) => finding.level === "mismatch" && finding.check === "captionFonts")).toBe(true);
    const modelFindings = await lockFindings(model, lock, "image");
    expect(modelFindings.some((finding) => finding.level === "mismatch" && finding.check === "model")).toBe(true);
  });

  test("the Dockerfile pins exactly what the lock records", () => {
    const lock = loadLock();
    const docker = readFileSync(resolve(import.meta.dir, "..", "Dockerfile"), "utf8");
    for (const image of Object.values(lock.images)) expect(docker).toContain(`${image.ref.replace("docker.io/", "")}@${image.digest}`);
    const linux = lock.platforms["linux-x64"]!;
    for (const [name, version] of Object.entries(linux.apt.direct)) expect(docker).toContain(`${name}=${version}`);
    expect(docker).toContain(`snapshot.debian.org/archive/debian/${linux.apt.snapshotTimestamp}/`);
    expect(docker).toContain(`snapshot.debian.org/archive/debian-security/${linux.apt.snapshotTimestamp}/`);
    expect(docker).toContain(`raw/${linux.model.commit}/${linux.model.repoPath}`);
    expect(docker).toContain(`${linux.model.sha256}  ${linux.model.path}`);
    expect(docker).toContain("--require-hashes");
    for (const name of Object.keys(linux.apt.direct)) expect(linux.apt.installed[name]).toBe(linux.apt.direct[name]!);
    const requirements = pipRequirements(lock).trim().split("\n");
    expect(requirements.length).toBe(linux.python.wheels.length);
    for (const line of requirements) expect(line).toMatch(/^[\w.-]+==[\w.]+ --hash=sha256:[0-9a-f]{64}$/);
  });
});

describe("fixtures", () => {
  test("a changed source fails staging before anything renders", async () => {
    const inputs = loadInputs(fixtureDir);
    const fingerprint = await collectRuntimeFingerprint({ repoRoot: REPO_ROOT, lock: loadLock() });
    const { fixtureToolchainId } = await import("./check-render-environment");
    const toolchainId = fixtureToolchainId(fingerprint);
    const tampered = join(work, "tampered-cache");
    await stageFixtures({ manifest: inputs.manifest, toolchainId, ids: ["talk-720p"], cacheDir: tampered });
    await appendFile(join(tampered, toolchainId, "talk-720p.mp4"), Buffer.from([0]));
    await expect(stageFixtures({ manifest: inputs.manifest, toolchainId, ids: ["talk-720p"], cacheDir: tampered })).rejects.toThrow(/pins/);
    const out = join(work, "tampered-out");
    await expect(runSuite({ suite: "normal", cases: [CASE], out, cacheDir: tampered, fixtureDir })).rejects.toThrow(/pins/);
    expect(existsSync(join(out, "cases"))).toBe(false);
  }, 120_000);
});

describe("capture, verify and the gate", () => {
  let baseline: CaptureFile;
  let again: CaptureFile;
  let baselineDir: string;

  beforeAll(async () => {
    baselineDir = join(work, "baseline");
    baseline = await runSuite({ suite: "normal", cases: [CASE], out: baselineDir, cacheDir, fixtureDir });
    again = await runSuite({ suite: "normal", cases: [CASE], out: join(work, "again"), cacheDir, fixtureDir });
  }, 180_000);

  test("two captures of the same case are identical in plan, argv, frames, PCM and probe facts", () => {
    const first = baseline.cases[CASE]!;
    const second = again.cases[CASE]!;
    expect(first.status).toBe("rendered");
    expect(first.targets[0]!.output!.video!.frameCount).toBeGreaterThan(60);
    expect(first.targets[0]!.output!.audio!.sampleCount).toBeGreaterThan(100_000);
    expect(compareCase(first, second)).toEqual([]);
    expect(first.targets[0]!.command.argv.join(" ")).not.toContain(work);
  });

  test("inspection compares every baseline field exactly while allowing additive facts", () => {
    const base = clone(baseline.cases[CASE]!);
    const candidate = clone(base);
    delete base.inspection!.facts;
    delete (base.inspection!.sourceProbe as Record<string, unknown>).facts;
    expect(candidate.inspection!.facts).toBeDefined();
    expect(compareCase(base, candidate)).toEqual([]);
    candidate.inspection!.width = Number(candidate.inspection!.width) + 1;
    expect(compareCase(base, candidate).map((item) => item.category)).toContain("inspection");
    candidate.inspection!.width = base.inspection!.width;
    (candidate.inspection!.sourceProbe as Record<string, unknown>).durationSec = 100;
    expect(compareCase(base, candidate).map((item) => item.category)).toContain("inspection");
    delete candidate.inspection!.fps;
    expect(compareCase(base, candidate).map((item) => item.category)).toContain("inspection");
    // A newer baseline includes the new facts in its exact comparison too.
    const current = clone(baseline.cases[CASE]!);
    const changed = clone(current);
    (changed.inspection!.facts as { format: { sizeBytes: number } }).format.sizeBytes++;
    expect(compareCase(current, changed).map((item) => item.category)).toContain("inspection");
  });

  test("retaining frames lets the audio change but not the picture", () => {
    const base = baseline.cases[CASE]!;
    const retain = ["plan", "frames"];
    const audioChanged = clone(base);
    const audio = audioChanged.targets[0]!.output!.audio!;
    audio.pcmSha256 = "padded";
    audio.sampleCount += 4800;
    audioChanged.targets[0]!.command.argvSha256 = "changed";
    expect(compareCase(base, audioChanged, retain)).toEqual([]);
    expect(compareCase(base, audioChanged).map((item) => item.category)).toContain("audio");
    const frameChanged = clone(audioChanged);
    frameChanged.targets[0]!.output!.video!.framesSha256 = "changed";
    expect(compareCase(base, frameChanged, retain).map((item) => item.category)).toEqual(["frames"]);
  });

  test("the output-pixel-format change allows only the appended -pix_fmt yuv420p", () => {
    const base = baseline.cases[CASE]!;
    const changed = clone(base);
    const command = changed.targets[0]!.command;
    command.argv = [...command.argv, "-pix_fmt", "yuv420p"];
    command.argvSha256 = "changed";
    expect(compareCase(base, changed).map((item) => item.category)).toContain("argv");
    expect(compareCase(base, changed, null, false, false, false, true)).toEqual([]);
    command.argv = [...command.argv, "-crf", "1"];
    expect(compareCase(base, changed, null, false, false, false, true).map((item) => item.category)).toContain("argv");
    const frames = clone(base);
    frames.targets[0]!.command.argv = [...frames.targets[0]!.command.argv, "-pix_fmt", "yuv420p"];
    frames.targets[0]!.command.argvSha256 = "changed";
    frames.targets[0]!.output!.video!.framesSha256 = "changed";
    expect(compareCase(base, frames, null, false, false, false, true).map((item) => item.category)).toContain("frames");
  });

  test("the glyph-coverage change allows the ASS script and frames, nothing else", () => {
    const base = baseline.cases[CASE]!;
    const changed = clone(base);
    const target = changed.targets[0]!;
    target.captions.assSha256 = "pinned-fallback-runs";
    target.output!.video!.framesSha256 = "real-glyphs";
    target.encode.diagnostics = ["[Parsed_ass_4 @ 0xADDR] fontselect: (Montserrat Black, 400, 0) -> NotoSansArabic-Regular, 0, NotoSansArabic-Regular"];
    expect(compareCase(base, changed).map((item) => item.category)).toEqual(expect.arrayContaining(["captions", "frames", "diagnostics"]));
    expect(compareCase(base, changed, null, false, false, true)).toEqual([]);
    // The picture may change only because the script did.
    const framesOnly = clone(base);
    framesOnly.targets[0]!.output!.video!.framesSha256 = "unexplained";
    expect(compareCase(base, framesOnly, null, false, false, true).map((item) => item.category)).toEqual(["frames"]);
    // Audio, argv and a candidate that still asked the host for a font are not allowed.
    const audio = clone(changed);
    audio.targets[0]!.output!.audio!.pcmSha256 = "different";
    expect(compareCase(base, audio, null, false, false, true).map((item) => item.category)).toContain("audio");
    const argv = clone(changed);
    argv.targets[0]!.command.argvSha256 = "different";
    expect(compareCase(base, argv, null, false, false, true).map((item) => item.category)).toContain("argv");
    const host = clone(changed);
    host.targets[0]!.encode.diagnostics = ["[Parsed_ass_4 @ 0xADDR] Glyph 0xADDR not found, selecting one more font for (Montserrat Black, 400, 0)"];
    expect(compareCase(base, host, null, false, false, true).map((item) => item.category)).toContain("glyph");
  });

  test("verify passes on the same code and writes a report", async () => {
    const out = join(work, "verify-ok");
    const { report, exitCode } = await verifySuite({ suite: "normal", cases: [CASE], out, baseline: baselineDir, cacheDir, fixtureDir });
    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.summary.normal).toEqual({ total: 1, pass: 1, fail: 0 });
    expect(existsSync(join(out, "report.json"))).toBe(true);
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("PASS");
  }, 180_000);

  const mutations: Array<[string, string, (record: CaseRecord) => void]> = [
    ["changed crop", "crop", (record) => { record.targets[0]!.plan.crops[0]!.sourceCrop.x += 2; }],
    ["one changed cue", "cue", (record) => { record.targets[0]!.plan.cues[1]!.words[0]![0] = "CHANGED"; }],
    ["missing frame", "frames", (record) => { const video = record.targets[0]!.output!.video!; video.frames.splice(10, 1); video.frameCount -= 1; video.framesSha256 = "changed"; }],
    ["audio drift", "audio", (record) => { const audio = record.targets[0]!.output!.audio!; audio.pcmSha256 = "drifted"; audio.chunks[5] = "ffffffffffff"; audio.sampleCount += 480; }],
    ["altered encoder argument", "argv", (record) => { const command = record.targets[0]!.command; command.argv[command.argv.indexOf("-crf") + 1] = "23"; command.argvSha256 = "changed"; }],
  ];
  for (const [name, category, mutate] of mutations) {
    test(`${name} fails the normal gate and is named`, () => {
      const candidate = clone(baseline.cases[CASE]!);
      mutate(candidate);
      const mismatches = compareCase(baseline.cases[CASE]!, candidate);
      expect(mismatches.map((mismatch) => mismatch.category)).toContain(category);
      expect(mismatches.every((mismatch) => mismatch.case === CASE)).toBe(true);
    });
  }

  test("a baseline taken with another face model is refused before rendering", async () => {
    const model = join(work, "tampered-model.onnx");
    const original = process.env.REFRAME_MODEL_PATH;
    await writeFile(model, Buffer.concat([await readFile(join(REPO_ROOT, "apps/worker/models/face_yunet.onnx")), Buffer.from([1])]));
    process.env.REFRAME_MODEL_PATH = model;
    try {
      const out = join(work, "verify-model");
      const result = verifySuite({ suite: "normal", cases: [CASE], out, baseline: baselineDir, cacheDir, fixtureDir });
      await expect(result).rejects.toBeInstanceOf(FingerprintMismatch);
      await expect(result).rejects.toThrow(/model/);
      expect(existsSync(join(out, "cases"))).toBe(false);
    } finally {
      if (original === undefined) delete process.env.REFRAME_MODEL_PATH;
      else process.env.REFRAME_MODEL_PATH = original;
    }
  }, 120_000);
});

describe("known defects are explicit expected failures", () => {
  const base: CaseRecord = {
    id: "rot90", class: "known-defect", status: "rendered", failure: null,
    inputs: { source: { fixture: "rot90", sha256: "a" }, assets: {}, documentSha256: "d", evidenceSha256: null },
    inspection: { width: 1280, height: 720 },
    targets: [{
      targetId: "vertical", aspectRatio: "9:16", resolution: "1080p",
      plan: { fingerprint: "p", sha256: "p", audioScheduleFingerprint: "a", editedDurationSec: 4, noticeCodes: [], crops: [], cues: [], layers: [], scenes: [] },
      captions: { assSha256: null },
      command: { argv: ["-y"], argvSha256: "x", filterGraph: null, filterGraphSha256: null, argBytes: 3 },
      encode: { exitCode: 0, diagnostics: [] }, output: null,
      measurements: { "render.ok": true, "video.quadrants": "YYYY", "expected.quadrants": "RGBY" },
    }],
    defects: { evaluated: "expected-failure", results: [{ targetId: "vertical", assertionId: "orientation", pass: false, actual: "YYYY" }] },
  };
  const contract: Assertion[] = [{ id: "orientation", metric: "video.quadrants", op: "eq", value: { ref: "expected.quadrants" } }];

  function inputsWith(overrides: Partial<Inputs> = {}): Inputs {
    return {
      manifest: { version: 1, encoder: { preset: "veryfast", crf: "21" }, fixtures: {}, suites: { normal: [], "known-defects": ["rot90"] } },
      cases: { rot90: { class: "known-defect", description: "d", source: "rot90", document: {}, targets: [] } },
      evidence: {}, knownDefects: { rot90: { defect: "display-matrix-geometry", owner: "03", predicate: "p", contract } }, activations: {},
      hashes: { manifest: "", documents: "", evidence: "", knownDefects: "", activations: {} },
      ...overrides,
    };
  }
  function capture(record: CaseRecord): CaptureFile {
    return { schemaVersion: 1, kind: "render-golden-capture", createdAt: "t", git: { commit: "abc", dirtyPaths: [] }, fingerprintId: "f", fingerprint: {} as any, toolchainId: "t", inputHashes: inputsWith().hashes, fixtures: {}, suite: "known-defects", cases: { [record.id]: record } };
  }

  test("an unchanged broken fixture is an expected failure, not a pass and not a skip", () => {
    const report = buildReport({ inputs: inputsWith(), baseline: capture(base), candidate: capture(clone(base)), baselinePath: "b" });
    expect(report.ok).toBe(true);
    expect(report.cases[0]!.verdict).toBe("xfail");
    expect(report.summary.knownDefects.xfail).toBe(1);
  });

  test("a defect that starts passing without an activation file fails the gate", () => {
    const fixed = clone(base);
    fixed.targets[0]!.measurements["video.quadrants"] = "RGBY";
    fixed.defects = { evaluated: "expected-failure", results: [{ targetId: "vertical", assertionId: "orientation", pass: true, actual: "RGBY" }] };
    const report = buildReport({ inputs: inputsWith(), baseline: capture(base), candidate: capture(fixed), baselinePath: "b" });
    expect(report.ok).toBe(false);
    expect(report.cases[0]!.verdict).toBe("xpass");
  });

  test("changed defect behavior that stays broken is reported, not accepted", () => {
    const changed = clone(base);
    changed.targets[0]!.command.argvSha256 = "other";
    changed.targets[0]!.command.argv = ["-y", "-changed"];
    const report = buildReport({ inputs: inputsWith(), baseline: capture(base), candidate: capture(changed), baselinePath: "b" });
    expect(report.ok).toBe(false);
    expect(report.cases[0]!.verdict).toBe("fail");
  });

  test("an expected file activates the corrected contract and exempts only the unretained fields", () => {
    const fixed = clone(base);
    fixed.targets[0]!.command.argvSha256 = "other";
    fixed.targets[0]!.command.argv = ["-y", "-transpose"];
    fixed.targets[0]!.measurements["video.quadrants"] = "RGBY";
    fixed.defects = { evaluated: "activated:03", results: [{ targetId: "vertical", assertionId: "orientation", pass: true, actual: "RGBY" }] };
    const inputs = inputsWith({ activations: { "03-display-geometry.json": { ticket: "03", cases: { rot90: { contract, retain: ["cue", "layer"] } } } } });
    const ok = buildReport({ inputs, baseline: capture(base), candidate: capture(fixed), baselinePath: "b" });
    expect(ok.ok).toBe(true);
    expect(ok.cases[0]!.verdict).toBe("activated-pass");
    const stillBroken = clone(fixed);
    stillBroken.defects = { evaluated: "activated:03", results: [{ targetId: "vertical", assertionId: "orientation", pass: false, actual: "YYYY" }] };
    const bad = buildReport({ inputs, baseline: capture(base), candidate: capture(stillBroken), baselinePath: "b" });
    expect(bad.ok).toBe(false);
    expect(bad.cases[0]!.verdict).toBe("activated-fail");
  });

  test("a regression guard fixture fails if its already-correct output breaks", () => {
    const guarded = inputsWith({ knownDefects: { rot90: { defect: "display-matrix-geometry", owner: "03", expect: "pass", predicate: "p", contract } } });
    const good = clone(base);
    good.defects = { evaluated: "expected-failure", results: [{ targetId: "vertical", assertionId: "orientation", pass: true, actual: "RGBY" }] };
    expect(buildReport({ inputs: guarded, baseline: capture(good), candidate: capture(clone(good)), baselinePath: "b" }).cases[0]!.verdict).toBe("guard-pass");
    expect(buildReport({ inputs: guarded, baseline: capture(good), candidate: capture(clone(base)), baselinePath: "b" }).ok).toBe(false);
  });

  test("a twin case must match its twin exactly", () => {
    const solo = clone(base);
    solo.id = "solo";
    const twin = clone(base);
    twin.id = "twin";
    const inputs = inputsWith({ cases: { solo: { class: "normal", description: "", source: "s", document: {}, targets: [] }, twin: { class: "normal", description: "", source: "s", document: {}, targets: [], twinOf: "solo" } } });
    expect(twinMismatches(inputs, { solo, twin })).toEqual([]);
    twin.targets[0]!.command.argvSha256 = "different";
    twin.targets[0]!.command.argv = ["-y", "-different"];
    expect(twinMismatches(inputs, { solo, twin }).length).toBeGreaterThan(0);
  });
});

describe("the committed suites", () => {
  const inputs = loadInputs();

  test("every case has a source fixture, valid targets and, when it is a defect, a contract", () => {
    for (const [name, ids] of Object.entries(inputs.manifest.suites)) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const definition = inputs.cases[id]!;
        expect(definition, `${name}/${id}`).toBeDefined();
        expect(inputs.manifest.fixtures[definition.source], `${id} source`).toBeDefined();
        expect(definition.targets.length).toBeGreaterThan(0);
        expect(definition.class).toBe(name === "normal" ? "normal" : "known-defect");
        if (definition.class === "known-defect") expect(inputs.knownDefects[id]?.contract.length, `${id} contract`).toBeGreaterThan(0);
        if (definition.evidence) expect(inputs.evidence[definition.evidence]).toBeDefined();
        if (definition.twinOf) expect(inputs.cases[definition.twinOf]).toBeDefined();
      }
    }
  });

  test("the normal suite covers the matrix in the spec", () => {
    const normal = inputs.manifest.suites.normal!;
    for (const id of ["solo-auto-vertical", "two-up-speaker-vertical", "screen-pip-portrait", "explicit-split-portrait", "rtl-arabic-captions", "cjk-dense-captions", "logo-broll-music-sfx-censor", "cut-and-inserted-scenes", "exact-source-end", "treatments-720p-watermark-1080p", "image-background-fit", "audio-only-audiogram", "mono-44k", "silent-video", "ntsc-24000-1001", "ntsc-30000-1001", "speed-playback-rate-ui-only"]) expect(normal).toContain(id);
    const treatments = inputs.cases["treatments-720p-watermark-1080p"]!.targets;
    expect(new Set(treatments.map((target) => target.aspectRatio))).toEqual(new Set(["9:16", "1:1", "16:9"]));
    expect(treatments.some((target) => target.resolution === "720p" && target.watermark)).toBe(true);
    expect(treatments.some((target) => target.resolution === "1080p")).toBe(true);
    expect(inputs.cases["speed-playback-rate-ui-only"]!.twinOf).toBe("solo-auto-vertical");
    expect(canonicalJson(inputs.cases["speed-playback-rate-ui-only"]!.document)).toBe(canonicalJson(inputs.cases["solo-auto-vertical"]!.document));
  });

  test("the known-defect suite names every defect in the spec", () => {
    const defects = new Set(Object.values(inputs.knownDefects).map((entry) => entry.defect));
    for (const defect of ["display-matrix-geometry", "sample-aspect-ratio", "odd-dimensions", "dialogue-clock", "vfr-clock", "hdr-color", "mix-clipping", "emoji-burn-in", "glyph-coverage", "empty-output", "truncated-output"]) expect(defects.has(defect)).toBe(true);
    expect(inputs.manifest.suites["known-defects"]).toEqual(expect.arrayContaining(["rot90", "rot270", "rot90-mirror", "sar-2x1", "hdr-pq", "hdr-hlg", "seek-past-source-end", "http-interrupted-read"]));
  });
});


test("presentation-clock measurements include the last frame instead of MP4 N-1 duration tags", async () => {
  const { decodedPresentationClock } = await import("./render-golden");
  expect(decodedPresentationClock(Array.from({ length: 90 }, (_, i) => i), "1/15", "15/1")).toEqual({ durationSec: 6, averageRate: "15/1", averageFps: 15 });
  // The concat fixture has 137 presented frames spanning 138 clock positions,
  // identically on FFmpeg 7 and 8. A raw container average is not its duration.
  const pts = Array.from({ length: 138 }, (_, i) => i).filter((i) => i !== 60);
  expect(decodedPresentationClock(pts, "1/30", "30/1")).toEqual({ durationSec: 4.6, averageRate: "685/23", averageFps: 137 / 4.6 });
  const truncated = decodedPresentationClock(Array.from({ length: 59 }, (_, i) => i), "1/25", "25/1");
  expect(truncated.durationSec).toBe(2.36);
  expect(59 - Math.round(6 * truncated.averageFps)).toBe(-91);
});
