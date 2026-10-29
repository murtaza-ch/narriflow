/**
 * Render environment fingerprint and lock check.
 *
 * Collects the facts that decide what pixels and samples the worker produces
 * (FFmpeg/ffprobe builds, libass/fontconfig/freetype/harfbuzz/x264/zimg
 * libraries, the fonts that fallback actually resolves to, the vendored
 * caption faces, the face model, the Python wheels) and compares them with
 * `apps/worker/runtime-lock.json`.
 *
 *   bun apps/worker/scripts/check-render-environment.ts            report only
 *   bun apps/worker/scripts/check-render-environment.ts --enforce  exit 1 on mismatch
 *   ... --stage build|image|start   what the caller can check (see below)
 *   ... --json                      print the fingerprint
 *   ... --emit-pip-requirements     hashed requirements for the Dockerfile
 *
 * The lock is authoritative only for `linux-x64` (the deployed worker image).
 * Any other platform, such as the macOS development host, is report-only: its
 * fingerprint is recorded with every golden capture and two captures are only
 * ever compared when their fingerprints match.
 *
 * This file imports nothing outside Node so the Dockerfile can run it before
 * `bun install`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROBE_QUERIES = [
  "sans-serif",
  "sans-serif:lang=ar",
  "sans-serif:lang=he",
  "sans-serif:lang=hi",
  "sans-serif:lang=ja",
  "sans-serif:lang=ko",
  "sans-serif:lang=zh-cn",
  "emoji",
  "Noto Color Emoji",
  "DejaVu Sans",
  "Liberation Sans",
  "Arial",
  "Noto Sans Symbols 2",
];
const GLYPH_PROBE_TEXT = [
  "Hello",
  "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645",
  "\u4f60\u597d\u3053\u3093\u306b\u3061\u306f\uc548\ub155",
  "\u{1F600}\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u{1F1F5}\u{1F1F0}\u{1F44D}\u{1F3FD}",
  "\u2605\u2713\u2192",
];

export type Stage = "build" | "image" | "start";

export interface FontProbeResult {
  query: string;
  family: string | null;
  style: string | null;
  file: string | null;
  sha256: string | null;
  ownerPackage: string | null;
}

export interface LibraryFact {
  name: string;
  realpath: string;
  sha256: string;
}

export interface RuntimeFingerprint {
  platform: string;
  os: string;
  bun: string;
  ffmpeg: { path: string | null; versionLine: string | null; configuration: string | null; libraries: string[]; sha256: string | null };
  ffprobe: { path: string | null; versionLine: string | null; sha256: string | null };
  linkedLibraries: LibraryFact[];
  filters: Record<string, boolean>;
  encoders: Record<string, boolean>;
  fontconfig: string | null;
  fontProbes: FontProbeResult[];
  glyphRender: { sha256: string | null; error: string | null };
  captionFonts: Record<string, string>;
  model: { path: string | null; sha256: string | null };
  python: { version: string | null; packages: Record<string, string>; wheelProbeError: string | null };
}

export interface Finding {
  level: "mismatch" | "gap" | "info";
  check: string;
  detail: string;
}

export interface RuntimeLock {
  lockVersion: number;
  images: Record<string, { ref: string; digest: string }>;
  platforms: Record<string, {
    authoritative: boolean;
    os: { id: string; versionCodename: string };
    apt: {
      snapshotTimestamp: string;
      archives: Array<{ uri: string; suites: string[] }>;
      direct: Record<string, string>;
      installed: Record<string, string>;
    };
    ffmpeg: {
      versionString: string;
      requiredFilters: string[];
      requiredEncoders: string[];
      libraries: Record<string, string>;
    };
    python: { version: string; wheels: Array<{ name: string; version: string; filename: string; sha256: string }> };
    model: { path: string; sourceRepo: string; commit: string; repoPath: string; sha256: string; bytes: number };
    fonts: { packages: string[]; probes: Array<{ query: string; expectedSha256: string | null }> };
  }>;
  captionFonts: { directory: string; sha256: Record<string, string> };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolveResult) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      resolveResult({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (error ? error.message : "")) });
    });
  });
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function which(command: string): Promise<string | null> {
  const result = await run("sh", ["-c", `command -v ${command}`]);
  const path = result.stdout.trim();
  return result.code === 0 && path ? path : null;
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function loadLock(lockPath?: string): RuntimeLock {
  const candidates = [lockPath, process.env.RENDER_RUNTIME_LOCK, join(SCRIPT_DIR, "runtime-lock.json"), join(SCRIPT_DIR, "..", "runtime-lock.json")].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`runtime-lock.json not found in ${candidates.join(", ")}`);
  return JSON.parse(readFileSync(found, "utf8")) as RuntimeLock;
}

async function linkedLibraries(binary: string): Promise<string[]> {
  if (process.platform === "darwin") {
    const result = await run("otool", ["-L", binary]);
    return result.stdout.split("\n").slice(1).map((line) => line.trim().split(" (")[0]!).filter(Boolean);
  }
  const result = await run("ldd", [binary]);
  return result.stdout.split("\n").flatMap((line) => {
    const match = /=>\s+(\S+)/.exec(line);
    return match && match[1]!.startsWith("/") ? [match[1]!] : [];
  });
}

const TRACKED_LIBRARIES = ["libass", "libfontconfig", "libfreetype", "libharfbuzz", "libx264", "libx265", "libzimg", "libfribidi", "libplacebo", "libswscale", "libavcodec", "libavfilter", "libavformat", "libavutil", "libswresample", "libpostproc"];

async function realpathOf(path: string): Promise<string> {
  const result = await run("sh", ["-c", `cd "$(dirname '${path.replace(/'/g, "'\\''")}')" && p="$(pwd -P)/$(basename '${path.replace(/'/g, "'\\''")}')" && (readlink -f "$p" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$p")`]);
  return result.stdout.trim() || path;
}

async function collectLibraries(ffmpegPath: string | null): Promise<LibraryFact[]> {
  if (!ffmpegPath) return [];
  const facts = new Map<string, LibraryFact>();
  const binaryReal = await realpathOf(ffmpegPath);
  const seeds = [binaryReal, ...(await linkedLibraries(binaryReal))];
  // Homebrew's ffmpeg links its libraries through @rpath; resolve each one next to the Cellar.
  const searched = new Set<string>();
  for (const seed of seeds) {
    const name = seed.split("/").pop()!.replace(/\.(\d+\.)*(dylib|so).*$/, "");
    const tracked = TRACKED_LIBRARIES.find((prefix) => name.startsWith(prefix));
    if (!tracked || searched.has(seed)) continue;
    searched.add(seed);
    let resolved = seed;
    if (!seed.startsWith("/")) {
      const hit = await run("sh", ["-c", `ls /opt/homebrew/lib/${seed.replace(/^@rpath\//, "")} /usr/local/lib/${seed.replace(/^@rpath\//, "")} 2>/dev/null | head -1`]);
      resolved = hit.stdout.trim();
    }
    if (!resolved || !existsSync(resolved)) continue;
    const real = await realpathOf(resolved);
    if (!facts.has(tracked)) facts.set(tracked, { name: tracked, realpath: real, sha256: await sha256File(real) });
  }
  // libass is loaded by libavfilter on macOS; follow one more hop so it is never missed.
  if (!facts.has("libass") && process.platform === "darwin") {
    const filterLibrary = [...searched].find((seed) => seed.includes("libavfilter"));
    if (filterLibrary) {
      const resolved = filterLibrary.startsWith("/") ? filterLibrary : `/opt/homebrew/lib/${filterLibrary.replace(/^@rpath\//, "")}`;
      if (existsSync(resolved)) {
        for (const dependency of await linkedLibraries(await realpathOf(resolved))) {
          const name = dependency.split("/").pop()!.replace(/\.(\d+\.)*(dylib|so).*$/, "");
          const tracked = TRACKED_LIBRARIES.find((prefix) => name.startsWith(prefix));
          if (!tracked || facts.has(tracked) || !existsSync(dependency)) continue;
          const real = await realpathOf(dependency);
          facts.set(tracked, { name: tracked, realpath: real, sha256: await sha256File(real) });
        }
      }
    }
  }
  return [...facts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function probeFont(query: string): Promise<FontProbeResult> {
  const result = await run("fc-match", ["-f", "%{family}|%{style}|%{file}", query]);
  const [family, style, file] = result.stdout.split("|");
  if (result.code !== 0 || !file || !existsSync(file)) {
    return { query, family: family || null, style: style || null, file: file || null, sha256: null, ownerPackage: null };
  }
  let ownerPackage: string | null = null;
  if (process.platform === "linux") {
    const owner = await run("dpkg", ["-S", file]);
    ownerPackage = owner.code === 0 ? owner.stdout.split(":")[0]!.trim() : null;
  }
  return { query, family: family ?? null, style: style ?? null, file, sha256: await sha256File(file), ownerPackage };
}

async function captionFontHashes(repoRoot: string, directory: string): Promise<Record<string, string>> {
  const root = join(repoRoot, directory);
  if (!existsSync(root)) return {};
  const entries: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    if (/\.(ttf|otf|ttc)$/i.test(name)) entries[name] = await sha256File(join(root, name));
  }
  return entries;
}

/** Render a fixed multi-script line through libass exactly as captions are burned and hash the pixels. */
async function glyphRenderFingerprint(ffmpegPath: string | null, fontsDirectory: string | null): Promise<{ sha256: string | null; error: string | null }> {
  if (!ffmpegPath) return { sha256: null, error: "ffmpeg missing" };
  const directory = await mkdtemp(join(tmpdir(), "narriflow-glyph-"));
  try {
    const lines = GLYPH_PROBE_TEXT.map((text, index) => `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\pos(40,${60 + index * 56})}${text}`);
    const ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 960", "PlayResY: 360", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding", "Style: Default,Inter,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,10,10,10,1", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...lines, ""].join("\n");
    const assPath = join(directory, "probe.ass");
    await writeFile(assPath, ass, "utf8");
    const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const filter = `ass='${escaped(assPath)}'` + (fontsDirectory ? `:fontsdir='${escaped(fontsDirectory)}'` : "");
    const result = await run(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=960x360:r=1:d=1", "-vf", filter, "-frames:v", "1", "-f", "md5", "-"]);
    const match = /MD5=([0-9a-f]{32})/.exec(result.stdout);
    return match ? { sha256: match[1]!, error: null } : { sha256: null, error: result.stderr.slice(-300) || "no md5" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function pythonFacts(): Promise<RuntimeFingerprint["python"]> {
  const python = process.env.REFRAME_PYTHON?.trim() || "python3";
  const version = await run(python, ["--version"]);
  const listing = await run(python, ["-I", "-c", "import json,importlib.metadata as m;print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}))"]);
  let packages: Record<string, string> = {};
  let wheelProbeError: string | null = null;
  if (listing.code === 0) {
    try {
      packages = JSON.parse(listing.stdout.trim());
    } catch (error) {
      wheelProbeError = error instanceof Error ? error.message : String(error);
    }
  } else {
    wheelProbeError = listing.stderr.split("\n").slice(-2).join(" ").slice(0, 200);
  }
  const versionText = (version.stdout || version.stderr).trim().replace(/^Python /, "");
  return { version: version.code === 0 ? versionText : null, packages, wheelProbeError };
}

export interface CollectOptions {
  repoRoot?: string;
  lock?: RuntimeLock;
  modelPath?: string;
  /** Fonts directory handed to libass for the glyph probe. */
  captionFontsDirectory?: string;
}

export async function collectRuntimeFingerprint(options: CollectOptions = {}): Promise<RuntimeFingerprint> {
  const repoRoot = options.repoRoot ?? resolve(SCRIPT_DIR, "..", "..", "..");
  const lock = options.lock ?? loadLock();
  const ffmpegPath = await which("ffmpeg");
  const ffprobePath = await which("ffprobe");
  const ffmpegVersion = ffmpegPath ? await run(ffmpegPath, ["-hide_banner", "-version"]) : null;
  const ffprobeVersion = ffprobePath ? await run(ffprobePath, ["-hide_banner", "-version"]) : null;
  const platformLock = lock.platforms[platformKey()] ?? lock.platforms["linux-x64"]!;
  const wantedFilters = [...new Set([...platformLock.ffmpeg.requiredFilters, "tonemap", "zscale"])];
  const wantedEncoders = platformLock.ffmpeg.requiredEncoders;
  const filtersOut = ffmpegPath ? (await run(ffmpegPath, ["-hide_banner", "-filters"])).stdout : "";
  const encodersOut = ffmpegPath ? (await run(ffmpegPath, ["-hide_banner", "-encoders"])).stdout : "";
  const hasWord = (listing: string, name: string) => new RegExp(`^\\s*[A-Z.]{1,6}\\s+${name}\\s`, "m").test(listing);
  const modelPath = options.modelPath ?? process.env.REFRAME_MODEL_PATH?.trim() ?? [platformLock.model.path, join(repoRoot, "apps/worker/models/face_yunet.onnx")].find((candidate) => existsSync(candidate)) ?? null;
  const fontsDirectory = options.captionFontsDirectory ?? join(repoRoot, lock.captionFonts.directory);
  const fontconfig = await run("fc-match", ["--version"]);
  const osRelease = process.platform === "linux" ? (await run("sh", ["-c", ". /etc/os-release && echo \"$ID $VERSION_CODENAME $VERSION_ID\""])).stdout.trim() : (await run("sw_vers", ["-productVersion"])).stdout.trim();
  const queries = lock.platforms["linux-x64"]?.fonts.probes.map((probe) => probe.query) ?? DEFAULT_PROBE_QUERIES;
  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version ?? process.versions.bun ?? "unknown";
  return {
    platform: platformKey(),
    os: osRelease || process.platform,
    bun: bunVersion,
    ffmpeg: {
      path: ffmpegPath,
      versionLine: ffmpegVersion?.stdout.split("\n")[0]?.trim() ?? null,
      configuration: ffmpegVersion?.stdout.split("\n").find((line) => line.startsWith("configuration:"))?.slice("configuration:".length).trim() ?? null,
      libraries: ffmpegVersion?.stdout.split("\n").filter((line) => /^lib\w+\s+\d+\./.test(line)).map((line) => line.replace(/\s+/g, " ").trim()) ?? [],
      sha256: ffmpegPath ? await sha256File(await realpathOf(ffmpegPath)) : null,
    },
    ffprobe: {
      path: ffprobePath,
      versionLine: ffprobeVersion?.stdout.split("\n")[0]?.trim() ?? null,
      sha256: ffprobePath ? await sha256File(await realpathOf(ffprobePath)) : null,
    },
    linkedLibraries: await collectLibraries(ffmpegPath),
    filters: Object.fromEntries(wantedFilters.sort().map((name) => [name, hasWord(filtersOut, name)])),
    encoders: Object.fromEntries(wantedEncoders.map((name) => [name, hasWord(encodersOut, name)])),
    fontconfig: fontconfig.stdout.trim() || fontconfig.stderr.trim() || null,
    fontProbes: await Promise.all(queries.map(probeFont)),
    glyphRender: await glyphRenderFingerprint(ffmpegPath, existsSync(fontsDirectory) ? fontsDirectory : null),
    captionFonts: await captionFontHashes(repoRoot, lock.captionFonts.directory),
    model: { path: modelPath, sha256: modelPath && existsSync(modelPath) ? await sha256File(modelPath) : null },
    python: await pythonFacts(),
  };
}

/** Everything in the fingerprint that can change a rendered pixel or sample. Paths to tools and the version of Bun are excluded. */
export function fingerprintIdentity(fingerprint: RuntimeFingerprint): unknown {
  return {
    platform: fingerprint.platform,
    os: fingerprint.os,
    ffmpeg: { versionLine: fingerprint.ffmpeg.versionLine, configuration: fingerprint.ffmpeg.configuration, libraries: fingerprint.ffmpeg.libraries, sha256: fingerprint.ffmpeg.sha256 },
    ffprobe: { versionLine: fingerprint.ffprobe.versionLine, sha256: fingerprint.ffprobe.sha256 },
    linkedLibraries: fingerprint.linkedLibraries.map(({ name, sha256 }) => ({ name, sha256 })),
    filters: fingerprint.filters,
    encoders: fingerprint.encoders,
    fontconfig: fingerprint.fontconfig,
    fontProbes: fingerprint.fontProbes.map(({ query, family, style, sha256 }) => ({ query, family, style, sha256 })),
    glyphRender: fingerprint.glyphRender.sha256,
    captionFonts: fingerprint.captionFonts,
    model: fingerprint.model.sha256,
    python: fingerprint.python.packages,
  };
}

export function fingerprintId(fingerprint: RuntimeFingerprint): string {
  return createHash("sha256").update(JSON.stringify(fingerprintIdentity(fingerprint))).digest("hex");
}

/** The toolchain that determines generated fixture bytes (FFmpeg + x264), narrower than the whole fingerprint. */
export function fixtureToolchainId(fingerprint: RuntimeFingerprint): string {
  return createHash("sha256").update(JSON.stringify({ platform: fingerprint.platform, ffmpeg: fingerprint.ffmpeg.sha256, libs: fingerprint.linkedLibraries.filter((library) => ["libx264", "libx265", "libavcodec", "libavformat", "libavfilter", "libswscale", "libswresample", "libavutil"].includes(library.name)).map((library) => library.sha256) })).digest("hex").slice(0, 16);
}

/** Compare two fingerprints and name each differing section. */
export function fingerprintDifferences(left: RuntimeFingerprint, right: RuntimeFingerprint): string[] {
  const a = fingerprintIdentity(left) as Record<string, unknown>;
  const b = fingerprintIdentity(right) as Record<string, unknown>;
  return Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

async function dpkgVersions(names: string[]): Promise<Map<string, string>> {
  const result = await run("dpkg-query", ["-W", "-f", `\${Package} \${Version}\n`, ...names]);
  const versions = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const [name, version] = line.trim().split(" ");
    if (name && version) versions.set(name, version);
  }
  return versions;
}

/** Compare a fingerprint with the lock. Mismatches fail --enforce; gaps and info never do. */
export async function lockFindings(fingerprint: RuntimeFingerprint, lock: RuntimeLock, stage: Stage = "start"): Promise<Finding[]> {
  const findings: Finding[] = [];
  // Platform-independent inputs: the face model and the vendored caption faces.
  const modelPin = lock.platforms["linux-x64"]!.model.sha256;
  if (fingerprint.model.sha256 !== modelPin) findings.push({ level: "mismatch", check: "model", detail: `face model ${fingerprint.model.path} has SHA-256 ${fingerprint.model.sha256}, expected ${modelPin}` });
  if (stage !== "build") {
    const tampered = Object.entries(lock.captionFonts.sha256).filter(([file, sha]) => fingerprint.captionFonts[file] !== sha);
    if (tampered.length > 0) findings.push({ level: "mismatch", check: "captionFonts", detail: `vendored caption faces differ: ${tampered.map(([file]) => file).join(", ")}` });
  }
  const entry = lock.platforms[fingerprint.platform];
  if (!entry) {
    findings.push({ level: "info", check: "platform", detail: `${fingerprint.platform} has no lock entry; report-only host. Golden captures are compared only against captures with an identical fingerprint.` });
    return findings;
  }
  const expected = entry;
  if (!fingerprint.ffmpeg.versionLine?.includes(`ffmpeg version ${expected.ffmpeg.versionString} `)) findings.push({ level: "mismatch", check: "ffmpeg", detail: `expected ${expected.ffmpeg.versionString}, found ${fingerprint.ffmpeg.versionLine}` });
  if (!fingerprint.ffprobe.versionLine?.includes(`ffprobe version ${expected.ffmpeg.versionString} `)) findings.push({ level: "mismatch", check: "ffprobe", detail: `expected ${expected.ffmpeg.versionString}, found ${fingerprint.ffprobe.versionLine}` });
  for (const [name, present] of Object.entries(fingerprint.filters)) if (!present) findings.push({ level: "mismatch", check: "filter", detail: `FFmpeg filter ${name} is missing` });
  for (const [name, present] of Object.entries(fingerprint.encoders)) if (!present) findings.push({ level: "mismatch", check: "encoder", detail: `FFmpeg encoder ${name} is missing` });
  if (!fingerprint.glyphRender.sha256) findings.push({ level: "mismatch", check: "glyphRender", detail: fingerprint.glyphRender.error ?? "libass probe produced no frame" });

  if (fingerprint.platform === "linux-x64") {
    const installed = await dpkgVersions(Object.keys(expected.apt.installed));
    for (const [name, version] of Object.entries(expected.apt.installed)) {
      const found = installed.get(name);
      if (found !== version) findings.push({ level: "mismatch", check: "apt", detail: `${name}: expected ${version}, found ${found ?? "not installed"}` });
    }
    const [, codename] = fingerprint.os.split(" ");
    if (codename !== expected.os.versionCodename) findings.push({ level: "mismatch", check: "os", detail: `expected ${expected.os.id} ${expected.os.versionCodename}, found ${fingerprint.os}` });
    const wantedPackages = new Set(expected.fonts.packages);
    for (const probe of fingerprint.fontProbes) {
      if (!probe.file) {
        findings.push({ level: "mismatch", check: "fonts", detail: `${probe.query} resolved no file` });
        continue;
      }
      if (probe.ownerPackage && !wantedPackages.has(probe.ownerPackage)) findings.push({ level: "mismatch", check: "fonts", detail: `${probe.query} resolved ${probe.file} from unpinned package ${probe.ownerPackage}` });
      const pin = expected.fonts.probes.find((candidate) => candidate.query === probe.query)?.expectedSha256;
      if (pin && pin !== probe.sha256) findings.push({ level: "mismatch", check: "fonts", detail: `${probe.query} resolved ${probe.file} with SHA-256 ${probe.sha256}, expected ${pin}` });
      if (!pin) findings.push({ level: "gap", check: "fonts", detail: `${probe.query} -> ${probe.file} (${probe.sha256}) has no pinned expectation yet` });
    }
    const missingWheels = expected.python.wheels.filter((wheel) => fingerprint.python.packages[wheel.name] !== wheel.version);
    for (const wheel of missingWheels) findings.push({ level: "mismatch", check: "python", detail: `${wheel.name}: expected ${wheel.version}, found ${fingerprint.python.packages[wheel.name] ?? "not installed"}` });
    if (fingerprint.python.version !== expected.python.version) findings.push({ level: "mismatch", check: "python", detail: `expected Python ${expected.python.version}, found ${fingerprint.python.version}` });
  }

  return findings;
}

/** Throws when the environment differs from the lock. Worker startup calls this on the linux-x64 image. */
export async function assertRenderEnvironment(options: CollectOptions & { stage?: Stage } = {}): Promise<RuntimeFingerprint> {
  const lock = options.lock ?? loadLock();
  const fingerprint = await collectRuntimeFingerprint({ ...options, lock });
  const findings = (await lockFindings(fingerprint, lock, options.stage ?? "start")).filter((finding) => finding.level === "mismatch");
  if (findings.length > 0) {
    throw new Error(`render environment does not match runtime-lock.json:\n${findings.map((finding) => `  [${finding.check}] ${finding.detail}`).join("\n")}`);
  }
  return fingerprint;
}

/** `name==version --hash=sha256:...` lines for `pip install --require-hashes --no-deps`. */
export function pipRequirements(lock: RuntimeLock): string {
  return lock.platforms["linux-x64"]!.python.wheels.map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const lock = loadLock();
  if (args.includes("--emit-pip-requirements")) {
    process.stdout.write(pipRequirements(lock));
    return;
  }
  const stage = (args[args.indexOf("--stage") + 1] as Stage | undefined) ?? "start";
  const fingerprint = await collectRuntimeFingerprint({ lock });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ id: fingerprintId(fingerprint), fixtureToolchainId: fixtureToolchainId(fingerprint), fingerprint }, null, 2));
  }
  const findings = await lockFindings(fingerprint, lock, stage);
  const enforce = args.includes("--enforce");
  const mismatches = findings.filter((finding) => finding.level === "mismatch");
  if (!args.includes("--json")) {
    console.log(`render environment ${fingerprint.platform} fingerprint ${fingerprintId(fingerprint).slice(0, 16)} (${enforce ? "enforce" : "report-only"}, stage ${stage})`);
    for (const finding of findings) console.log(`${finding.level.padEnd(8)} [${finding.check}] ${finding.detail}`);
  }
  if (enforce && !lock.platforms[fingerprint.platform]) {
    console.error(`no runtime-lock.json entry for ${fingerprint.platform}; --enforce is for the pinned image`);
    process.exit(1);
  }
  if (enforce && mismatches.length > 0) {
    console.error(`${mismatches.length} mismatch(es) against runtime-lock.json`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
