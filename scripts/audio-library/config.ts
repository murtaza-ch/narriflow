import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const LIBRARY_DIR = join(REPO_ROOT, "packages/db/audio-library");
export const MANIFEST_PATH = join(LIBRARY_DIR, "manifest.json");
export const FREEPD_SELECTION_PATH = join(LIBRARY_DIR, "freepd-selection.json");

export const CACHE_DIR = join(homedir(), ".cache/narriflow-audio-library");
export const STATE_PATH = join(CACHE_DIR, "fetch-state.json");
export const BUILD_INDEX_PATH = join(CACHE_DIR, "build-index.json");
/** Encoded, content-addressed outputs: objects/<kind>/<sha256-16>.mp3 */
export const OBJECTS_DIR = join(CACHE_DIR, "objects");

/** Descriptive and free of personal data. Requests are sequential and spaced. */
export const USER_AGENT = "Mozilla/5.0 (compatible; NarriflowAudioLibraryIngest/1.0; one-time licensed catalog build)";
export const REQUEST_DELAY_MS = 1000;

export const PUBLIC_BUCKET = "narriflow-library-dev";
export const OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** CC0 music over this is trimmed (3 s fade); over MAX_SOURCE_MUSIC_SEC it is skipped. */
export const MUSIC_TRIM_SEC = 360;
export const MUSIC_FADE_SEC = 3;
export const MAX_SOURCE_MUSIC_SEC = 900;
/** Long ambience beds are not useful as clip SFX. */
export const MAX_SFX_SEC = 150;

export function cachePath(...parts: string[]): string {
  return join(CACHE_DIR, ...parts);
}
