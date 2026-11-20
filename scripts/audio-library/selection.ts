/** Pure selection, mapping and key rules. No I/O: everything here is unit-tested. */
import { type AudioKind, MUSIC_MOODS, SFX_CATEGORIES } from "./types";

// ---------------------------------------------------------------- shared

export function storageKeyFor(kind: AudioKind, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 lowercase hex characters");
  return `audio-library/${kind}/${sha256.slice(0, 16)}.mp3`;
}

/** "00:05:07" -> 307. Returns null for anything else. */
export function parseClockDuration(value: string | null | undefined): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/** Order moods the way the chips are ordered, dropping duplicates. */
export function orderMoods(moods: readonly string[], vocabulary: readonly string[] = MUSIC_MOODS): string[] {
  const seen = new Set(moods);
  const known = vocabulary.filter((mood) => seen.has(mood));
  const unknown = [...seen].filter((mood) => !vocabulary.includes(mood)).sort();
  return [...known, ...unknown];
}

// ------------------------------------------------------------ Incompetech

export const INCOMPETECH_PIECES_URL = "https://incompetech.com/music/royalty-free/pieces.json";
export const INCOMPETECH_FILE_BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/";
export const INCOMPETECH_ARTIST = "Kevin MacLeod";

export interface IncompetechPiece {
  title: string;
  filename: string;
  length: string | null;
  genre: string | null;
  feel: string | null;
}

export function incompetechFileUrl(filename: string): string {
  return `${INCOMPETECH_FILE_BASE}${encodeURIComponent(filename)}`;
}

/** The credit text the spec mandates, with the track's real title. */
export function incompetechAttribution(title: string): string {
  return [
    `"${title}" Kevin MacLeod (incompetech.com)`,
    "Licensed under Creative Commons: By Attribution 4.0",
    "https://creativecommons.org/licenses/by/4.0/",
  ].join("\n");
}

const GENRE_MOODS: Record<string, string[]> = {
  "11": ["Jazz"], // Jazz
  "7": ["Electronic"], // Electronica
  "25": ["World"], // World
  "2": ["World"], // African
  "12": ["World"], // Latin
  "10": ["Dark", "Suspense"], // Horror
};
const CINEMATIC_GENRES = new Set(["22", "4"]); // Soundtrack, Classical
const CINEMATIC_FEELS = new Set(["Epic", "Action", "Intense", "Driving"]);
const FEEL_MOODS: ReadonlyArray<readonly [mood: string, feels: readonly string[]]> = [
  ["Funny", ["Humorous"]],
  ["Epic", ["Epic"]],
  ["Suspense", ["Suspenseful", "Mysterious", "Eerie", "Unnerving"]],
  ["Dark", ["Dark", "Aggressive", "Somber"]],
  ["Chill", ["Calming", "Relaxed"]],
  ["Upbeat", ["Bouncy", "Grooving", "Action", "Driving"]],
  ["Happy", ["Bright", "Uplifting"]],
  ["Ambient", ["Mystical"]],
];
const MAX_DERIVED_MOODS = 4;

/**
 * Maps the site's genre id and "feel" words onto the chip vocabulary. Priority
 * runs genre, then feel in the order above, capped so no track carries a wall
 * of chips. Every curated classic also gets `Popular`.
 */
export function incompetechMoods(feel: string | null, genreId: string | null): string[] {
  const feels = new Set(
    (feel ?? "")
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean),
  );
  const derived: string[] = [...(GENRE_MOODS[genreId ?? ""] ?? [])];
  const cinematic = CINEMATIC_GENRES.has(genreId ?? "") && [...feels].some((word) => CINEMATIC_FEELS.has(word));
  for (const [mood, words] of FEEL_MOODS) {
    if (words.some((word) => feels.has(word))) derived.push(mood);
    if (mood === "Epic" && cinematic) derived.push("Cinematic");
  }
  const unique = [...new Set(derived)].slice(0, MAX_DERIVED_MOODS);
  return orderMoods(["Popular", ...unique]);
}

export interface IncompetechPick {
  title: string;
  filename: string;
  durationSec: number;
  moods: string[];
  sortOrder: number;
}

/** Curated titles are exact, ordered by fame. sortOrder is the 1-based position. */
export function selectIncompetech(
  pieces: readonly IncompetechPiece[],
  titles: readonly string[],
): { picks: IncompetechPick[]; missing: string[] } {
  if (titles.length > 99) throw new Error("Incompetech classics use sortOrder 1-99");
  const byTitle = new Map<string, IncompetechPiece>();
  for (const piece of pieces) if (!byTitle.has(piece.title)) byTitle.set(piece.title, piece);
  const picks: IncompetechPick[] = [];
  const missing: string[] = [];
  titles.forEach((title, index) => {
    const piece = byTitle.get(title);
    if (!piece) {
      missing.push(title);
      return;
    }
    picks.push({
      title: piece.title,
      filename: piece.filename,
      durationSec: parseClockDuration(piece.length) ?? 0,
      moods: incompetechMoods(piece.feel, piece.genre),
      sortOrder: index + 1,
    });
  });
  return { picks, missing };
}

// ----------------------------------------------------------------- FreePD

export interface FreepdListingFile {
  href: string;
  ext: string;
  sz: number;
  tags?: { ".dur"?: number; artist?: string };
}
export interface FreepdListing {
  files: FreepdListingFile[];
}
export interface FreepdFolderRule {
  moods: string[];
  take: number;
}
export interface FreepdConfig {
  baseUrl: string;
  minSec: number;
  maxSec: number;
  /** Closest to this length ranks first: clips want 1.5-4 minute beds. */
  targetSec: number;
  fallbackArtist: string;
  folders: Record<string, FreepdFolderRule>;
}
export interface FreepdPick {
  folder: string;
  /** Percent-encoded name exactly as the mirror lists it. */
  href: string;
  title: string;
  artist: string;
  durationSec: number;
  moods: string[];
}

export function freepdTitle(href: string): string {
  const decoded = decodeURIComponent(href).replace(/\.mp3$/i, "");
  return decoded.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

export function selectFreepd(
  listings: Readonly<Record<string, FreepdListing>>,
  config: FreepdConfig,
  excludeTitles: ReadonlySet<string>,
): FreepdPick[] {
  const taken = new Set([...excludeTitles].map((title) => title.toLowerCase()));
  const picks: FreepdPick[] = [];
  for (const [folder, rule] of Object.entries(config.folders)) {
    const listing = listings[folder];
    if (!listing) continue;
    const ranked = listing.files
      .filter((file) => file.ext.toLowerCase() === "mp3")
      .map((file) => ({ file, duration: file.tags?.[".dur"] ?? 0, title: freepdTitle(file.href) }))
      .filter(({ duration, title }) => duration >= config.minSec && duration <= config.maxSec && title.length > 0)
      .sort(
        (a, b) =>
          Math.abs(a.duration - config.targetSec) - Math.abs(b.duration - config.targetSec) ||
          naturalCompare(a.title, b.title),
      );
    let count = 0;
    for (const { file, duration, title } of ranked) {
      if (count >= rule.take) break;
      if (taken.has(title.toLowerCase())) continue;
      taken.add(title.toLowerCase());
      count++;
      picks.push({
        folder,
        href: file.href,
        title,
        artist: file.tags?.artist?.trim() || config.fallbackArtist,
        durationSec: Math.round(duration * 100) / 100,
        moods: orderMoods(rule.moods),
      });
    }
  }
  return picks;
}

// ----------------------------------------------------------------- Kenney

export interface KenneyRule {
  pack: string;
  /** Matched against the file name without its extension. */
  pattern: string;
  category: (typeof SFX_CATEGORIES)[number];
  /** `{n}` is the first capture as a number, `{n1}` is that plus one. */
  title: string;
  take: number;
}
export interface KenneyPick {
  pack: string;
  /** Path inside the pack's zip. */
  path: string;
  title: string;
  category: string;
}

export function fillTitle(template: string, capture: string | undefined): string {
  const n = capture === undefined ? 0 : Number(capture);
  return template.replace("{n1}", String(n + 1)).replace("{n}", String(n));
}

export function selectKenney(rules: readonly KenneyRule[], filesByPack: Readonly<Record<string, string[]>>): KenneyPick[] {
  const picks: KenneyPick[] = [];
  for (const rule of rules) {
    const files = (filesByPack[rule.pack] ?? [])
      .filter((path) => /\.(ogg|wav|mp3)$/i.test(path) && !/(^|\/)preview\./i.test(path))
      .map((path) => ({ path, name: (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "") }))
      .sort((a, b) => naturalCompare(a.name, b.name));
    const pattern = new RegExp(rule.pattern);
    let count = 0;
    for (const file of files) {
      if (count >= rule.take) break;
      const match = pattern.exec(file.name);
      if (!match) continue;
      count++;
      picks.push({
        pack: rule.pack,
        path: file.path,
        title: fillTitle(rule.title, match[1]),
        category: rule.category,
      });
    }
  }
  return picks;
}

// ---------------------------------------------------------- BigSoundBank

export interface BigSoundBankItem {
  id: string;
  /** Detail page path as the site's search results link it. */
  path: string;
  title: string;
  category: (typeof SFX_CATEGORIES)[number];
}

export const BIGSOUNDBANK_ORIGIN = "https://bigsoundbank.com";
export const BIGSOUNDBANK_LICENCE_URL = "https://bigsoundbank.com/licence.html";

/** A detail page only counts when it explicitly marks the sound free. */
export function isBigSoundBankFree(html: string): boolean {
  return /CC0 \(public domain\):\s*Free and royalty-free/i.test(html);
}

export function bigSoundBankPreviewUrl(id: string): string {
  return `${BIGSOUNDBANK_ORIGIN}/UPLOAD/mp3/${id}.mp3`;
}
