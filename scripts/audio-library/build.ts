import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  BUILD_INDEX_PATH,
  FREEPD_SELECTION_PATH,
  MAX_SFX_SEC,
  MAX_SOURCE_MUSIC_SEC,
  MUSIC_FADE_SEC,
  MUSIC_TRIM_SEC,
  OBJECTS_DIR,
  cachePath,
} from "./config";
import { loadPieces, loadState, readCuration } from "./fetch";
import { writeManifest } from "./manifest";
import {
  type BigSoundBankItem,
  type FreepdPick,
  INCOMPETECH_ARTIST,
  type KenneyRule,
  incompetechAttribution,
  incompetechFileUrl,
  selectIncompetech,
  selectKenney,
  storageKeyFor,
} from "./selection";
import { type Candidate, DEFAULT_SORT_ORDER, type ManifestEntry } from "./types";
import { fileSize, log, readJson, run, sha256File, writeJson } from "./util";

/** Bump when an encoding rule changes so cached outputs are rebuilt. */
const PIPELINE_VERSION = "1";

interface BuildIndex {
  [candidateKey: string]: { fingerprint: string; sha256: string; durationSec: number; bytes: number };
}
interface Skipped {
  item: string;
  reason: string;
}

// ------------------------------------------------------------- candidates

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else out.push(relative(root, path));
    }
  }
  await walk(root);
  return out;
}

export async function collectCandidates(): Promise<{ candidates: Candidate[]; skipped: Skipped[] }> {
  const state = await loadState();
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  const need = async (path: string, item: string): Promise<boolean> => {
    if ((await fileSize(path)) > 0) return true;
    skipped.push({ item, reason: "source file is not in the cache; run fetch" });
    return false;
  };

  // Incompetech: curated classics, shipped unmodified.
  const { titles } = await readCuration<{ titles: string[] }>("incompetech-classics.json");
  const { picks, missing } = selectIncompetech(await loadPieces(), titles);
  for (const title of missing) skipped.push({ item: `incompetech:${title}`, reason: "not in pieces.json" });
  for (const pick of picks) {
    const inputPath = cachePath("incompetech", "mp3", pick.filename);
    if (!(await need(inputPath, `incompetech:${pick.filename}`))) continue;
    candidates.push({
      kind: "music",
      title: pick.title,
      artist: INCOMPETECH_ARTIST,
      license: "cc_by_4",
      attribution: incompetechAttribution(pick.title),
      sourceUrl: incompetechFileUrl(pick.filename),
      source: "incompetech",
      sourceId: pick.filename,
      moods: pick.moods,
      sortOrder: pick.sortOrder,
      inputPath,
      retrievedAt: state.incompetech?.files[pick.filename]?.retrievedAt ?? state.incompetech?.retrievedAt ?? "",
      passThrough: true,
    });
  }

  // FreePD: CC0, normalised.
  const freepd = await readJson<{ picks: FreepdPick[] }>(FREEPD_SELECTION_PATH, { picks: [] });
  for (const pick of freepd.picks) {
    const file = decodeURIComponent(pick.href);
    const id = `${pick.folder}/${file}`;
    const inputPath = cachePath("freepd", "files", pick.folder, file);
    if (!(await need(inputPath, `freepd:${id}`))) continue;
    const fetched = state.freepd?.files[id];
    candidates.push({
      kind: "music",
      title: pick.title,
      artist: pick.artist,
      license: "cc0",
      attribution: null,
      sourceUrl: fetched?.url ?? "",
      source: "freepd",
      sourceId: id,
      moods: pick.moods,
      sortOrder: DEFAULT_SORT_ORDER,
      inputPath,
      retrievedAt: fetched?.retrievedAt ?? "",
      passThrough: false,
    });
  }

  // Kenney: CC0 packs, selected by file name.
  const kenney = await readCuration<{ packs: string[]; rules: KenneyRule[] }>("kenney.json");
  const filesByPack: Record<string, string[]> = {};
  for (const slug of kenney.packs) {
    const dir = cachePath("kenney", slug);
    if (existsSync(dir)) filesByPack[slug] = await listFiles(dir);
    else skipped.push({ item: `kenney:${slug}`, reason: "pack is not in the cache; run fetch" });
  }
  for (const pick of selectKenney(kenney.rules, filesByPack)) {
    const pack = state.kenney?.packs[pick.pack];
    candidates.push({
      kind: "sfx",
      title: pick.title,
      artist: "Kenney",
      license: "cc0",
      attribution: null,
      sourceUrl: pack?.url ?? `https://kenney.nl/assets/${pick.pack}`,
      source: "kenney",
      sourceId: `${pick.pack}/${pick.path}`,
      moods: [pick.category],
      sortOrder: DEFAULT_SORT_ORDER,
      inputPath: join(cachePath("kenney", pick.pack), pick.path),
      retrievedAt: pack?.retrievedAt ?? "",
      passThrough: false,
    });
  }

  // BigSoundBank: only sounds whose own page carried the free marker at fetch time.
  const { sounds } = await readCuration<{ sounds: BigSoundBankItem[] }>("bigsoundbank.json");
  for (const sound of sounds) {
    const fetched = state.bigsoundbank?.sounds[sound.id];
    if (!fetched) {
      skipped.push({
        item: `bigsoundbank:${sound.id}`,
        reason: state.bigsoundbank?.rejected[sound.id] ?? "not fetched; run fetch",
      });
      continue;
    }
    const inputPath = cachePath("bigsoundbank", "mp3", `${sound.id}.mp3`);
    if (!(await need(inputPath, `bigsoundbank:${sound.id}`))) continue;
    candidates.push({
      kind: "sfx",
      title: sound.title,
      artist: "Joseph Sardin",
      license: "cc0",
      attribution: null,
      sourceUrl: fetched.pageUrl,
      source: "bigsoundbank",
      sourceId: sound.id,
      moods: [sound.category],
      sortOrder: DEFAULT_SORT_ORDER,
      inputPath,
      retrievedAt: fetched.retrievedAt,
      passThrough: false,
    });
  }
  return { candidates, skipped };
}

// --------------------------------------------------------------- encoding

const FFMPEG_BASE = ["-hide_banner", "-nostdin", "-loglevel", "info"];

async function probe(path: string): Promise<{ durationSec: number; channels: number }> {
  const result = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "format=duration:stream=channels",
    "-of", "json",
    path,
  ]);
  if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr.trim().split("\n").pop()}`);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ channels?: number }> };
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("ffprobe reported no duration");
  return { durationSec, channels: parsed.streams?.[0]?.channels ?? 2 };
}

async function ffmpeg(args: string[]): Promise<string> {
  const result = await run("ffmpeg", [...FFMPEG_BASE, ...args]);
  if (result.code !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return result.stderr;
}

/** Two-pass loudnorm, I=-16 LUFS and TP=-1.5 dBTP, 192 kbps stereo 44.1 kHz; over six minutes is cut with a 3 s fade. */
async function encodeMusic(input: string, output: string, sourceSec: number): Promise<void> {
  const trim = sourceSec > MUSIC_TRIM_SEC ? ["-t", String(MUSIC_TRIM_SEC)] : [];
  const target = "I=-16:TP=-1.5:LRA=11";
  const first = await ffmpeg(["-i", input, "-vn", ...trim, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]);
  const block = first.slice(first.lastIndexOf("{"), first.lastIndexOf("}") + 1);
  const measured = JSON.parse(block) as Record<string, string>;
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (!Number.isFinite(Number(measured[key]))) throw new Error(`loudnorm could not measure ${key} (${measured[key]})`);
  }
  const normalise =
    `loudnorm=${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
  const fade = trim.length > 0 ? `,afade=t=out:st=${MUSIC_TRIM_SEC - MUSIC_FADE_SEC}:d=${MUSIC_FADE_SEC}` : "";
  await ffmpeg([
    "-y", "-i", input, "-vn", ...trim,
    "-af", `${normalise}${fade}`,
    "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", "-map_metadata", "-1",
    output,
  ]);
}

/** Peak-normalise to -1 dBFS, 128 kbps MP3 at 44.1 kHz, mono stays mono. */
async function encodeSfx(input: string, output: string, channels: number): Promise<void> {
  const detect = await ffmpeg(["-i", input, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  const peak = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(detect)?.[1];
  if (peak === undefined || !Number.isFinite(Number(peak))) throw new Error("silent or unmeasurable audio");
  const gain = -1 - Number(peak);
  await ffmpeg([
    "-y", "-i", input, "-vn",
    "-af", `volume=${gain.toFixed(3)}dB:precision=float`,
    "-ar", "44100", "-ac", String(channels === 1 ? 1 : 2), "-c:a", "libmp3lame", "-b:a", "128k", "-map_metadata", "-1",
    output,
  ]);
}

async function objectPath(kind: string, sha256: string): Promise<string> {
  const path = join(OBJECTS_DIR, kind, `${sha256.slice(0, 16)}.mp3`);
  await mkdir(join(OBJECTS_DIR, kind), { recursive: true });
  return path;
}

async function processCandidate(
  candidate: Candidate,
  index: BuildIndex,
  tempDir: string,
  serial: number,
): Promise<{ entry: ManifestEntry; bytes: number } | Skipped> {
  const key = `${candidate.source}:${candidate.sourceId}`;
  const inputSha = await sha256File(candidate.inputPath);
  const fingerprint = `${PIPELINE_VERSION}:${inputSha}`;
  const cached = index[key];
  const complete = (sha256: string, durationSec: number, bytes: number) => ({
    bytes,
    entry: {
      kind: candidate.kind,
      title: candidate.title,
      artist: candidate.artist,
      license: candidate.license,
      attribution: candidate.attribution,
      sourceUrl: candidate.sourceUrl,
      source: candidate.source,
      sourceId: candidate.sourceId,
      moods: candidate.moods,
      sortOrder: candidate.sortOrder,
      durationSec,
      sha256,
      storageKey: storageKeyFor(candidate.kind, sha256),
      retrievedAt: candidate.retrievedAt,
    } satisfies ManifestEntry,
  });

  if (cached?.fingerprint === fingerprint && existsSync(await objectPath(candidate.kind, cached.sha256))) {
    return complete(cached.sha256, cached.durationSec, cached.bytes);
  }

  const source = await probe(candidate.inputPath);
  if (candidate.kind === "music" && source.durationSec > MAX_SOURCE_MUSIC_SEC) {
    return { item: key, reason: `longer than 15 minutes (${Math.round(source.durationSec)}s)` };
  }
  if (candidate.kind === "sfx" && source.durationSec > MAX_SFX_SEC) {
    return { item: key, reason: `longer than ${MAX_SFX_SEC}s (${Math.round(source.durationSec)}s)` };
  }

  let produced = candidate.inputPath;
  if (!candidate.passThrough) {
    produced = join(tempDir, `${serial}.mp3`);
    if (candidate.kind === "music") await encodeMusic(candidate.inputPath, produced, source.durationSec);
    else await encodeSfx(candidate.inputPath, produced, source.channels);
  } else if (!/\.mp3$/i.test(candidate.inputPath)) {
    return { item: key, reason: "pass-through source is not an MP3" };
  }

  const sha256 = await sha256File(produced);
  const durationSec = Math.round((await probe(produced)).durationSec * 100) / 100;
  const destination = await objectPath(candidate.kind, sha256);
  if (!existsSync(destination)) {
    if (candidate.passThrough) await copyFile(produced, destination);
    else await rename(produced, destination);
  }
  const bytes = await fileSize(destination);
  index[key] = { fingerprint, sha256, durationSec, bytes };
  return complete(sha256, durationSec, bytes);
}

async function pool<T, R>(items: readonly T[], width: number, work: (item: T, position: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const position = next++;
        results[position] = await work(items[position] as T, position);
      }
    }),
  );
  return results;
}

export function summarise(entries: readonly ManifestEntry[]) {
  const count = (pick: (entry: ManifestEntry) => string[]) => {
    const out: Record<string, number> = {};
    for (const entry of entries) for (const key of pick(entry)) out[key] = (out[key] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    entries: entries.length,
    kind: count((entry) => [entry.kind]),
    source: count((entry) => [entry.source]),
    musicMoods: count((entry) => (entry.kind === "music" ? entry.moods : [])),
    sfxCategories: count((entry) => (entry.kind === "sfx" ? entry.moods : [])),
  };
}

export async function runBuild(dryRun: boolean): Promise<void> {
  const { candidates, skipped } = await collectCandidates();
  if (dryRun) {
    const index = await readJson<BuildIndex>(BUILD_INDEX_PATH, {});
    let cached = 0;
    for (const candidate of candidates) {
      const hit = index[`${candidate.source}:${candidate.sourceId}`];
      if (hit && existsSync(await objectPath(candidate.kind, hit.sha256))) cached++;
    }
    log("build_plan", { candidates: candidates.length, alreadyEncoded: cached, skipped });
    return;
  }

  const index = await readJson<BuildIndex>(BUILD_INDEX_PATH, {});
  const tempDir = join(OBJECTS_DIR, ".tmp");
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const results = await pool(candidates, 4, async (candidate, position) => {
    try {
      const result = await processCandidate(candidate, index, tempDir, position);
      if ("entry" in result) log("built", { source: candidate.source, title: candidate.title });
      return result;
    } catch (error) {
      return { item: `${candidate.source}:${candidate.sourceId}`, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  await rm(tempDir, { recursive: true, force: true });
  await writeJson(BUILD_INDEX_PATH, index);

  const entries: ManifestEntry[] = [];
  const bytesByKey = new Map<string, number>();
  const seenKeys = new Map<string, string>();
  for (const result of results) {
    if (!("entry" in result)) {
      skipped.push(result);
      continue;
    }
    const duplicateOf = seenKeys.get(result.entry.storageKey);
    if (duplicateOf) {
      skipped.push({ item: `${result.entry.source}:${result.entry.sourceId}`, reason: `identical audio to ${duplicateOf}` });
      continue;
    }
    seenKeys.set(result.entry.storageKey, `${result.entry.source}:${result.entry.sourceId}`);
    entries.push(result.entry);
    bytesByKey.set(result.entry.storageKey, result.bytes);
  }

  await writeManifest(entries);
  const totalBytes = [...bytesByKey.values()].reduce((sum, bytes) => sum + bytes, 0);
  log("build_done", { ...summarise(entries), totalMegabytes: Math.round((totalBytes / 1024 / 1024) * 10) / 10, skipped });
}
