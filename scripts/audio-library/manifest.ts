import { MAX_SOURCE_MUSIC_SEC, MANIFEST_PATH, MUSIC_TRIM_SEC } from "./config";
import { incompetechAttribution, storageKeyFor } from "./selection";
import { type Manifest, type ManifestEntry, MUSIC_MOODS, SFX_CATEGORIES } from "./types";
import { readJson, writeJson } from "./util";

const SHA256 = /^[0-9a-f]{64}$/;

/** Music by sortOrder then title; SFX by category (chip order) then title. Music first. */
export function sortEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const byTitle = (a: ManifestEntry, b: ManifestEntry) => a.title.localeCompare(b.title, "en", { sensitivity: "base" });
  const category = (entry: ManifestEntry) => SFX_CATEGORIES.indexOf((entry.moods[0] ?? "") as (typeof SFX_CATEGORIES)[number]);
  const music = entries.filter((entry) => entry.kind === "music").sort((a, b) => a.sortOrder - b.sortOrder || byTitle(a, b));
  const sfx = entries.filter((entry) => entry.kind === "sfx").sort((a, b) => category(a) - category(b) || byTitle(a, b));
  return [...music, ...sfx];
}

/** Returns every problem found. An empty list means the manifest is safe to upload and sync. */
export function validateManifest(entries: readonly ManifestEntry[]): string[] {
  const errors: string[] = [];
  const titles = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    const label = `${entry.kind}:${entry.title || "(untitled)"}`;
    if (entry.kind !== "music" && entry.kind !== "sfx") errors.push(`${label}: kind must be music or sfx`);
    if (!entry.title.trim()) errors.push(`${label}: title is empty`);
    const titleKey = `${entry.kind}:${entry.title.trim().toLowerCase()}`;
    if (titles.has(titleKey)) errors.push(`${label}: duplicate title within ${entry.kind}`);
    titles.add(titleKey);

    const vocabulary: readonly string[] = entry.kind === "music" ? MUSIC_MOODS : SFX_CATEGORIES;
    if (entry.moods.length === 0) errors.push(`${label}: needs at least one mood`);
    for (const mood of entry.moods) {
      if (!vocabulary.includes(mood)) errors.push(`${label}: "${mood}" is not an allowed ${entry.kind} mood`);
    }
    if (new Set(entry.moods).size !== entry.moods.length) errors.push(`${label}: repeated mood`);
    if (entry.kind === "sfx" && entry.moods.length !== 1) errors.push(`${label}: an SFX has exactly one category`);

    if (entry.license !== "cc0" && entry.license !== "cc_by_4") errors.push(`${label}: unknown license ${entry.license}`);
    const hasAttribution = typeof entry.attribution === "string" && entry.attribution.trim().length > 0;
    if (entry.license === "cc_by_4" && !hasAttribution) errors.push(`${label}: cc_by_4 requires attribution`);
    if (entry.license === "cc0" && entry.attribution !== null) errors.push(`${label}: cc0 must not carry attribution`);
    if (entry.license === "cc_by_4" && hasAttribution && entry.attribution !== incompetechAttribution(entry.title)) {
      errors.push(`${label}: attribution must be exactly the Incompetech credit for this title (name, licence line, licence URL)`);
    }
    if (!entry.artist.trim()) errors.push(`${label}: artist is empty`);

    if (!Number.isFinite(entry.durationSec) || entry.durationSec <= 0) errors.push(`${label}: durationSec must be > 0`);
    if (entry.kind === "music" && entry.license === "cc0" && entry.durationSec > MUSIC_TRIM_SEC + 0.5) {
      errors.push(`${label}: CC0 music is trimmed to ${MUSIC_TRIM_SEC}s`);
    }
    if (entry.kind === "music" && entry.durationSec > MAX_SOURCE_MUSIC_SEC) errors.push(`${label}: longer than 15 minutes`);

    if (!Number.isInteger(entry.sortOrder) || entry.sortOrder < 1) errors.push(`${label}: sortOrder must be a positive integer`);
    const popular = entry.moods.includes("Popular");
    if (popular && entry.sortOrder > 99) errors.push(`${label}: Popular tracks use sortOrder 1-99`);
    if (!popular && entry.kind === "music" && entry.sortOrder < 100) errors.push(`${label}: sortOrder below 100 is reserved for Popular`);

    if (!SHA256.test(entry.sha256)) errors.push(`${label}: sha256 is not 64 hex characters`);
    else if (entry.storageKey !== storageKeyFor(entry.kind, entry.sha256)) errors.push(`${label}: storageKey does not match sha256`);
    if (keys.has(entry.storageKey)) errors.push(`${label}: duplicate storageKey ${entry.storageKey}`);
    keys.add(entry.storageKey);

    if (!/^https?:\/\//.test(entry.sourceUrl)) errors.push(`${label}: sourceUrl must be an http(s) URL`);
    if (Number.isNaN(Date.parse(entry.retrievedAt))) errors.push(`${label}: retrievedAt is not a date`);
    if (!entry.sourceId.trim()) errors.push(`${label}: sourceId is empty`);
  }
  return errors;
}

export async function readManifest(): Promise<Manifest> {
  const manifest = await readJson<Manifest | null>(MANIFEST_PATH, null);
  if (!manifest) throw new Error(`No manifest at ${MANIFEST_PATH}. Run fetch and build first.`);
  const errors = validateManifest(manifest.entries);
  if (errors.length > 0) throw new Error(`Invalid manifest:\n${errors.slice(0, 20).join("\n")}`);
  return manifest;
}

export async function writeManifest(entries: readonly ManifestEntry[]): Promise<void> {
  const errors = validateManifest(entries);
  if (errors.length > 0) throw new Error(`Refusing to write an invalid manifest:\n${errors.slice(0, 40).join("\n")}`);
  await writeJson(MANIFEST_PATH, { version: 1, entries: sortEntries(entries) } satisfies Manifest);
}
