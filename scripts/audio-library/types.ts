export const MUSIC_MOODS = [
  "Popular",
  "Upbeat",
  "Happy",
  "Chill",
  "Funny",
  "Cinematic",
  "Epic",
  "Suspense",
  "Dark",
  "Romantic",
  "Jazz",
  "Electronic",
  "World",
  "Ambient",
] as const;

export const SFX_CATEGORIES = [
  "Whoosh",
  "Impact",
  "Pop",
  "Click",
  "Notification",
  "Success",
  "Fail",
  "Cash",
  "Magic",
  "Sci-fi",
  "Cartoon",
  "Crowd",
  "Ambience",
  "Foley",
] as const;

export type AudioKind = "music" | "sfx";
export type AudioLicense = "cc0" | "cc_by_4";
export type AudioSource = "incompetech" | "freepd" | "kenney" | "bigsoundbank";

export interface ManifestEntry {
  kind: AudioKind;
  title: string;
  artist: string;
  license: AudioLicense;
  /** Exact credit text. Null means no credit is required. */
  attribution: string | null;
  sourceUrl: string;
  source: AudioSource;
  /** Stable id of the file inside its source (filename, folder/filename, pack/path, sound number). */
  sourceId: string;
  moods: string[];
  sortOrder: number;
  durationSec: number;
  sha256: string;
  storageKey: string;
  retrievedAt: string;
}

export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}

/** A selected source file before it is encoded: everything except the fields build computes. */
export interface Candidate {
  kind: AudioKind;
  title: string;
  artist: string;
  license: AudioLicense;
  attribution: string | null;
  sourceUrl: string;
  source: AudioSource;
  sourceId: string;
  moods: string[];
  sortOrder: number;
  /** Absolute path of the cached source file. */
  inputPath: string;
  retrievedAt: string;
  /** Incompetech MP3s are shipped byte for byte. */
  passThrough: boolean;
}

export const DEFAULT_SORT_ORDER = 1000;
