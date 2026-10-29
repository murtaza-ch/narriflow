/**
 * Render golden parity harness (render hardening ticket 01).
 *
 * DB-free capture/verify of what the render pipeline produces for a frozen set
 * of editor documents, layout evidence and synthetic sources. A capture records
 * the canonical composition plans, crop/cue/layer decisions, normalized FFmpeg
 * argv and filtergraph bytes, decoded frame hashes with timestamps, decoded PCM
 * hashes, ffprobe facts, loudness, a full decode and review snapshots. Verify
 * renders the same suite again and compares exactly.
 *
 *   bun apps/worker/scripts/render-golden.ts stage [--pin] [--rebuild]
 *   bun apps/worker/scripts/render-golden.ts capture --suite all --out DIR
 *   bun apps/worker/scripts/render-golden.ts verify --baseline DIR --suite all --out DIR
 *   bun apps/worker/scripts/render-golden.ts describe
 *
 * Captures are only comparable when taken with the same runtime fingerprint
 * (FFmpeg/libass/fontconfig builds, resolved fallback fonts, model hash; see
 * check-render-environment.ts). Verify refuses otherwise. The pipeline under
 * test is the production code path: inspectMedia -> planClipComposition ->
 * audio schedule -> caption ASS -> compileClipCompositionCommand -> ffmpeg.
 * Frozen documents carry final clip timing, so resolveClipRenderTiming is not
 * part of the harness.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  automaticLayoutInputFingerprint,
  compositionAssetRef,
  planClipComposition,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
  type ClipCompositionPlan,
} from "@narriflow/composition-plan";
import {
  CLIP_AUTO_LAYOUT_ENGINE,
  SCREEN_LAYOUT_ENGINE_VERSION,
  autoCensorWordId,
  buildClipCutPlan,
  clipAspectRatioOptions,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
  resolveEffectiveLogoSettings,
} from "@narriflow/validators";
import { prepareCaptionFontsDirectory } from "../src/brand-font-resolution";
import type { CaptionTrack } from "../src/caption-ass";
import { CAPTION_RENDER_DIAGNOSTIC_PATTERN, captionRenderDiagnosticsFailure, classifyCaptionRenderDiagnostics } from "../src/caption-glyphs";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
  compileCompositionPlanCaptions,
  hdrColorOf,
  type HdrColor,
} from "../src/composition-ffmpeg-adapter";
import { guardMixPeak, MixPeakError, mixPeakMeasureDeadlineMs } from "../src/render-mix-peak";
import { compositionSourceFor } from "../src/tasks/clip-render-attempt";
import { productionWorkerProcessModule, type WorkerMediaInspection } from "../src/worker-process";
import {
  collectRuntimeFingerprint,
  fingerprintDifferences,
  fingerprintId,
  fixtureToolchainId,
  loadLock,
  type RuntimeFingerprint,
} from "./check-render-environment";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
export const FIXTURE_DIR = join(SCRIPT_DIR, "..", "src", "__fixtures__", "render-golden");
const SCHEMA_VERSION = 1;
const CHUNK_SECONDS = 0.1;
const FFMPEG_QUIET = ["-nostdin", "-hide_banner", "-loglevel", "error"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Dict = Record<string, any>;

export interface Assertion {
  id: string;
  metric: string;
  op: "eq" | "ne" | "lte" | "gte" | "between" | "absLte" | "in";
  value: unknown;
}

export interface FixtureRecipe {
  file: string;
  kind: "video" | "audio" | "image" | "bytes";
  description: string;
  steps: Array<string[] | { hex: string }>;
  sha256ByToolchain?: Record<string, string>;
}

export interface Manifest {
  version: number;
  encoder: { preset: string; crf: string };
  fixtures: Record<string, FixtureRecipe>;
  suites: Record<string, string[]>;
}

export interface CaseDefinition {
  class: "normal" | "known-defect";
  description: string;
  source: string;
  document: Dict;
  targets: Array<{ id: string; aspectRatio: string; resolution?: "720p" | "1080p"; watermark?: boolean }>;
  evidence?: string;
  assets?: Dict;
  probes?: string[];
  expected?: { quadrantsFrom?: string };
  censorWord?: { utteranceIndex: number; wordIndex: number };
  viewState?: Dict;
  twinOf?: string;
  transport?: { kind: "http"; failAtFraction: number };
  compare?: "signature";
}

export interface KnownDefect {
  defect: string;
  owner: string;
  /** "pass" marks a regression guard: a non-identity fixture whose current output is already right. */
  expect?: "pass";
  predicate: string;
  contract: Assertion[];
}

export interface Activation {
  ticket: string;
  /** `change: "output-sar"` marks a normal case whose only allowed difference
   * is the appended `,setsar=1` and the SAR/DAR tags (with the extradata size of the SPS that carries them) becoming 1:1.
   * `change: "glyph-coverage"` marks a normal case whose captions use glyphs outside the caption face: the ASS script, the
   * decoded frames and libass's font diagnostics may change (host-font fallback becomes the pinned chain), nothing else. */
  cases: Record<string, { contract: Assertion[]; retain?: string[]; change?: "output-sar" | "glyph-coverage" }>;
}

export interface Inputs {
  manifest: Manifest;
  cases: Record<string, CaseDefinition>;
  evidence: Record<string, Dict>;
  knownDefects: Record<string, KnownDefect>;
  activations: Record<string, Activation>;
  hashes: { manifest: string; documents: string; evidence: string; knownDefects: string; activations: Record<string, string> };
}

export interface TargetRecord {
  targetId: string;
  aspectRatio: string;
  resolution: string;
  plan: {
    fingerprint: string;
    sha256: string;
    audioScheduleFingerprint: string;
    editedDurationSec: number;
    noticeCodes: string[];
    crops: Dict[];
    cues: Dict[];
    layers: Dict[];
    scenes: Dict[];
  };
  captions: { assSha256: string | null };
  command: { argv: string[]; argvSha256: string; filterGraph: string | null; filterGraphSha256: string | null; argBytes: number };
  encode: { exitCode: number | null; diagnostics: string[]; mixPeak?: Dict };
  output: null | {
    sizeBytes: number;
    ffprobe: Dict;
    video: { frameCount: number; timeBase: string; frames: Array<[number, string]>; framesSha256: string } | null;
    audio: { sampleRate: number; channels: number; sampleCount: number; pcmSha256: string; chunks: string[]; samplePeak: number } | null;
    loudness: { integratedLufs: number | null; truePeakDbtp: number | null; loudnessRangeLu: number | null } | null;
    fullDecode: { ok: boolean; stderr: string };
    snapshots: Array<{ label: string; timeSec: number; file: string; sha256: string }>;
  };
  measurements: Dict;
}

export interface CaseRecord {
  id: string;
  class: "normal" | "known-defect";
  status: "rendered" | "failed";
  failure: null | { stage: "inspect" | "plan" | "compile" | "encode"; code: string | null; message: string };
  inputs: { source: { fixture: string; sha256: string }; assets: Record<string, string>; documentSha256: string; evidenceSha256: string | null };
  inspection: Dict | null;
  targets: TargetRecord[];
  defects: null | { evaluated: string; results: Array<{ targetId: string; assertionId: string; pass: boolean; actual: unknown }> };
}

export interface CaptureFile {
  schemaVersion: number;
  kind: "render-golden-capture";
  createdAt: string;
  git: { commit: string; dirtyPaths: string[] };
  fingerprintId: string;
  fingerprint: RuntimeFingerprint;
  toolchainId: string;
  inputHashes: Inputs["hashes"];
  fixtures: Record<string, string>;
  suite: string;
  cases: Record<string, CaseRecord>;
}

export interface Mismatch {
  case: string;
  target?: string;
  category: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Dict)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export async function sha256OfFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

interface ProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function runProcess(command: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd, env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" } });
    const out: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs) : null;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolveResult({ code: null, stdout: Buffer.alloc(0), stderr: String(error) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolveResult({ code: timedOut ? null : code, stdout: Buffer.concat(out), stderr: timedOut ? `${stderr}\n[timeout]` : stderr }); });
  });
}

const ffmpeg = (args: string[], timeoutMs = 300_000, cwd?: string) => runProcess("ffmpeg", [...FFMPEG_QUIET, ...args], { timeoutMs, cwd });

async function ffprobeJson(path: string): Promise<Dict> {
  const result = await runProcess("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`ffprobe failed for ${path}: ${result.stderr.slice(-300)}`);
  return JSON.parse(result.stdout.toString("utf8"));
}

function cacheRoot(override?: string): string {
  const root = override ?? process.env.NARRIFLOW_GOLDEN_CACHE ?? join(homedir(), ".cache", "narriflow-render-golden");
  return root;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readJson(path: string): { value: Dict; sha256: string } {
  const text = readFileSync(path, "utf8");
  return { value: JSON.parse(text), sha256: sha256(text) };
}

export function loadInputs(fixtureDir: string = FIXTURE_DIR): Inputs {
  const manifest = readJson(join(fixtureDir, "manifest.json"));
  const documents = readJson(join(fixtureDir, "documents.json"));
  const evidence = readJson(join(fixtureDir, "evidence.json"));
  const known = readJson(join(fixtureDir, "known-defects.json"));
  const activations: Record<string, Activation> = {};
  const activationHashes: Record<string, string> = {};
  const expectedDir = join(fixtureDir, "expected");
  if (existsSync(expectedDir)) {
    for (const name of readdirSync(expectedDir).filter((file) => file.endsWith(".json")).sort()) {
      const parsed = readJson(join(expectedDir, name));
      activations[name] = parsed.value as Activation;
      activationHashes[name] = parsed.sha256;
    }
  }
  return {
    manifest: manifest.value as Manifest,
    cases: documents.value.cases,
    evidence: evidence.value.evidence,
    knownDefects: known.value.cases,
    activations,
    hashes: { manifest: manifest.sha256, documents: documents.sha256, evidence: evidence.sha256, knownDefects: known.sha256, activations: activationHashes },
  };
}

export function suiteCaseIds(inputs: Inputs, suite: string, only?: string[]): string[] {
  const ids = suite === "all" ? [...inputs.manifest.suites.normal!, ...inputs.manifest.suites["known-defects"]!] : inputs.manifest.suites[suite];
  if (!ids) throw new Error(`unknown suite ${suite}; use all, normal or known-defects`);
  const selected = only && only.length > 0 ? ids.filter((id) => only.includes(id)) : ids;
  const unknown = (only ?? []).filter((id) => !ids.includes(id));
  if (unknown.length > 0) throw new Error(`cases not in suite ${suite}: ${unknown.join(", ")}`);
  return selected;
}

function activationFor(inputs: Inputs, caseId: string): { ticket: string; contract: Assertion[]; retain: string[]; change?: "output-sar" | "glyph-coverage" } | null {
  for (const activation of Object.values(inputs.activations)) {
    const entry = activation.cases[caseId];
    if (entry && entry.contract.length > 0) return { ticket: activation.ticket, contract: entry.contract, retain: entry.retain ?? [], change: entry.change };
  }
  return null;
}

/** A case may carry the approved SAR-declaration change with or without a corrected contract. */
function allowsOutputSar(inputs: Inputs, caseId: string): boolean {
  return Object.values(inputs.activations).some((activation) => activation.cases[caseId]?.change === "output-sar");
}

/** A case may carry the approved glyph-coverage change: the pinned fallback chain replaces host fonts. */
function allowsGlyphCoverage(inputs: Inputs, caseId: string): boolean {
  return Object.values(inputs.activations).some((activation) => activation.cases[caseId]?.change === "glyph-coverage");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface StagedFixtures {
  directory: string;
  toolchainId: string;
  files: Record<string, { path: string; sha256: string }>;
}

function fixtureSteps(recipe: FixtureRecipe, paths: { out: string; fixture(id: string): string }): Array<string[] | { hex: string }> {
  return recipe.steps.map((step) =>
    Array.isArray(step)
      ? step.map((arg) => arg.replace("{out}", paths.out).replace(/\{fixture:([^}]+)\}/g, (_match, id: string) => paths.fixture(id)))
      : step,
  );
}

/**
 * Generate (when missing) and verify every fixture in the content-addressed cache.
 * Strict mode (capture/verify) fails on a mismatching or unpinned file instead of rebuilding it.
 */
export async function stageFixtures(options: {
  manifest: Manifest;
  toolchainId: string;
  ids?: string[];
  cacheDir?: string;
  pin?: boolean;
  rebuild?: boolean;
  manifestPath?: string;
}): Promise<StagedFixtures> {
  const directory = join(cacheRoot(options.cacheDir), options.toolchainId);
  await mkdir(directory, { recursive: true });
  const files: StagedFixtures["files"] = {};
  const wanted = new Set<string>();
  const need = (id: string) => {
    if (wanted.has(id)) return;
    const recipe = options.manifest.fixtures[id];
    if (!recipe) throw new Error(`unknown fixture ${id}`);
    for (const step of recipe.steps) if (Array.isArray(step)) for (const arg of step) for (const match of arg.matchAll(/\{fixture:([^}]+)\}/g)) need(match[1]!);
    wanted.add(id);
  };
  for (const id of options.ids ?? Object.keys(options.manifest.fixtures)) need(id);
  const pinned: Record<string, string> = {};

  for (const id of Object.keys(options.manifest.fixtures).filter((candidate) => wanted.has(candidate))) {
    const recipe = options.manifest.fixtures[id]!;
    const path = join(directory, recipe.file);
    if (options.rebuild) await rm(path, { force: true });
    if (!existsSync(path)) {
      const partial = join(directory, `${recipe.file.replace(/(\.[^.]+)$/, ".partial$1")}`);
      await rm(partial, { force: true });
      for (const step of fixtureSteps(recipe, { out: partial, fixture: (other) => files[other]!.path })) {
        if (!Array.isArray(step)) {
          await writeFile(partial, Buffer.from(step.hex, "hex"));
          continue;
        }
        const result = await ffmpeg(["-y", ...step], 300_000);
        if (result.code !== 0) throw new Error(`fixture ${id} failed to generate: ${result.stderr.slice(-400)}`);
      }
      await rename(partial, path);
    }
    const actual = await sha256OfFile(path);
    const expected = recipe.sha256ByToolchain?.[options.toolchainId];
    if (expected && expected !== actual) {
      throw new Error(`fixture ${id} (${path}) has SHA-256 ${actual} but the manifest pins ${expected} for toolchain ${options.toolchainId}; the cached file was changed or the toolchain is not deterministic. Delete it (stage --rebuild) only if the change is understood.`);
    }
    if (!expected) {
      if (!options.pin) throw new Error(`fixture ${id} has no pinned SHA-256 for toolchain ${options.toolchainId}; run: bun apps/worker/scripts/render-golden.ts stage --pin`);
      pinned[id] = actual;
    }
    files[id] = { path, sha256: actual };
  }
  if (options.pin && Object.keys(pinned).length > 0) {
    const manifestPath = options.manifestPath ?? join(FIXTURE_DIR, "manifest.json");
    const text = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    for (const [id, hash] of Object.entries(pinned)) {
      const recipe = text.fixtures[id]!;
      recipe.sha256ByToolchain = { ...(recipe.sha256ByToolchain ?? {}), [options.toolchainId]: hash };
    }
    await writeFile(manifestPath, JSON.stringify(text, null, 2) + "\n");
  }
  return { directory, toolchainId: options.toolchainId, files };
}

// ---------------------------------------------------------------------------
// Planning and command compilation (the production path)
// ---------------------------------------------------------------------------

interface CaseContext {
  inputs: Inputs;
  fixtures: StagedFixtures;
  caseDir: string;
  repoRoot: string;
  signal: AbortSignal;
}

function aspectOption(aspectRatio: string) {
  const option = clipAspectRatioOptions.find((candidate) => candidate.value === aspectRatio);
  if (!option) throw new Error(`unknown aspect ratio ${aspectRatio}`);
  return option;
}

function buildEvidence(definition: Dict, name: string | undefined, input: { sourceIdentity: string; clipStartSec: number; clipEndSec: number; deletedRanges: any[]; editedDurationSec: number; width: number; height: number }) {
  if (!name) return { automaticLayout: { state: "missing" as const } };
  const entry = definition[name];
  if (!entry) throw new Error(`unknown evidence ${name}`);
  const common = { sourceIdentity: input.sourceIdentity, clipStartSec: input.clipStartSec, clipEndSec: input.clipEndSec, deletedRanges: input.deletedRanges };
  if (entry.kind === "auto") {
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: CLIP_AUTO_LAYOUT_ENGINE,
      sourceIdentity: input.sourceIdentity,
      analyzedAtISO: "2026-10-29T00:00:00.000Z",
      clipStartSec: input.clipStartSec,
      clipEndSec: input.clipEndSec,
      deletedRanges: input.deletedRanges,
      editedDurationSec: input.editedDurationSec,
      sourceWidth: input.width,
      sourceHeight: input.height,
      segments: entry.segments,
      noSplitSegments: entry.noSplitSegments,
      shotCount: entry.shotCount,
      soloShotCount: entry.soloShotCount,
      multiShotCount: entry.multiShotCount,
      twoUpSegmentCount: entry.twoUpSegmentCount,
      speakerCount: entry.speakerCount,
      mappedSpeakerCount: entry.mappedSpeakerCount,
    });
    return {
      automaticLayout: {
        state: "available" as const,
        value: { sourceIdentity: input.sourceIdentity, inputFingerprint: automaticLayoutInputFingerprint({ ...common, engineVersion: CLIP_AUTO_LAYOUT_ENGINE }), engineVersion: CLIP_AUTO_LAYOUT_ENGINE, analysis },
      },
    };
  }
  if (entry.kind === "split") {
    return {
      automaticLayout: { state: "missing" as const },
      splitLayout: {
        state: "available" as const,
        value: { sourceIdentity: input.sourceIdentity, inputFingerprint: splitLayoutInputFingerprint({ ...common, engineVersion: "explicit-split-v1" }), engineVersion: "explicit-split-v1", source: entry.source, segments: entry.segments, fallbackSegments: entry.fallbackSegments },
      },
    };
  }
  return {
    automaticLayout: { state: "missing" as const },
    screenLayout: {
      state: "available" as const,
      value: { sourceIdentity: input.sourceIdentity, inputFingerprint: screenLayoutInputFingerprint({ ...common, engineVersion: SCREEN_LAYOUT_ENGINE_VERSION }), engineVersion: SCREEN_LAYOUT_ENGINE_VERSION, source: entry.source, pictureInPicture: entry.pictureInPicture, faceBand: entry.faceBand },
    },
  };
}

interface Planned {
  plan: ClipCompositionPlan;
  document: ReturnType<typeof editorDocumentSchema.parse>;
  inspection: WorkerMediaInspection;
  sourcePath: string;
  assets: {
    logo: Dict | null;
    background: Dict | null;
    broll: Record<string, string>;
    scenes: Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>;
    hdr: Record<string, HdrColor>;
    musicPath: { sourceRef: string; path: string } | null;
    soundEffects: Array<{ id: string; sourceRef: string; path: string }>;
    assetHashes: Record<string, string>;
  };
  cutPlan: ReturnType<typeof buildClipCutPlan>;
}

async function planCase(context: CaseContext, id: string, definition: CaseDefinition, sourcePath: string): Promise<Planned> {
  const signal = context.signal;
  const inspection = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 120_000 });
  const document = editorDocumentSchema.parse(structuredClone(definition.document));
  if (definition.censorWord) {
    const { utteranceIndex, wordIndex } = definition.censorWord;
    const word = document.transcriptSlice[utteranceIndex]!.words[wordIndex]!;
    const wordId = autoCensorWordId({ utteranceIndex, wordIndex, word });
    for (const segment of document.censorSegments) segment.sourceWordIds = [wordId];
  }
  const sourceIdentity = `golden:${definition.source}`;
  const cutPlan = buildClipCutPlan(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec });
  const hasVideo = inspection.hasVideo;
  const plannerSource = compositionSourceFor(inspection, sourceIdentity);
  const evidence = hasVideo
    ? buildEvidence(context.inputs.evidence, definition.evidence, {
        sourceIdentity, clipStartSec: document.clipStartSec, clipEndSec: document.clipEndSec, deletedRanges: document.deletedRanges,
        editedDurationSec: cutPlan.isUncut ? document.clipEndSec - document.clipStartSec : cutPlan.editedDurationSec, width: plannerSource.width, height: plannerSource.height,
      })
    : { automaticLayout: { state: "missing" as const } };

  const studio = document.studioEdits;
  const assetDefs: Dict = definition.assets ?? {};
  const assetHashes: Record<string, string> = {};
  const fixturePath = (fixture: string) => {
    const staged = context.fixtures.files[fixture];
    if (!staged) throw new Error(`case ${id} needs fixture ${fixture}`);
    assetHashes[fixture] = staged.sha256;
    return staged.path;
  };

  let logo: Dict | null = null;
  let plannedLogo: Dict | null = null;
  if (assetDefs.logo) {
    const brand = { filePath: fixturePath(assetDefs.logo.fixture), ref: compositionAssetRef("logo", "golden-logo"), position: assetDefs.logo.position, opacity: assetDefs.logo.opacity, scalePct: assetDefs.logo.scalePct };
    const effective = resolveEffectiveLogoSettings({ position: brand.position, opacity: brand.opacity, scalePct: brand.scalePct }, studio.logo);
    plannedLogo = effective;
    logo = effective.enabled ? { filePath: brand.filePath, ref: brand.ref, position: effective.position, opacity: effective.opacity, scalePct: effective.scalePct } : null;
    plannedLogo = { ref: brand.ref, settings: effective };
  }

  const scenes: Planned["assets"]["scenes"] = {};
  const hdr: Planned["assets"]["hdr"] = {};
  const sceneVisuals: Dict = {};
  const visualDefs: Dict = assetDefs.visualAssets ?? {};
  for (const [assetId, def] of Object.entries<Dict>(visualDefs)) {
    const ref = compositionAssetRef("visual_asset", `${assetId}:${def.fingerprint}`);
    const path = fixturePath(def.fixture);
    const layerInspection = def.kind === "video" ? await productionWorkerProcessModule.inspectMedia({ sourcePath: path, signal, deadlineMs: 120_000 }) : null;
    scenes[ref] = { path, kind: def.kind, hasAudio: layerInspection?.hasAudio ?? false };
    const layerHdr = layerInspection ? hdrColorOf(layerInspection) : null;
    if (layerHdr) hdr[ref] = layerHdr;
  }
  for (const block of document.sceneBlocks) {
    if (block.content.kind === "image" || block.content.kind === "video") {
      sceneVisuals[block.id] = { state: "available", ref: compositionAssetRef("visual_asset", `${block.content.asset.id}:${block.content.asset.fingerprint}`) };
    }
  }

  const broll: Record<string, string> = {};
  const brollPlacements = studio.visualBroll.map((placement) => {
    const ref = compositionAssetRef("visual_asset", `${placement.asset.id}:${placement.asset.fingerprint}`);
    if (scenes[ref]) broll[ref] = scenes[ref]!.path;
    return { id: placement.id, ref, kind: "image" as const, startSec: placement.startSec, endSec: placement.endSec };
  });

  let music: Dict | undefined;
  let musicPath: Planned["assets"]["musicPath"] = null;
  if (studio.music.assetId || studio.music.url) {
    const def = assetDefs.music;
    if (!def) throw new Error(`case ${id} requests music without an asset`);
    const path = fixturePath(def.fixture);
    const duration = (await productionWorkerProcessModule.inspectMedia({ sourcePath: path, signal, deadlineMs: 120_000 })).durationSec;
    const ref = compositionAssetRef("music", studio.music.assetId ?? studio.music.url!);
    music = { state: "available", ref, durationSec: duration };
    musicPath = { sourceRef: ref, path };
  }
  const soundEffects: Dict = {};
  const sfxPaths: Planned["assets"]["soundEffects"] = [];
  for (const placement of studio.sfx) {
    const def = assetDefs.sfx?.[placement.id];
    if (!def) throw new Error(`case ${id} requests sfx ${placement.id} without an asset`);
    const path = fixturePath(def.fixture);
    const duration = (await productionWorkerProcessModule.inspectMedia({ sourcePath: path, signal, deadlineMs: 120_000 })).durationSec;
    const ref = compositionAssetRef("sound-effect", placement.assetId);
    soundEffects[placement.id] = { state: "available", ref, durationSec: duration };
    sfxPaths.push({ id: placement.id, sourceRef: ref, path });
  }

  let background: Dict | null = null;
  let backgroundImage: Dict = { state: "missing" };
  if (assetDefs.background) {
    background = { mode: "image", color: assetDefs.background.color, imagePath: fixturePath(assetDefs.background.fixture) };
    if (studio.background.mode === "image" && studio.background.imageUrl) backgroundImage = { state: "available", ref: compositionAssetRef("background", studio.background.imageUrl) };
  }

  const result = planClipComposition({
    document,
    source: plannerSource,
    evidence: evidence as any,
    assets: {
      backgroundImage: backgroundImage as any,
      sceneVisuals,
      sceneFonts: {},
      ...(music ? { music: music as any } : {}),
      soundEffects: soundEffects as any,
      ...(brollPlacements.length > 0 ? { broll: { state: "available", placements: brollPlacements } as any } : {}),
      ...(plannedLogo ? { logo: { state: "available", ref: plannedLogo.ref, settings: plannedLogo.settings } as any } : {}),
    },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE,
      explicitSplitLayout: true,
      splitEngineVersion: "explicit-split-v1",
      screenLayout: true,
      screenEngineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
    },
    targets: definition.targets.map((target) => {
      const option = aspectOption(target.aspectRatio);
      return { id: target.id, aspectRatio: option.value, width: option.width, height: option.height, outputTreatment: { resolution: target.resolution ?? "1080p", watermark: target.watermark ?? false } } as any;
    }),
  });
  if (result.status === "invalid") {
    const error = new Error(`Clip Composition Plan rejected ${result.error.code}`);
    (error as any).code = result.error.code;
    throw error;
  }
  return { plan: result.plan, document, inspection, sourcePath, assets: { logo, background, broll, scenes, hdr, musicPath, soundEffects: sfxPaths, assetHashes }, cutPlan };
}

// ---------------------------------------------------------------------------
// Normalization of attempt-local values
// ---------------------------------------------------------------------------

export function pathNormalizer(replacements: Array<[string, string]>): (text: string) => string {
  const ordered = [...replacements].filter(([from]) => from.length > 0).sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let result = text;
    for (const [from, to] of ordered) result = result.split(from).join(to);
    return result.replace(/https?:\/\/127\.0\.0\.1:\d+/g, "{http}");
  };
}

function graphOf(argv: string[]): string | null {
  const index = argv.indexOf("-filter_complex");
  return index >= 0 ? argv[index + 1]! : null;
}

// ---------------------------------------------------------------------------
// Plan summaries
// ---------------------------------------------------------------------------

function summarizePlan(plan: ClipCompositionPlan, target: ClipCompositionPlan["targets"][number]) {
  const crops: Dict[] = [];
  const scenes: Dict[] = [];
  for (const scene of target.scenes) {
    scenes.push({ id: scene.id, startSec: scene.startSec, endSec: scene.endSec, layers: scene.layers.map((layer: any) => ({ id: layer.id, kind: layer.kind })) });
    for (const layer of scene.layers as any[]) {
      if (layer.kind === "source-video") {
        crops.push({ scene: scene.id, startSec: scene.startSec, endSec: scene.endSec, layer: layer.id, sourceCrop: layer.sourceCrop, sourceCropTrack: layer.sourceCropTrack ?? null, destination: layer.destination, fit: layer.fit, rotationDeg: layer.rotationDeg });
      }
    }
  }
  const cues = (target.visualLayers as any[])
    .filter((layer) => layer.kind === "caption")
    .map((layer) => ({ cueIndex: layer.cueIndex, activeRange: layer.activeRange, anchor: layer.anchor, destination: layer.destination, words: layer.words.map((word: any) => [word.text, word.emoji, word.startSec, word.endSec]), preset: sha256(canonicalJson(layer.preset)).slice(0, 16) }));
  const layers = (target.visualLayers as any[]).map((layer) => ({ id: layer.id, kind: layer.kind, zIndex: layer.zIndex, activeRange: layer.activeRange ?? null, destination: layer.destination, opacity: layer.opacity, rotationDeg: layer.rotationDeg }));
  return {
    fingerprint: plan.fingerprint,
    sha256: sha256(canonicalJson(plan)),
    audioScheduleFingerprint: plan.audioSchedule.fingerprint,
    editedDurationSec: plan.editedDurationSec,
    noticeCodes: plan.notices.map((notice) => notice.code),
    crops, cues, layers, scenes,
  };
}

// ---------------------------------------------------------------------------
// Output measurement
// ---------------------------------------------------------------------------

function parseRate(value: string | undefined): number {
  const [n, d = "1"] = (value ?? "0/1").split("/");
  const result = Number(n) / Number(d);
  return Number.isFinite(result) ? result : 0;
}

function stripVolatile(probe: Dict): Dict {
  const copy = structuredClone(probe);
  delete copy.format?.filename;
  return copy;
}

/** Container and encoder-dependent fields are recorded but never gate. */
function gatingProbe(probe: Dict): Dict {
  const copy = structuredClone(probe);
  if (copy.format) { delete copy.format.size; delete copy.format.bit_rate; delete copy.format.tags; delete copy.format.filename; }
  for (const stream of copy.streams ?? []) { delete stream.bit_rate; delete stream.tags; delete stream.max_bit_rate; }
  return copy;
}

async function framemd5(path: string): Promise<{ frames: Array<[number, string]>; timeBase: number; timeBaseText: string }> {
  const result = await ffmpeg(["-i", path, "-map", "0:v:0", "-f", "framemd5", "-"]);
  if (result.code !== 0) throw new Error(`framemd5 failed: ${result.stderr.slice(-300)}`);
  const text = result.stdout.toString("utf8");
  const tb = /#tb 0:\s*(\d+)\/(\d+)/.exec(text);
  const frames = text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
    const parts = line.split(",").map((part) => part.trim());
    return [Number(parts[2]), parts[5]!.slice(0, 16)] as [number, string];
  });
  return { frames, timeBase: tb ? Number(tb[1]) / Number(tb[2]) : 1, timeBaseText: tb ? `${tb[1]}/${tb[2]}` : "1/1" };
}

async function decodePcm(path: string, sampleRate: number, channels: number) {
  const result = await ffmpeg(["-i", path, "-map", "0:a:0", "-f", "f32le", "-c:a", "pcm_f32le", "-"]);
  if (result.code !== 0) return null;
  const buffer = result.stdout;
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]!); if (v > peak) peak = v; }
  const chunkBytes = Math.max(4 * channels, Math.round(CHUNK_SECONDS * sampleRate) * channels * 4);
  const chunks: string[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += chunkBytes) chunks.push(sha256(buffer.subarray(offset, Math.min(buffer.byteLength, offset + chunkBytes))).slice(0, 12));
  return { samples, sha256: sha256(buffer), chunks, sampleCount: Math.floor(samples.length / channels), samplePeak: peak };
}

async function loudness(path: string) {
  const result = await runProcess("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], { timeoutMs: 120_000 });
  const summary = result.stderr.slice(result.stderr.lastIndexOf("Summary:"));
  const read = (label: RegExp) => { const m = label.exec(summary); return m && m[1] !== "-inf" ? Number(m[1]) : null; };
  if (!summary.includes("Summary:")) return null;
  return { integratedLufs: read(/I:\s+(-?[\d.]+|-inf) LUFS/), truePeakDbtp: read(/Peak:\s+(-?[\d.]+|-inf) dBFS/), loudnessRangeLu: read(/LRA:\s+(-?[\d.]+|-inf) LU/) };
}

async function rawFrame(path: string, timeSec: number, width: number): Promise<{ data: Buffer; width: number; height: number } | null> {
  const probe = await runProcess("ffmpeg", [...FFMPEG_QUIET, "-ss", String(timeSec), "-i", path, "-frames:v", "1", "-vf", `scale=${width}:-2:flags=neighbor`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { timeoutMs: 60_000 });
  if (probe.code !== 0 || probe.stdout.length === 0) return null;
  const pixels = probe.stdout.length / 3;
  const height = Math.round(pixels / width);
  return { data: probe.stdout, width, height };
}

const QUADRANT_REFERENCES: Array<[string, [number, number, number]]> = [["R", [255, 0, 0]], ["G", [0, 128, 0]], ["B", [0, 0, 255]], ["Y", [255, 255, 0]]];

export function classifyColor(r: number, g: number, b: number): string {
  let best = "?";
  let bestDistance = 150;
  for (const [name, [rr, gg, bb]] of QUADRANT_REFERENCES) {
    const distance = Math.hypot(r - rr, g - gg, b - bb);
    if (distance < bestDistance) { best = name; bestDistance = distance; }
  }
  return best;
}

export function quadrantSignature(frame: { data: Buffer; width: number; height: number }): string {
  const points = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const;
  return points.map(([fx, fy]) => {
    const x = Math.min(frame.width - 1, Math.floor(fx * frame.width));
    const y = Math.min(frame.height - 1, Math.floor(fy * frame.height));
    const o = (y * frame.width + x) * 3;
    return classifyColor(frame.data[o]!, frame.data[o + 1]!, frame.data[o + 2]!);
  }).join("");
}

function goertzelMagnitude(samples: Float32Array, start: number, length: number, frequency: number, sampleRate: number, stride: number): number {
  const k = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < length; i++) {
    const s = samples[(start + i) * stride]! + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return (2 / length) * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

export function firstBurstSec(samples: Float32Array, sampleRate: number, channels: number, frequency = 1500, threshold = 0.1): number | null {
  const window = Math.round(sampleRate * 0.01);
  const total = Math.floor(samples.length / channels);
  for (let start = 0; start + window <= total; start += Math.round(window / 2)) {
    if (goertzelMagnitude(samples, start, window, frequency, sampleRate, channels) > threshold) return start / sampleRate;
  }
  return null;
}

async function firstFlashSec(path: string, frames: Array<[number, string]>, timeBase: number): Promise<number | null> {
  const result = await ffmpeg(["-i", path, "-map", "0:v:0", "-vf", "scale=16:9,format=gray", "-f", "rawvideo", "-"]);
  if (result.code !== 0) return null;
  const frameSize = 16 * 9;
  const count = Math.floor(result.stdout.length / frameSize);
  for (let index = 0; index < count && index < frames.length; index++) {
    let sum = 0;
    for (let i = 0; i < frameSize; i++) sum += result.stdout[index * frameSize + i]!;
    if (sum / frameSize >= 200) return frames[index]![0] * timeBase;
  }
  return null;
}

async function circleDisplayAspect(path: string, timeSec: number, sarNumerator: number, sarDenominator: number): Promise<number | null> {
  const frame = await rawFrame(path, timeSec, 108);
  if (!frame) return null;
  let minX = frame.width, minY = frame.height, maxX = -1, maxY = -1;
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const o = (y * frame.width + x) * 3;
    if (frame.data[o]! > 128 && frame.data[o + 1]! > 128 && frame.data[o + 2]! > 128) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  const aspect = ((maxX - minX + 1) / (maxY - minY + 1)) * (sarNumerator / sarDenominator);
  return Math.round(aspect * 1000) / 1000;
}

async function saturatedPixels(path: string, times: number[]): Promise<number> {
  let best = 0;
  for (const timeSec of times) {
    const frame = await rawFrame(path, timeSec, 270);
    if (!frame) continue;
    let count = 0;
    for (let i = 0; i < frame.data.length; i += 3) {
      const r = frame.data[i]!, g = frame.data[i + 1]!, b = frame.data[i + 2]!;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 90) count++;
    }
    best = Math.max(best, count);
  }
  return best;
}

function snapshotTimes(target: ClipCompositionPlan["targets"][number], durationSec: number): Array<{ label: string; timeSec: number }> {
  const result: Array<{ label: string; timeSec: number }> = [];
  const limit = Math.max(0, durationSec - 0.05);
  const add = (label: string, time: number) => {
    const timeSec = Math.round(Math.min(limit, Math.max(0, time)) * 1000) / 1000;
    if (!result.some((entry) => Math.abs(entry.timeSec - timeSec) < 0.04)) result.push({ label, timeSec });
  };
  for (const scene of target.scenes) add(`scene-${scene.startSec.toFixed(2)}`, scene.startSec + 0.02);
  const cues = (target.visualLayers as any[]).filter((layer) => layer.kind === "caption");
  const stride = Math.max(1, Math.floor(cues.length / 4));
  for (const cue of cues.filter((_cue, index) => index % stride === 0).slice(0, 4)) add(`cue-${cue.cueIndex}`, (cue.activeRange.startSec + cue.activeRange.endSec) / 2);
  return result.slice(0, 8);
}

async function measureOutput(input: {
  outputPath: string;
  snapshotDir: string;
  target: ClipCompositionPlan["targets"][number];
  plan: ClipCompositionPlan;
  probes: string[];
  expectedQuadrants: string | null;
}): Promise<{ output: NonNullable<TargetRecord["output"]>; measurements: Dict }> {
  const probe = await ffprobeJson(input.outputPath);
  const video = (probe.streams ?? []).find((stream: Dict) => stream.codec_type === "video");
  const audioStream = (probe.streams ?? []).find((stream: Dict) => stream.codec_type === "audio");
  const sizeBytes = (await stat(input.outputPath)).size;
  const measurements: Dict = { "render.ok": true };

  let videoFacts: NonNullable<TargetRecord["output"]>["video"] = null;
  let frames: Array<[number, string]> = [];
  let timeBase = 0;
  if (video) {
    const decoded = await framemd5(input.outputPath);
    frames = decoded.frames;
    timeBase = decoded.timeBase;
    videoFacts = { frameCount: frames.length, timeBase: decoded.timeBaseText, frames, framesSha256: sha256(canonicalJson({ timeBase: decoded.timeBaseText, frames })) };
    const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30;
    const planned = input.plan.editedDurationSec;
    const first = frames[0]?.[0] ?? 0;
    const last = frames[frames.length - 1]?.[0] ?? 0;
    const videoDuration = (last - first) * timeBase + 1 / fps;
    const sarParts = String(video.sample_aspect_ratio ?? "0:1").split(":");
    measurements["output.sar"] = video.sample_aspect_ratio && video.sample_aspect_ratio !== "N/A" ? `${sarParts[0]}:${sarParts[1]}` : "0:1";
    measurements["output.dimensions"] = `${video.width}x${video.height}`;
    measurements["output.pixFmt"] = video.pix_fmt ?? null;
    measurements["output.colorTransfer"] = video.color_transfer ?? "unknown";
    measurements["output.colorPrimaries"] = video.color_primaries ?? "unknown";
    measurements["output.colorSpace"] = video.color_space ?? "unknown";
    measurements["output.colorRange"] = video.color_range ?? "unknown";
    measurements["output.hdrSideData"] = JSON.stringify(video.side_data_list ?? []).match(/mastering|content light/i) !== null;
    measurements["output.rFrameRate"] = video.r_frame_rate ?? null;
    measurements["output.avgFrameRate"] = video.avg_frame_rate ?? null;
    measurements["output.durationDeltaFrames"] = Math.round(Math.abs(videoDuration - planned) * fps * 100) / 100;
    measurements["video.frameCount"] = frames.length;
    measurements["video.frameCountDelta"] = frames.length - Math.round(planned * fps);
  }

  let audioFacts: NonNullable<TargetRecord["output"]>["audio"] = null;
  let pcm: Awaited<ReturnType<typeof decodePcm>> = null;
  if (audioStream) {
    const sampleRate = Number(audioStream.sample_rate);
    const channels = Number(audioStream.channels);
    pcm = await decodePcm(input.outputPath, sampleRate, channels);
    if (pcm) {
      audioFacts = { sampleRate, channels, sampleCount: pcm.sampleCount, pcmSha256: pcm.sha256, chunks: pcm.chunks, samplePeak: Math.round(pcm.samplePeak * 1e6) / 1e6 };
      measurements["audio.samplePeak"] = audioFacts.samplePeak;
      if (videoFacts) {
        const fps = parseRate(video.avg_frame_rate) || 30;
        const videoDuration = frames.length / fps;
        measurements["audio.spanDeficitSec"] = Math.round(Math.max(0, videoDuration - pcm.sampleCount / sampleRate) * 1000) / 1000;
      }
    }
  }
  const loud = audioStream ? await loudness(input.outputPath) : null;
  if (loud?.truePeakDbtp !== undefined && loud) measurements["audio.truePeakDbtp"] = loud.truePeakDbtp;

  const decode = await ffmpeg(["-xerror", "-i", input.outputPath, "-f", "null", "-"], 300_000);
  const fullDecode = { ok: decode.code === 0, stderr: decode.stderr.split("\n").filter(Boolean).slice(-3).join("\n") };

  const planned = input.plan.editedDurationSec;
  const times = snapshotTimes(input.target, planned);
  const snapshots: NonNullable<TargetRecord["output"]>["snapshots"] = [];
  await mkdir(input.snapshotDir, { recursive: true });
  for (const { label, timeSec } of times) {
    const file = join(input.snapshotDir, `${label}.png`);
    const shot = await ffmpeg(["-y", "-ss", String(timeSec), "-i", input.outputPath, "-frames:v", "1", file]);
    if (shot.code === 0 && existsSync(file)) snapshots.push({ label, timeSec, file: `snapshots/${label}.png`, sha256: await sha256OfFile(file) });
  }

  if (videoFacts && input.probes.includes("quadrants")) {
    const frame = await rawFrame(input.outputPath, Math.min(0.5, planned / 2), 64);
    measurements["video.quadrants"] = frame ? quadrantSignature(frame) : null;
    if (input.expectedQuadrants) measurements["expected.quadrants"] = input.expectedQuadrants;
  }
  if (videoFacts && input.probes.includes("circle")) {
    const [sn, sd] = String(measurements["output.sar"] ?? "1:1").split(":").map(Number);
    measurements["video.circleDisplayAspect"] = await circleDisplayAspect(input.outputPath, Math.min(1, planned / 2), sn || 1, sd || 1);
  }
  if (videoFacts && input.probes.includes("saturation")) {
    const cueTimes = (input.target.visualLayers as any[]).filter((layer) => layer.kind === "caption").map((cue) => (cue.activeRange.startSec + cue.activeRange.endSec) / 2);
    measurements["video.saturatedPixels"] = await saturatedPixels(input.outputPath, cueTimes.length > 0 ? cueTimes : [planned / 2]);
  }
  if (videoFacts && pcm && input.probes.includes("sync")) {
    const flash = await firstFlashSec(input.outputPath, frames, timeBase);
    const burst = firstBurstSec(pcm.samples, Number(audioStream!.sample_rate), Number(audioStream!.channels));
    const audioStart = Number(audioStream!.start_time) || 0;
    measurements["sync.avOffsetSec"] = flash !== null && burst !== null ? Math.round((burst + audioStart - flash) * 1000) / 1000 : null;
  }
  return {
    output: { sizeBytes, ffprobe: stripVolatile(probe), video: videoFacts, audio: audioFacts, loudness: loud, fullDecode, snapshots },
    measurements,
  };
}

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------

function diagnosticLines(stderr: string): string[] {
  const keep = /(error|warn|invalid|fail|cannot|unable|glyph|fontselect|not found|missing|discard|dropp|too big|non monotonic|past duration|truncat)/i;
  return stderr.split(/\r|\n/).map((line) => line.trim().replace(/0x[0-9a-f]+/gi, "0xADDR")).filter((line) => line && keep.test(line) && !line.startsWith("[libx264") && !/^frame=/.test(line)).slice(0, 40);
}

function failureCode(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

async function startInterruptedServer(filePath: string, failAtFraction: number) {
  const bytes = await readFile(filePath);
  const limit = Math.floor(bytes.length * failAtFraction);
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : bytes.length - 1;
    if (start >= limit) {
      response.writeHead(503).end("unavailable");
      return;
    }
    const headers: Record<string, string | number> = { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": end - start + 1 };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
    response.writeHead(range ? 206 : 200, headers);
    // Deliver up to the failure offset, then close the connection cleanly mid-body.
    response.write(bytes.subarray(start, Math.min(end + 1, limit)), () => setTimeout(() => request.socket.end(), 50));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/source.mp4`, stop: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

export async function runCase(context: CaseContext, id: string): Promise<CaseRecord> {
  const definition = context.inputs.cases[id];
  if (!definition) throw new Error(`unknown case ${id}`);
  const source = context.fixtures.files[definition.source];
  if (!source) throw new Error(`case ${id}: source fixture ${definition.source} was not staged`);
  const caseDir = context.caseDir;
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(join(caseDir, "work"), { recursive: true });
  const record: CaseRecord = {
    id,
    class: definition.class,
    status: "failed",
    failure: null,
    inputs: { source: { fixture: definition.source, sha256: source.sha256 }, assets: {}, documentSha256: sha256(canonicalJson(definition.document)), evidenceSha256: definition.evidence ? sha256(canonicalJson(context.inputs.evidence[definition.evidence])) : null },
    inspection: null,
    targets: [],
    defects: null,
  };
  const normalize = pathNormalizer([[caseDir, "{case}"], [context.fixtures.directory, "{fixtures}"], [context.repoRoot, "{repo}"]]);
  let server: Awaited<ReturnType<typeof startInterruptedServer>> | null = null;
  try {
    let planned: Planned;
    try {
      planned = await planCase(context, id, definition, source.path);
    } catch (error) {
      record.failure = { stage: failureCode(error)?.startsWith("worker_command") || /ffprobe|inspect|moov|Invalid data/i.test(String(error)) ? "inspect" : "plan", code: failureCode(error), message: normalize(String((error as Error).message ?? error)).slice(0, 500) };
      return record;
    }
    record.inspection = planned.inspection as unknown as Dict;
    record.inputs.assets = planned.assets.assetHashes;

    const expectedQuadrants = definition.expected?.quadrantsFrom ? await expectedQuadrantSignature(context.fixtures.files[definition.expected.quadrantsFrom]!.path) : null;
    const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(planned.plan), {
      music: planned.assets.musicPath,
      soundEffects: planned.assets.soundEffects,
    });
    const fonts = await prepareCaptionFontsDirectory(join(caseDir, "work"), new Map(), null);
    let sourceArg = source.path;
    if (definition.transport?.kind === "http") {
      server = await startInterruptedServer(source.path, definition.transport.failAtFraction);
      sourceArg = server.url;
    }

    for (const target of definition.targets) {
      const planTarget = planned.plan.targets.find((candidate) => candidate.id === target.id)!;
      const targetRecord: TargetRecord = {
        targetId: target.id, aspectRatio: target.aspectRatio, resolution: target.resolution ?? "1080p",
        plan: summarizePlan(planned.plan, planTarget),
        captions: { assSha256: null },
        command: { argv: [], argvSha256: "", filterGraph: null, filterGraphSha256: null, argBytes: 0 },
        encode: { exitCode: null, diagnostics: [] },
        output: null,
        measurements: {},
      };
      record.targets.push(targetRecord);

      let captions: CaptionTrack;
      try {
        captions = compileCompositionPlanCaptions(planned.plan, target.id, new Map());
      } catch (error) {
        record.failure = { stage: "compile", code: failureCode(error), message: normalize(String((error as Error).message ?? error)).slice(0, 500) };
        targetRecord.measurements["render.ok"] = false;
        continue;
      }
      const ass = captions.ass;
      let subtitlePath: string | null = null;
      if (ass.length > 0) {
        subtitlePath = join(caseDir, "work", `captions-${target.id}.ass`);
        await writeFile(subtitlePath, ass, "utf8");
        targetRecord.captions.assSha256 = sha256(ass);
      }
      const outputPath = join(caseDir, `${target.id}.mp4`);
      let argv: string[];
      const compile = (mixPeakCeiling: number | null) => compileClipCompositionCommand({
        sourcePath: sourceArg,
        outputPath,
        startSec: planned.document.clipStartSec,
        endSec: planned.document.clipEndSec,
        source: planned.inspection,
        plan: planned.plan,
        targetId: target.id,
        audio,
        encoder: context.inputs.manifest.encoder,
        cutPlan: planned.cutPlan,
        ...(mixPeakCeiling === null ? {} : { mixPeakCeiling }),
        assets: { subtitlePath, logo: planned.assets.logo as any, background: planned.assets.background as any, broll: planned.assets.broll, hdr: planned.assets.hdr, scenes: planned.assets.scenes, fonts: {}, captionFontsDirectory: fonts, captionEmoji: captions.emoji },
      });
      try {
        argv = compile(null);
      } catch (error) {
        record.failure = { stage: "compile", code: failureCode(error), message: normalize(String((error as Error).message ?? error)).slice(0, 500) };
        targetRecord.measurements["render.ok"] = false;
        continue;
      }
      const normalized = argv.map(normalize);
      const graph = graphOf(normalized);
      targetRecord.command = { argv: normalized, argvSha256: sha256(canonicalJson(normalized)), filterGraph: graph, filterGraphSha256: graph === null ? null : sha256(graph), argBytes: argv.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0) };

      const run = await runProcess("ffmpeg", argv, { timeoutMs: 600_000 });
      targetRecord.encode = { exitCode: run.code, diagnostics: diagnosticLines(run.stderr).map(normalize) };
      // The worker fails the variant when libass proves a glyph unrenderable, even though ffmpeg exits zero.
      const glyphFailure = run.code === 0 ? captionRenderDiagnosticsFailure(classifyCaptionRenderDiagnostics(run.stderr.split(/\r?\n|\r/).filter((line) => CAPTION_RENDER_DIAGNOSTIC_PATTERN.test(line)))) : null;
      if (glyphFailure) {
        targetRecord.measurements["render.ok"] = false;
        record.failure ??= { stage: "encode", code: glyphFailure.code, message: normalize(glyphFailure.message).slice(0, 500) };
        continue;
      }
      const produced = run.code === 0 && existsSync(outputPath) && (await stat(outputPath)).size > 0;
      if (!produced) {
        targetRecord.measurements["render.ok"] = false;
        targetRecord.measurements["render.exitCode"] = run.code;
        record.failure ??= { stage: "encode", code: null, message: normalize(run.stderr.split("\n").filter(Boolean).slice(-3).join(" | ")).slice(0, 500) };
        continue;
      }
      // The same guard the worker runs before upload: decode once, and re-encode
      // with the limiter only when the mix is above full scale.
      try {
        const peak = await guardMixPeak({
          audio,
          outputPath,
          limitedArgs: (ceiling) => compile(ceiling),
          measureStdout: async (args) => {
            const measure = await runProcess("ffmpeg", args, { timeoutMs: mixPeakMeasureDeadlineMs(planned.plan.editedDurationSec) });
            if (measure.code !== 0) throw new Error(`mix peak measurement failed: ${measure.stderr.slice(-300)}`);
            return measure.stdout.toString("utf8");
          },
          execute: async (args) => {
            const corrective = await runProcess("ffmpeg", args, { timeoutMs: 600_000 });
            if (corrective.code !== 0) throw new Error(`corrective encode failed: ${corrective.stderr.slice(-300)}`);
          },
        });
        if (peak) targetRecord.encode.mixPeak = peak as unknown as Dict;
      } catch (error) {
        targetRecord.measurements["render.ok"] = false;
        record.failure ??= { stage: "encode", code: error instanceof MixPeakError ? error.code : "mix_peak_failed", message: normalize(String((error as Error).message ?? error)).slice(0, 500) };
        continue;
      }
      try {
        const measured = await measureOutput({ outputPath, snapshotDir: join(caseDir, "snapshots"), target: planTarget, plan: planned.plan, probes: definition.probes ?? [], expectedQuadrants });
        targetRecord.output = measured.output;
        // What the burned captions had to leave out (recorded on the worker's render result, `fallbackCode`).
        targetRecord.measurements = { ...measured.measurements, "render.exitCode": 0, "captions.glyphsOmitted": captions.omitted.length, "captions.emojiSkipped": captions.emojiSkipped.length };
      } catch (error) {
        targetRecord.measurements["render.ok"] = false;
        record.failure ??= { stage: "encode", code: "measurement_failed", message: normalize(String((error as Error).message ?? error)).slice(0, 500) };
      }
    }
    record.status = record.targets.length > 0 && record.targets.every((entry) => entry.output) && !record.failure ? "rendered" : "failed";
    return record;
  } finally {
    server?.stop();
    if (record.failure) record.targets.forEach((entry) => { entry.measurements.typedFailure = record.failure?.code ?? null; });
    await writeFile(join(caseDir, "record.json"), JSON.stringify(record, null, 2) + "\n");
  }
}

async function expectedQuadrantSignature(fixturePath: string): Promise<string | null> {
  // FFmpeg's own autorotation defines the displayed picture; the signature of that picture is the ground truth.
  const frame = await rawFrame(fixturePath, 0.5, 64);
  return frame ? quadrantSignature(frame) : null;
}

// ---------------------------------------------------------------------------
// Assertions and known defects
// ---------------------------------------------------------------------------

export function evaluateAssertion(assertion: Assertion, measurements: Dict): { pass: boolean; actual: unknown } {
  const actual = measurements[assertion.metric];
  const expected = typeof assertion.value === "object" && assertion.value !== null && "ref" in (assertion.value as Dict) ? measurements[(assertion.value as Dict).ref] : assertion.value;
  if (actual === undefined || actual === null) return { pass: false, actual: actual ?? null };
  switch (assertion.op) {
    case "eq": return { pass: actual === expected, actual };
    case "ne": return { pass: actual !== expected, actual };
    case "lte": return { pass: typeof actual === "number" && actual <= (expected as number), actual };
    case "gte": return { pass: typeof actual === "number" && actual >= (expected as number), actual };
    case "absLte": return { pass: typeof actual === "number" && Math.abs(actual) <= (expected as number), actual };
    case "between": { const [lo, hi] = expected as [number, number]; return { pass: typeof actual === "number" && actual >= lo && actual <= hi, actual }; }
    case "in": return { pass: (expected as unknown[]).includes(actual), actual };
  }
}

function evaluateDefects(inputs: Inputs, record: CaseRecord): CaseRecord["defects"] {
  if (record.class !== "known-defect") return null;
  const activation = activationFor(inputs, record.id);
  const contract = activation?.contract ?? inputs.knownDefects[record.id]?.contract;
  if (!contract) throw new Error(`known-defect case ${record.id} has no contract in known-defects.json`);
  const results: NonNullable<CaseRecord["defects"]>["results"] = [];
  for (const target of record.targets) {
    for (const assertion of contract) results.push({ targetId: target.targetId, assertionId: assertion.id, ...evaluateAssertion(assertion, target.measurements) });
  }
  if (record.targets.length === 0) for (const assertion of contract) results.push({ targetId: "-", assertionId: assertion.id, pass: false, actual: null });
  return { evaluated: activation ? `activated:${activation.ticket}` : "expected-failure", results };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function firstDifference(a: unknown[], b: unknown[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) if (canonicalJson(a[i]) !== canonicalJson(b[i])) return i;
  return -1;
}

function clip(text: string, width = 160): string {
  return text.length > width ? `${text.slice(0, width)}...` : text;
}

export function compareTarget(caseId: string, base: TargetRecord, cand: TargetRecord, retain: string[] | null = null): Mismatch[] {
  const out: Mismatch[] = [];
  const add = (category: string, detail: string) => out.push({ case: caseId, target: base.targetId, category, detail });
  const wants = (category: string) => retain === null || retain.includes(category);

  if (wants("plan") && base.plan.sha256 !== cand.plan.sha256) add("plan", `plan fingerprint ${base.plan.fingerprint} -> ${cand.plan.fingerprint}`);
  if (wants("crop") && canonicalJson(base.plan.crops) !== canonicalJson(cand.plan.crops)) {
    const index = firstDifference(base.plan.crops, cand.plan.crops);
    add("crop", `crop rectangle ${index} differs: ${clip(canonicalJson(base.plan.crops[index]))} -> ${clip(canonicalJson(cand.plan.crops[index]))}`);
  }
  if (wants("cue") && canonicalJson(base.plan.cues) !== canonicalJson(cand.plan.cues)) {
    const index = firstDifference(base.plan.cues, cand.plan.cues);
    add("cue", `caption cue ${index} differs (${base.plan.cues.length} -> ${cand.plan.cues.length} cues): ${clip(canonicalJson(base.plan.cues[index]))} -> ${clip(canonicalJson(cand.plan.cues[index]))}`);
  }
  if (wants("layer") && canonicalJson(base.plan.layers) !== canonicalJson(cand.plan.layers)) {
    const index = firstDifference(base.plan.layers, cand.plan.layers);
    add("layer", `visual layer ${index} differs: ${clip(canonicalJson(base.plan.layers[index]))} -> ${clip(canonicalJson(cand.plan.layers[index]))}`);
  }
  if (wants("plan") && canonicalJson(base.plan.scenes) !== canonicalJson(cand.plan.scenes)) add("layer", "scene list differs");
  if (wants("captions") && base.captions.assSha256 !== cand.captions.assSha256) add("captions", `ASS file ${base.captions.assSha256?.slice(0, 12)} -> ${cand.captions.assSha256?.slice(0, 12)}`);
  if (wants("argv") && base.command.argvSha256 !== cand.command.argvSha256) {
    const index = firstDifference(base.command.argv, cand.command.argv);
    add("argv", `ffmpeg argument ${index} differs: ${clip(String(base.command.argv[index]))} -> ${clip(String(cand.command.argv[index]))}`);
  }
  if (wants("argv") && base.command.filterGraphSha256 !== cand.command.filterGraphSha256) {
    const a = base.command.filterGraph ?? "";
    const b = cand.command.filterGraph ?? "";
    let at = 0;
    while (at < a.length && at < b.length && a[at] === b[at]) at++;
    add("graph", `filtergraph differs at byte ${at}: ...${a.slice(Math.max(0, at - 40), at + 60)} -> ...${b.slice(Math.max(0, at - 40), at + 60)}`);
  }
  // "frames" retains the decoded video frames and PTS alone, for corrections that
  // change the audio track and promise the picture stays bit-identical.
  if (!wants("output") && !wants("frames")) return out;
  const wholeOutput = wants("output");
  if (Boolean(base.output) !== Boolean(cand.output)) {
    add("render", base.output ? "candidate no longer renders this target" : "candidate renders a target the baseline could not");
    return out;
  }
  if (base.output && cand.output) {
    const bv = base.output.video;
    const cv = cand.output.video;
    if (Boolean(bv) !== Boolean(cv)) add("frames", "video stream presence differs");
    else if (bv && cv && bv.framesSha256 !== cv.framesSha256) {
      const index = firstDifference(bv.frames, cv.frames);
      add("frames", bv.frames.length !== cv.frames.length
        ? `frame count ${bv.frames.length} -> ${cv.frames.length} (first difference at frame ${index})`
        : `frame ${index} (pts ${bv.frames[index]?.[0]}) hash ${bv.frames[index]?.[1]} -> ${cv.frames[index]?.[1]}`);
    }
    if (!wholeOutput) return out;
    const ba = base.output.audio;
    const ca = cand.output.audio;
    if (Boolean(ba) !== Boolean(ca)) add("audio", "audio stream presence differs");
    else if (ba && ca && ba.pcmSha256 !== ca.pcmSha256) {
      const index = firstDifference(ba.chunks, ca.chunks);
      add("audio", `PCM differs from ${(Math.max(0, index) * CHUNK_SECONDS).toFixed(2)}s (chunk ${index}); samples ${ba.sampleCount} -> ${ca.sampleCount}; rate ${ba.sampleRate}->${ca.sampleRate}; peak ${ba.samplePeak}->${ca.samplePeak}`);
    }
    if (canonicalJson(gatingProbe(base.output.ffprobe)) !== canonicalJson(gatingProbe(cand.output.ffprobe))) add("ffprobe", "ffprobe stream/format facts differ");
    if (canonicalJson(base.output.loudness) !== canonicalJson(cand.output.loudness)) add("loudness", `loudness ${canonicalJson(base.output.loudness)} -> ${canonicalJson(cand.output.loudness)}`);
    if (base.output.fullDecode.ok !== cand.output.fullDecode.ok) add("decode", `full decode ${base.output.fullDecode.ok} -> ${cand.output.fullDecode.ok}`);
  }
  return out;
}

function failureSignature(record: CaseRecord) {
  return { status: record.status, stage: record.failure?.stage ?? null, code: record.failure?.code ?? null };
}

/** Compare all previously captured inspection fields exactly. New facts are
 * recorded by captures, but never added to or substituted into an old baseline. */
function matchesInspectionBaseline(base: unknown, candidate: unknown): boolean {
  if (Array.isArray(base)) return Array.isArray(candidate) && base.length === candidate.length &&
    base.every((value, index) => matchesInspectionBaseline(value, candidate[index]));
  if (base !== null && typeof base === "object") {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const actual = candidate as Record<string, unknown>;
    return Object.entries(base).every(([key, value]) => Object.hasOwn(actual, key) && matchesInspectionBaseline(value, actual[key]));
  }
  return canonicalJson(base) === canonicalJson(candidate);
}

const SETSAR = ",setsar=1";
const countOf = (text: string, part: string) => text.split(part).length - 1;
const withoutSetsar = (text: string) => text.split(SETSAR).join("");
const neutralFilterIndex = (text: string) => text.replace(/(Parsed_\w+?_)\d+/g, "$1N");

/** The one approved normal-case change: each output declares SAR 1:1. Allows
 * only the appended `,setsar=1` (argv, graph, and the filter instance numbers
 * it shifts in diagnostics) and the SAR/DAR tags becoming 1:1. Frames, PTS,
 * PCM, loudness and decode keep their exact comparison. */
function allowOutputSar(base: CaseRecord, cand: CaseRecord): { base: CaseRecord; cand: CaseRecord; problems: Mismatch[] } {
  const problems: Mismatch[] = [];
  const adjust = (target: TargetRecord, side: "base" | "cand"): TargetRecord => {
    const copy = structuredClone(target);
    const argv = copy.command.argv.map(withoutSetsar);
    copy.command = { ...copy.command, argv, argvSha256: sha256(canonicalJson(argv)), filterGraph: copy.command.filterGraph === null ? null : withoutSetsar(copy.command.filterGraph) };
    copy.command.filterGraphSha256 = copy.command.filterGraph === null ? null : sha256(copy.command.filterGraph);
    copy.encode = { ...copy.encode, diagnostics: copy.encode.diagnostics.map(neutralFilterIndex) } as typeof copy.encode;
    for (const stream of copy.output?.ffprobe.streams ?? []) {
      if (stream.codec_type !== "video") continue;
      if (side === "cand" && (stream.sample_aspect_ratio !== "1:1" || (stream.display_aspect_ratio !== undefined && stream.display_aspect_ratio !== `${stream.width / gcd(stream.width, stream.height)}:${stream.height / gcd(stream.width, stream.height)}`))) {
        problems.push({ case: base.id, target: target.targetId, category: "sar", detail: `output SAR ${stream.sample_aspect_ratio} DAR ${stream.display_aspect_ratio} is not square-pixel` });
      }
      delete stream.sample_aspect_ratio;
      delete stream.display_aspect_ratio;
      // The SAR lives in the SPS VUI, so its tag changes the codec extradata size.
      delete stream.extradata_size;
    }
    return copy;
  };
  base.targets.forEach((target, index) => {
    const candTarget = cand.targets[index];
    if (!candTarget) return;
    const added = countOf(candTarget.command.argv.join("\0"), SETSAR) - countOf(target.command.argv.join("\0"), SETSAR);
    if (added < 0) problems.push({ case: base.id, target: target.targetId, category: "argv", detail: "candidate removed an existing setsar=1" });
  });
  return {
    base: { ...base, targets: base.targets.map((target) => adjust(target, "base")) },
    cand: { ...cand, targets: cand.targets.map((target) => adjust(target, "cand")) },
    problems,
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

const HOST_FONT_DIAGNOSTIC = /fontselect: failed to find any fallback|Glyph 0x\w+ not found|Error opening font/i;

/** The approved glyph-coverage change: the ASS script, the decoded frames and libass's font-selection
 * lines may differ, provided the frames differ only because the script does, and the candidate's
 * libass never asked the host for a font. Plan, argv, PCM, ffprobe, loudness and decode stay exact. */
function allowGlyphCoverage(base: CaseRecord, cand: CaseRecord, mismatches: Mismatch[]): Mismatch[] {
  const out = mismatches.filter((mismatch) => !["captions", "frames", "diagnostics"].includes(mismatch.category));
  for (const mismatch of mismatches) {
    if (mismatch.category !== "frames") continue;
    const scriptChanged = mismatches.some((other) => other.category === "captions" && other.target === mismatch.target);
    if (!scriptChanged) out.push({ ...mismatch, detail: `${mismatch.detail} (the ASS script is unchanged, so this is not the glyph-coverage change)` });
  }
  for (const target of cand.targets) {
    const lines = target.encode.diagnostics.filter((line) => HOST_FONT_DIAGNOSTIC.test(line));
    if (lines.length > 0) out.push({ case: base.id, target: target.targetId, category: "glyph", detail: `libass still asked the host for a font: ${clip(lines[0]!)}` });
  }
  return out;
}

export function compareCase(base: CaseRecord, cand: CaseRecord, retain: string[] | null = null, signatureOnly = false, outputSar = false, glyphCoverage = false): Mismatch[] {
  if (glyphCoverage) return allowGlyphCoverage(base, cand, compareCase(base, cand, retain, signatureOnly, outputSar, false));
  if (outputSar) {
    const allowed = allowOutputSar(base, cand);
    return [...compareCase(allowed.base, allowed.cand, retain, signatureOnly), ...allowed.problems];
  }
  const out: Mismatch[] = [];
  if (signatureOnly) {
    if (canonicalJson(failureSignature(base)) !== canonicalJson(failureSignature(cand))) out.push({ case: base.id, category: "status", detail: `${canonicalJson(failureSignature(base))} -> ${canonicalJson(failureSignature(cand))}` });
    return out;
  }
  if (retain === null) {
    if (canonicalJson(base.inputs) !== canonicalJson(cand.inputs)) out.push({ case: base.id, category: "inputs", detail: `inputs differ: ${clip(canonicalJson(base.inputs))} -> ${clip(canonicalJson(cand.inputs))}` });
    if (!matchesInspectionBaseline(base.inspection, cand.inspection)) out.push({ case: base.id, category: "inspection", detail: `source inspection differs: ${clip(canonicalJson(base.inspection))} -> ${clip(canonicalJson(cand.inspection))}` });
    if (canonicalJson(failureSignature(base)) !== canonicalJson(failureSignature(cand)) || (base.failure?.message ?? "") !== (cand.failure?.message ?? "")) {
      out.push({ case: base.id, category: "status", detail: `${canonicalJson(base.failure)} -> ${canonicalJson(cand.failure)}` });
    }
  }
  if (base.targets.length !== cand.targets.length) {
    out.push({ case: base.id, category: "targets", detail: `${base.targets.length} -> ${cand.targets.length} targets` });
    return out;
  }
  base.targets.forEach((target, index) => {
    out.push(...compareTarget(base.id, target, cand.targets[index]!, retain));
    if (retain === null && canonicalJson(target.encode.diagnostics) !== canonicalJson(cand.targets[index]!.encode.diagnostics)) {
      out.push({ case: base.id, target: target.targetId, category: "diagnostics", detail: `ffmpeg diagnostics differ: ${clip(canonicalJson(target.encode.diagnostics))} -> ${clip(canonicalJson(cand.targets[index]!.encode.diagnostics))}` });
    }
  });
  return out;
}

/** A twin case must be indistinguishable from its twin in everything but its own id. */
export function twinMismatches(inputs: Inputs, cases: Record<string, CaseRecord>): Mismatch[] {
  const out: Mismatch[] = [];
  for (const [id, definition] of Object.entries(inputs.cases)) {
    if (!definition.twinOf || !cases[id] || !cases[definition.twinOf]) continue;
    out.push(...compareCase(cases[definition.twinOf]!, { ...cases[id]!, id: definition.twinOf, inputs: cases[definition.twinOf]!.inputs }).map((mismatch) => ({ ...mismatch, case: id, detail: `differs from twin ${definition.twinOf}: ${mismatch.detail}` })));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capture and verify
// ---------------------------------------------------------------------------

async function gitState(repoRoot: string) {
  const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs: 10_000 });
  const status = await runProcess("git", ["status", "--porcelain", "--", "apps/worker", "packages/composition-plan", "packages/validators", "packages/services", "packages/caption-fonts"], { cwd: repoRoot, timeoutMs: 20_000 });
  return { commit: head.stdout.toString("utf8").trim(), dirtyPaths: status.stdout.toString("utf8").split("\n").filter(Boolean).map((line) => line.trim()) };
}

export interface RunOptions {
  suite: string;
  /** When verifying: fixtures and inputs are checked against it before anything renders. */
  baselineCapture?: CaptureFile;
  out: string;
  cases?: string[];
  cacheDir?: string;
  fixtureDir?: string;
  repoRoot?: string;
  log?: (message: string) => void;
}

export async function runSuite(options: RunOptions): Promise<CaptureFile> {
  const log = options.log ?? (() => {});
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const inputs = loadInputs(options.fixtureDir);
  const fingerprint = await collectRuntimeFingerprint({ repoRoot, lock: loadLock() });
  const toolchainId = fixtureToolchainId(fingerprint);
  const ids = suiteCaseIds(inputs, options.suite, options.cases);
  const needed = new Set<string>();
  for (const id of ids) {
    const definition = inputs.cases[id]!;
    needed.add(definition.source);
    if (definition.expected?.quadrantsFrom) needed.add(definition.expected.quadrantsFrom);
    for (const def of Object.values<Dict>(definition.assets?.visualAssets ?? {})) needed.add(def.fixture);
    for (const key of ["logo", "music", "background"]) if (definition.assets?.[key]) needed.add(definition.assets[key].fixture);
    for (const def of Object.values<Dict>(definition.assets?.sfx ?? {})) needed.add(def.fixture);
  }
  const fixtures = await stageFixtures({ manifest: inputs.manifest, toolchainId, ids: [...needed], cacheDir: options.cacheDir });
  if (options.baselineCapture) await assertInputsUntouched(options.baselineCapture, fixtures);
  await mkdir(options.out, { recursive: true });
  const capture: CaptureFile = {
    schemaVersion: SCHEMA_VERSION,
    kind: "render-golden-capture",
    createdAt: new Date().toISOString(),
    git: await gitState(repoRoot),
    fingerprintId: fingerprintId(fingerprint),
    fingerprint,
    toolchainId,
    inputHashes: inputs.hashes,
    fixtures: Object.fromEntries(Object.entries(fixtures.files).map(([id, file]) => [id, file.sha256])),
    suite: options.suite,
    cases: {},
  };
  const abort = new AbortController();
  for (const id of ids) {
    const startedAt = Date.now();
    const record = await runCase({ inputs, fixtures, caseDir: join(options.out, "cases", id), repoRoot, signal: abort.signal }, id);
    record.defects = evaluateDefects(inputs, record);
    capture.cases[id] = record;
    log(`${record.status === "rendered" ? "ok    " : "FAILED"} ${id} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)${record.failure ? ` ${record.failure.stage}: ${record.failure.code ?? ""} ${record.failure.message.slice(0, 100)}` : ""}`);
  }
  await writeFile(join(options.out, "capture.json"), JSON.stringify(capture, null, 2) + "\n");
  return capture;
}

export interface CaseVerdict {
  id: string;
  class: "normal" | "known-defect";
  verdict: "pass" | "fail" | "xfail" | "xpass" | "guard-pass" | "activated-pass" | "activated-fail";
  mismatches: Mismatch[];
  assertions: Array<{ targetId: string; id: string; pass: boolean; actual: unknown }>;
}

export interface Report {
  kind: "render-golden-report";
  ok: boolean;
  baseline: { commit: string; fingerprintId: string; path: string; createdAt: string };
  candidate: { commit: string; dirtyPaths: string[]; fingerprintId: string };
  suite: string;
  summary: { normal: { total: number; pass: number; fail: number }; knownDefects: { total: number; xfail: number; xpass: number; changed: number; activatedPass: number; activatedFail: number } };
  failures: Mismatch[];
  cases: CaseVerdict[];
}

export function buildReport(input: { inputs: Inputs; baseline: CaptureFile; candidate: CaptureFile; baselinePath: string }): Report {
  const { inputs, baseline, candidate } = input;
  const verdicts: CaseVerdict[] = [];
  const failures: Mismatch[] = [];
  for (const [id, cand] of Object.entries(candidate.cases)) {
    const base = baseline.cases[id];
    const definition = inputs.cases[id]!;
    if (!base) {
      const mismatch = { case: id, category: "baseline", detail: "case is missing from the baseline capture" };
      verdicts.push({ id, class: cand.class, verdict: "fail", mismatches: [mismatch], assertions: [] });
      failures.push(mismatch);
      continue;
    }
    const activation = activationFor(inputs, id);
    const outputSar = allowsOutputSar(inputs, id);
    const glyphCoverage = allowsGlyphCoverage(inputs, id);
    const assertions = (cand.defects?.results ?? []).map((result) => ({ targetId: result.targetId, id: result.assertionId, pass: result.pass, actual: result.actual }));
    let mismatches: Mismatch[];
    let verdict: CaseVerdict["verdict"];
    if (cand.class === "normal") {
      mismatches = compareCase(base, cand, null, false, outputSar, glyphCoverage);
      verdict = mismatches.length === 0 ? "pass" : "fail";
    } else if (activation) {
      mismatches = compareCase(base, cand, activation.retain, false, outputSar, glyphCoverage);
      const failed = assertions.filter((entry) => !entry.pass);
      for (const entry of failed) mismatches.push({ case: id, target: entry.targetId, category: "contract", detail: `corrected contract ${entry.id} not met (actual ${canonicalJson(entry.actual)}) [ticket ${activation.ticket}]` });
      verdict = mismatches.length === 0 ? "activated-pass" : "activated-fail";
    } else {
      mismatches = compareCase(base, cand, null, definition.compare === "signature", outputSar, glyphCoverage);
      const anyFailing = assertions.some((entry) => !entry.pass);
      if (inputs.knownDefects[id]?.expect === "pass") {
        for (const entry of assertions.filter((assertion) => !assertion.pass)) mismatches.push({ case: id, target: entry.targetId, category: "contract", detail: `regression guard ${entry.id} broke (actual ${canonicalJson(entry.actual)}); this fixture is already rendered correctly` });
        verdict = mismatches.length === 0 ? "guard-pass" : "fail";
        verdicts.push({ id, class: cand.class, verdict, mismatches, assertions });
        failures.push(...mismatches);
        continue;
      }
      if (!anyFailing) mismatches.push({ case: id, category: "xpass", detail: `known defect ${inputs.knownDefects[id]?.defect} now meets its whole contract; the owning ticket (${inputs.knownDefects[id]?.owner}) must activate it with an expected/ file instead of leaving it an expected failure` });
      verdict = mismatches.length > 0 ? (anyFailing ? "fail" : "xpass") : "xfail";
    }
    verdicts.push({ id, class: cand.class, verdict, mismatches, assertions });
    failures.push(...mismatches);
  }
  failures.push(...twinMismatches(inputs, candidate.cases));
  const normalVerdicts = verdicts.filter((entry) => entry.class === "normal");
  const defectVerdicts = verdicts.filter((entry) => entry.class === "known-defect");
  const summary = {
    normal: { total: normalVerdicts.length, pass: normalVerdicts.filter((entry) => entry.verdict === "pass").length, fail: normalVerdicts.filter((entry) => entry.verdict === "fail").length },
    knownDefects: {
      total: defectVerdicts.length,
      xfail: defectVerdicts.filter((entry) => entry.verdict === "xfail" || entry.verdict === "guard-pass").length,
      xpass: defectVerdicts.filter((entry) => entry.verdict === "xpass").length,
      changed: defectVerdicts.filter((entry) => entry.verdict === "fail").length,
      activatedPass: defectVerdicts.filter((entry) => entry.verdict === "activated-pass").length,
      activatedFail: defectVerdicts.filter((entry) => entry.verdict === "activated-fail").length,
    },
  };
  return {
    kind: "render-golden-report",
    ok: failures.length === 0,
    baseline: { commit: baseline.git.commit, fingerprintId: baseline.fingerprintId, path: input.baselinePath, createdAt: baseline.createdAt },
    candidate: { commit: candidate.git.commit, dirtyPaths: candidate.git.dirtyPaths, fingerprintId: candidate.fingerprintId },
    suite: candidate.suite,
    summary,
    failures,
    cases: verdicts,
  };
}

export function renderReportMarkdown(report: Report): string {
  const lines = [
    `# Render golden report: ${report.ok ? "PASS" : "FAIL"}`,
    "",
    `- suite: ${report.suite}`,
    `- baseline: ${report.baseline.commit.slice(0, 10)} captured ${report.baseline.createdAt} (${report.baseline.path})`,
    `- candidate: ${report.candidate.commit.slice(0, 10)}${report.candidate.dirtyPaths.length > 0 ? ` with ${report.candidate.dirtyPaths.length} uncommitted path(s)` : ""}`,
    `- fingerprint: ${report.candidate.fingerprintId.slice(0, 16)}`,
    `- normal: ${report.summary.normal.pass}/${report.summary.normal.total} identical, ${report.summary.normal.fail} failing`,
    `- known defects: ${report.summary.knownDefects.xfail} expected failures unchanged, ${report.summary.knownDefects.xpass} unexpectedly passing, ${report.summary.knownDefects.changed} changed behavior, ${report.summary.knownDefects.activatedPass} corrected and passing, ${report.summary.knownDefects.activatedFail} corrected and failing`,
    "",
  ];
  if (report.failures.length > 0) {
    lines.push("## Mismatches", "");
    for (const failure of report.failures) lines.push(`- [${failure.category}] ${failure.case}${failure.target ? `/${failure.target}` : ""}: ${failure.detail}`);
    lines.push("");
  }
  lines.push("## Cases", "");
  for (const entry of report.cases) lines.push(`- ${entry.verdict.padEnd(15)} ${entry.class === "known-defect" ? "(defect) " : ""}${entry.id}${entry.assertions.length ? `  contract: ${entry.assertions.filter((a) => a.pass).length}/${entry.assertions.length} met` : ""}`);
  return lines.join("\n") + "\n";
}

export async function verifySuite(options: RunOptions & { baseline: string }): Promise<{ report: Report; exitCode: number }> {
  const baselineFile = join(options.baseline, "capture.json");
  if (!existsSync(baselineFile)) throw new Error(`no capture.json in ${options.baseline}`);
  const baseline = JSON.parse(await readFile(baselineFile, "utf8")) as CaptureFile;
  if (baseline.schemaVersion !== SCHEMA_VERSION) throw new Error(`baseline schema ${baseline.schemaVersion} is not ${SCHEMA_VERSION}`);
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const fingerprint = await collectRuntimeFingerprint({ repoRoot, lock: loadLock() });
  if (fingerprintId(fingerprint) !== baseline.fingerprintId) {
    const differing = fingerprintDifferences(baseline.fingerprint, fingerprint);
    throw new FingerprintMismatch(`runtime fingerprint differs from the baseline (${differing.join(", ")}); captures from different environments are never compared. Restore the baseline environment or capture a new baseline.`, differing);
  }
  const inputs = loadInputs(options.fixtureDir);
  for (const key of ["documents", "evidence", "knownDefects"] as const) {
    if (inputs.hashes[key] !== baseline.inputHashes[key]) throw new Error(`frozen ${key} changed since the baseline was captured; a baseline is never refreshed to make a candidate pass`);
  }
  const candidate = await runSuite({ ...options, repoRoot, baselineCapture: baseline });
  const scoped: CaptureFile = { ...baseline, cases: Object.fromEntries(Object.entries(baseline.cases).filter(([id]) => id in candidate.cases)) };
  const report = buildReport({ inputs, baseline: scoped, candidate, baselinePath: options.baseline });
  await writeFile(join(options.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(options.out, "report.md"), renderReportMarkdown(report));
  return { report, exitCode: report.ok ? 0 : 1 };
}

export class FingerprintMismatch extends Error {
  constructor(message: string, readonly sections: string[]) {
    super(message);
  }
}

/** Fail before rendering when a fixture, the face model or a vendored font no longer matches the baseline. */
export async function assertInputsUntouched(baseline: CaptureFile, fixtures: StagedFixtures): Promise<void> {
  for (const [id, file] of Object.entries(fixtures.files)) {
    if (baseline.fixtures[id] && baseline.fixtures[id] !== file.sha256) throw new Error(`fixture ${id} was changed since the baseline (${file.sha256} != ${baseline.fixtures[id]})`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const log = (message: string) => console.log(message);
  const only = option(args, "--case")?.split(",").filter(Boolean);
  if (command === "describe") {
    const inputs = loadInputs();
    for (const [name, ids] of Object.entries(inputs.manifest.suites)) {
      console.log(`${name}: ${ids.length} cases`);
      for (const id of ids) console.log(`  ${id.padEnd(34)} ${inputs.cases[id]!.description}`);
    }
    return;
  }
  if (command === "stage") {
    const inputs = loadInputs();
    const fingerprint = await collectRuntimeFingerprint({ repoRoot: REPO_ROOT, lock: loadLock() });
    const toolchainId = fixtureToolchainId(fingerprint);
    const staged = await stageFixtures({ manifest: inputs.manifest, toolchainId, cacheDir: option(args, "--cache"), pin: args.includes("--pin"), rebuild: args.includes("--rebuild") });
    log(`staged ${Object.keys(staged.files).length} fixtures in ${staged.directory} (toolchain ${toolchainId})`);
    return;
  }
  const suite = option(args, "--suite") ?? "all";
  const out = option(args, "--out");
  if (!out) throw new Error(`${command} needs --out DIR`);
  if (command === "capture") {
    const capture = await runSuite({ suite, out: resolve(out), cases: only, cacheDir: option(args, "--cache"), log });
    const failed = Object.values(capture.cases).filter((entry) => entry.status === "failed" && entry.class === "normal");
    log(`captured ${Object.keys(capture.cases).length} cases at ${resolve(out)} (commit ${capture.git.commit.slice(0, 10)}, fingerprint ${capture.fingerprintId.slice(0, 16)})`);
    if (failed.length > 0) {
      log(`normal cases that failed to render: ${failed.map((entry) => entry.id).join(", ")}`);
      process.exit(1);
    }
    return;
  }
  if (command === "verify") {
    const baseline = option(args, "--baseline");
    if (!baseline) throw new Error("verify needs --baseline DIR");
    try {
      const { report, exitCode } = await verifySuite({ suite, out: resolve(out), baseline: resolve(baseline), cases: only, cacheDir: option(args, "--cache"), log });
      log(renderReportMarkdown(report));
      log(`report: ${resolve(out)}/report.json and report.md`);
      process.exit(exitCode);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(error instanceof FingerprintMismatch ? 2 : 1);
    }
  }
  throw new Error("usage: render-golden.ts stage|describe|capture|verify (see the file header)");
}

if (import.meta.main) {
  await main();
}
