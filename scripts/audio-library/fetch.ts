import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR, FREEPD_SELECTION_PATH, LIBRARY_DIR, STATE_PATH, cachePath } from "./config";
import {
  BIGSOUNDBANK_ORIGIN,
  type BigSoundBankItem,
  type FreepdConfig,
  type FreepdListing,
  type FreepdPick,
  INCOMPETECH_PIECES_URL,
  type IncompetechPiece,
  bigSoundBankPreviewUrl,
  incompetechFileUrl,
  isBigSoundBankFree,
  selectFreepd,
  selectIncompetech,
} from "./selection";
import {
  FETCH_STATE_VERSION,
  type FetchState,
  download,
  fileSize,
  log,
  politeFetch,
  readJson,
  run,
  utcNow,
  writeJson,
} from "./util";

export async function loadState(): Promise<FetchState> {
  const state = await readJson<FetchState>(STATE_PATH, { version: FETCH_STATE_VERSION, failures: [] });
  state.failures ??= [];
  return state;
}

function fail(state: FetchState, source: string, item: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  state.failures = state.failures.filter((entry) => !(entry.source === source && entry.item === item));
  state.failures.push({ source, item, reason });
  log("fetch_failed", { source, item, reason });
}

function clearFailure(state: FetchState, source: string, item: string): void {
  state.failures = state.failures.filter((entry) => !(entry.source === source && entry.item === item));
}

export async function readCuration<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(LIBRARY_DIR, name), "utf8")) as T;
}

// ------------------------------------------------------------- Incompetech

export async function loadPieces(): Promise<IncompetechPiece[]> {
  return JSON.parse(await readFile(cachePath("incompetech", "pieces.json"), "utf8")) as IncompetechPiece[];
}

async function fetchIncompetech(state: FetchState, dryRun: boolean): Promise<void> {
  const { titles } = await readCuration<{ titles: string[] }>("incompetech-classics.json");
  const piecesPath = cachePath("incompetech", "pieces.json");
  if (!existsSync(piecesPath)) {
    if (dryRun) {
      log("fetch_plan", { source: "incompetech", action: "download pieces.json", url: INCOMPETECH_PIECES_URL });
      return;
    }
    await download(INCOMPETECH_PIECES_URL, piecesPath);
  }
  const { picks, missing } = selectIncompetech(await loadPieces(), titles);
  for (const title of missing) fail(state, "incompetech", title, new Error("title not found in pieces.json"));
  state.incompetech ??= { retrievedAt: utcNow(), piecesUrl: INCOMPETECH_PIECES_URL, files: {} };
  const entry = state.incompetech;
  for (const pick of picks) {
    const url = incompetechFileUrl(pick.filename);
    const path = cachePath("incompetech", "mp3", pick.filename);
    if (entry.files[pick.filename] && (await fileSize(path)) > 0) continue;
    if (dryRun) {
      log("fetch_plan", { source: "incompetech", action: "download", url });
      continue;
    }
    try {
      const { bytes } = await download(url, path);
      entry.files[pick.filename] = { url, bytes, retrievedAt: utcNow() };
      clearFailure(state, "incompetech", pick.filename);
      log("downloaded", { source: "incompetech", file: pick.filename, bytes });
    } catch (error) {
      fail(state, "incompetech", pick.filename, error);
    }
    await writeJson(STATE_PATH, state);
  }
}

// ------------------------------------------------------------------ FreePD

async function fetchFreepd(state: FetchState, dryRun: boolean): Promise<void> {
  const config = await readCuration<FreepdConfig>("freepd.json");
  const { titles } = await readCuration<{ titles: string[] }>("incompetech-classics.json");
  const listings: Record<string, FreepdListing> = {};
  let listingsComplete = true;
  for (const folder of Object.keys(config.folders)) {
    const path = cachePath("freepd", "listings", `${folder}.json`);
    if (!existsSync(path)) {
      if (dryRun) {
        log("fetch_plan", { source: "freepd", action: "list", url: `${config.baseUrl}${folder}/?ls` });
        listingsComplete = false;
        continue;
      }
      try {
        await download(`${config.baseUrl}${folder}/?ls`, path);
      } catch (error) {
        fail(state, "freepd", `${folder}/?ls`, error);
        listingsComplete = false;
        continue;
      }
    }
    listings[folder] = await readJson<FreepdListing>(path, { files: [] });
  }

  // The selection is checked in so reviewers see it, and reused so a changed
  // mirror cannot silently reshuffle the library. Delete the file to reselect.
  let picks: FreepdPick[];
  if (existsSync(FREEPD_SELECTION_PATH)) {
    picks = (await readJson<{ picks: FreepdPick[] }>(FREEPD_SELECTION_PATH, { picks: [] })).picks;
  } else if (!listingsComplete) {
    log("freepd_selection_skipped", { reason: "a folder listing is missing; rerun fetch" });
    return;
  } else {
    picks = selectFreepd(listings, config, new Set(titles));
    if (dryRun) log("fetch_plan", { source: "freepd", action: "write selection", picks: picks.length });
    else await writeJson(FREEPD_SELECTION_PATH, { _README: "Generated by `cli.ts fetch` from freepd.json and the mirror listings. Delete to reselect.", picks });
  }

  state.freepd ??= { retrievedAt: utcNow(), files: {} };
  const entry = state.freepd;
  for (const pick of picks) {
    const id = `${pick.folder}/${decodeURIComponent(pick.href)}`;
    const url = `${config.baseUrl}${pick.folder}/${pick.href}`;
    const path = cachePath("freepd", "files", pick.folder, decodeURIComponent(pick.href));
    if (entry.files[id] && (await fileSize(path)) > 0) continue;
    if (dryRun) {
      log("fetch_plan", { source: "freepd", action: "download", url });
      continue;
    }
    try {
      const { bytes } = await download(url, path);
      entry.files[id] = { url, bytes, retrievedAt: utcNow() };
      clearFailure(state, "freepd", id);
      log("downloaded", { source: "freepd", file: id, bytes });
    } catch (error) {
      fail(state, "freepd", id, error);
    }
    await writeJson(STATE_PATH, state);
  }
}

// ------------------------------------------------------------------ Kenney

const KENNEY_ORIGIN = "https://kenney.nl";

function hexOf(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

/** The download button needs a cookie from a prior page load plus a Referer. */
async function kenneyDownloadUrl(slug: string): Promise<string> {
  const pageUrl = `${KENNEY_ORIGIN}/assets/${slug}`;
  const page = await politeFetch(pageUrl);
  if (!page.ok) throw new Error(`HTTP ${page.status} for ${pageUrl}`);
  await page.arrayBuffer();
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const link = await politeFetch(`${KENNEY_ORIGIN}/download-link/${hexOf(`assets/${slug}`)}`, {
    headers: { Cookie: cookie, Referer: pageUrl, Accept: "application/json" },
  });
  if (!link.ok) throw new Error(`HTTP ${link.status} for the ${slug} download link`);
  const { url } = (await link.json()) as { url?: string };
  if (!url) throw new Error(`No download url for ${slug}`);
  return url;
}

async function fetchKenney(state: FetchState, dryRun: boolean): Promise<void> {
  const { packs } = await readCuration<{ packs: string[] }>("kenney.json");
  state.kenney ??= { packs: {} };
  const entry = state.kenney;
  for (const slug of packs) {
    const zipPath = cachePath("kenney", `${slug}.zip`);
    const dir = cachePath("kenney", slug);
    if (entry.packs[slug] && existsSync(join(dir, "License.txt"))) continue;
    if (dryRun) {
      log("fetch_plan", { source: "kenney", action: "download pack", url: `${KENNEY_ORIGIN}/assets/${slug}` });
      continue;
    }
    try {
      const url = await kenneyDownloadUrl(slug);
      const { bytes } = await download(url, zipPath, { headers: { Referer: `${KENNEY_ORIGIN}/assets/${slug}` } });
      await mkdir(dir, { recursive: true });
      const unzip = await run("unzip", ["-o", "-q", zipPath, "-d", dir]);
      if (unzip.code !== 0) throw new Error(`unzip failed: ${unzip.stderr.trim()}`);
      const licenseText = (await readFile(join(dir, "License.txt"), "utf8")).replace(/\r\n/g, "\n").trim();
      if (!/Creative Commons Zero|CC0/i.test(licenseText)) throw new Error(`${slug} License.txt is not CC0`);
      entry.packs[slug] = { url: `${KENNEY_ORIGIN}/assets/${slug}`, retrievedAt: utcNow(), bytes, licenseText };
      clearFailure(state, "kenney", slug);
      log("downloaded", { source: "kenney", pack: slug, bytes });
    } catch (error) {
      fail(state, "kenney", slug, error);
    }
    await writeJson(STATE_PATH, state);
  }
}

// ------------------------------------------------------------ BigSoundBank

async function fetchBigSoundBank(state: FetchState, dryRun: boolean): Promise<void> {
  const { sounds } = await readCuration<{ sounds: BigSoundBankItem[] }>("bigsoundbank.json");
  state.bigsoundbank ??= { sounds: {}, rejected: {} };
  const entry = state.bigsoundbank;
  for (const sound of sounds) {
    const mp3Path = cachePath("bigsoundbank", "mp3", `${sound.id}.mp3`);
    if (entry.sounds[sound.id] && (await fileSize(mp3Path)) > 0) continue;
    if (entry.rejected[sound.id]) continue;
    const pageUrl = `${BIGSOUNDBANK_ORIGIN}${sound.path}`;
    if (dryRun) {
      log("fetch_plan", { source: "bigsoundbank", action: "verify licence and download", url: pageUrl });
      continue;
    }
    try {
      const page = await politeFetch(pageUrl);
      if (!page.ok) throw new Error(`HTTP ${page.status} for ${pageUrl}`);
      const html = await page.text();
      if (!isBigSoundBankFree(html)) {
        entry.rejected[sound.id] = "detail page does not carry the 'CC0 (public domain): Free and royalty-free' marker";
        log("rejected", { source: "bigsoundbank", id: sound.id, reason: entry.rejected[sound.id] });
        await writeJson(STATE_PATH, state);
        continue;
      }
      const licenseLine = /CC0 \(public domain\):\s*Free and royalty-free/i.exec(html)?.[0] ?? "";
      const fileUrl = bigSoundBankPreviewUrl(sound.id);
      const { bytes } = await download(fileUrl, mp3Path, { headers: { Referer: pageUrl } });
      entry.sounds[sound.id] = { pageUrl, fileUrl, retrievedAt: utcNow(), bytes, licenseLine };
      clearFailure(state, "bigsoundbank", sound.id);
      log("downloaded", { source: "bigsoundbank", id: sound.id, bytes });
    } catch (error) {
      fail(state, "bigsoundbank", sound.id, error);
    }
    await writeJson(STATE_PATH, state);
  }
}

// --------------------------------------------------------------------- run

export async function runFetch(dryRun: boolean): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const state = await loadState();
  state.version = FETCH_STATE_VERSION;
  state.failures = [];
  await fetchIncompetech(state, dryRun);
  await fetchFreepd(state, dryRun);
  await fetchKenney(state, dryRun);
  await fetchBigSoundBank(state, dryRun);
  if (!dryRun) await writeJson(STATE_PATH, state);
  log("fetch_done", {
    dryRun,
    incompetech: Object.keys(state.incompetech?.files ?? {}).length,
    freepd: Object.keys(state.freepd?.files ?? {}).length,
    kenneyPacks: Object.keys(state.kenney?.packs ?? {}).length,
    bigsoundbank: Object.keys(state.bigsoundbank?.sounds ?? {}).length,
    bigsoundbankRejected: Object.keys(state.bigsoundbank?.rejected ?? {}).length,
    failures: state.failures,
  });
  if (state.failures.length > 0) process.exitCode = 1;
}
