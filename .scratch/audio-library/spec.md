# Curated music and sound-effect library

Owner request (2026-11-20): a Vizard-sized music and sound-effect library that creators recognise. It should load instantly from R2, load more as you scroll, and follow industry practice.

## Settled scope (owner decisions, 2026-11-20)

- **Sources:** free music and sound effects only.
  - Kevin MacLeod creator classics from incompetech.com, licensed CC BY 4.0. A credit is required.
  - FreePD CC0 music, taken once from its mirror. FreePD closed in 2025.
  - Kenney CC0 sound-effect packs.
  - BigSoundBank files that are CC0 or public domain.
- **Not used:**
  - Copying Vizard's library: it is licensed to Vizard.
  - Chart or trending songs: they need label licences.
  - ElevenLabs: its terms forbid a Music Library.
  - Freesound, by owner choice.
  - Pixabay, YouTube Audio Library and Sonniss: their licences forbid redistribution.
- **`narriflow-dev`:** its public r2.dev access stays as it is (owner decision). The library uses its own public bucket.
- **Later:** the catalog shape must allow adding a licensed provider without rework (a `license` value plus attribution text).

## Licensing facts that shape the product

- **Incompetech (CC BY 4.0):**
  - Including tracks in a library is allowed.
  - Files must not be modified without saying so, and no DRM.
  - Each file needs a credit:
    ```
    "<Title>" Kevin MacLeod (incompetech.com)
    Licensed under Creative Commons: By Attribution 4.0
    https://creativecommons.org/licenses/by/4.0/
    ```
  - The tracks are pre-registered with YouTube Content ID. A claim is released once the credit is in the video **description**.
  - We do not loudness-normalise or trim these files, so they stay unmodified and the credit stays accurate.
- **FreePD, Kenney and BigSoundBank (CC0):** no attribution is needed. We keep provenance per file regardless.
- **UI copy:** say "Free to use in your videos". For CC BY tracks, say "Credit required" and give the exact credit line. Never say "copyright free", "monetization-safe" or "no claims".

## Architecture

### Storage and serving

- **Two buckets, same object key:**
  - The private bucket `narriflow-dev` holds the render copy, so the render path is unchanged: freeze `storageKey` and resolve it with `resolveRenderSource`.
  - The public bucket `narriflow-library-dev` (r2.dev `https://pub-2d1f824c186146b8ade40a818acfee53.r2.dev`) holds the preview copy, used in the browser for list preview, the Studio music block preview and the waveform.
  - CORS on the public bucket allows GET and HEAD with `Range` from the web origins (`.scratch/music-timeline/library-cors.json`).
- **Keys** are content-addressed and immutable: `audio-library/<kind>/<sha256-16>.mp3`.
  - Uploads set `Cache-Control: public, max-age=31536000, immutable` and `Content-Type: audio/mpeg`.
  - Changed audio means a new key, never an overwrite.
- **API config:** `AUDIO_LIBRARY_PUBLIC_ORIGIN` holds the origin above.
  - Set it in `apps/api/wrangler.jsonc` `vars` and in `.dev.vars`.
  - It is a plain URL, not a secret.
  - The public URL for a curated row is `${AUDIO_LIBRARY_PUBLIC_ORIGIN}/${storageKey}`.
- **Production:** r2.dev is rate-limited and meant for development. Production must attach a custom domain to the library bucket and set `AUDIO_LIBRARY_PUBLIC_ORIGIN` to it. Document this in `docs/runbooks/environments.md`.

### Data model (one migration)

`AudioAsset` gains these fields. All are nullable or defaulted, and user uploads leave them null.

| Field | Meaning |
| --- | --- |
| `license AudioAssetLicense?` | Enum `cc0`, `cc_by_4`. |
| `artist String?` | |
| `attribution String?` | Exact credit text. Null means no credit is required. |
| `sourceUrl String?` | Provenance. |
| `sortOrder Int @default(1000)` | Curated ordering: lower comes first. Creator classics get the low numbers. |

Add an index on `[kind, sortOrder]`.

### API (`apps/api` brand domain, `packages/services/src/audio-asset.service.ts`, `packages/validators/src/audio-asset.ts`)

- **List rows** gain `previewUrl: string | null`, `artist`, `license`, `attribution`.
  - `previewUrl` is the public URL for curated rows and `null` for user rows. User rows keep the playback-url presign.
- **Ordering:** curated rows sort by `sortOrder ASC, title ASC`, and user rows stay by `createdAt DESC`. Offset paging stays.
- **Facets:** `moodTags` stays as it is.
- **`GET /audio-assets/:id/playback-url`:** for curated rows it returns the public URL with no presign. User rows are unchanged.
- **Caching:** no HTTP caching of the list, because it carries a per-workspace `favorited` flag. The client cache is what makes it instant.
- **Tests:** validators, services (non-DB) and route tests.

### Studio UI (`apps/web` tool-panels, `packages/api-client` brand queries)

- **Data:**
  - Use React Query `useInfiniteQuery` on the existing api-client audio queries, with a page size of 40.
  - Prefetch the first page of music and of SFX (curated, unfiltered) when the Studio opens, so opening the panel shows rows immediately.
  - Use `placeholderData: keepPreviousData` on filter and search changes: no empty flash and no spinner after the first load.
  - Show skeleton rows only on a cold first load.
  - Debounce search by 250 ms.
  - Switching tabs keeps each tab's cache.
- **Infinite scroll:** an IntersectionObserver sentinel near the end of the list fetches the next page, replacing the "Load more" pager. The list fills the panel height instead of the fixed 300–330 px box.
- **Rows,** matching Vizard's layout:
  - A square artwork tile with a play/pause overlay.
  - Title, then `mm:ss` duration.
  - For CC BY rows, the artist plus a small "Credit" hint.
  - Hover actions: Save (favourite) and Use.
  - Artwork is a deterministic gradient generated from the asset id, using a small palette in the Narriflow design language. It needs no network request.
- **Preview:** play `previewUrl` directly, with no API round trip. User rows keep `playback-url`.
- **Chips:**
  - "All" and "Saved", then mood tags in a fixed curated order. Unknown tags go last, alphabetically.
  - Music order: `Popular`, `Upbeat`, `Happy`, `Chill`, `Funny`, `Cinematic`, `Epic`, `Suspense`, `Dark`, `Romantic`, `Jazz`, `Electronic`, `World`, `Ambient`.
  - SFX order: `Whoosh`, `Impact`, `Pop`, `Click`, `Notification`, `Success`, `Fail`, `Cash`, `Magic`, `Sci-fi`, `Cartoon`, `Crowd`, `Ambience`, `Foley`.
- **Credits:**
  - When any music block or SFX placement in the clip uses an asset with `attribution`, the Music panel's block card shows "Credit required" with a Copy credit button.
  - The Studio Export menu shows a "Music credits" note with Copy that joins every credit line.
  - Copy: "Paste this into your video description."
- **CSP:** add the library origin to `media-src`, `connect-src` (the waveform fetch) and `img-src` in `apps/web/next.config.ts`, read from `NEXT_PUBLIC_AUDIO_LIBRARY_ORIGIN`. Add that variable to `.env.local` and the env examples. Vercel needs the variable set before the web deploy.

### Ingest tool (`scripts/audio-library/`)

- **Manifest:** `packages/db/audio-library/manifest.json` replaces the placeholder `packages/db/audio-manifest.json`, which is deleted. It is reviewed in git.
  - Each entry has `kind`, `title`, `artist`, `license`, `attribution`, `sourceUrl`, `source`, `moods[]`, `sortOrder`, `durationSec`, `sha256`, `storageKey` and `retrievedAt`.
  - The license proof (Incompetech FAQ URL, FreePD Wayback legal page, Kenney `License.txt`, BigSoundBank licence URL) goes in `packages/db/audio-library/PROVENANCE.md`.
- **Steps** (Bun TypeScript, each idempotent):
  1. **`fetch`:** download the sources into a local cache outside the repo (`~/.cache/narriflow-audio-library`).
     - Incompetech: `pieces.json`, then `mp3-royaltyfree/<filename>`. Always use the `filename` field and URL-encode it.
     - FreePD mirror: the `<folder>/?ls` JSON listing.
     - Kenney: a signed download link per pack.
     - BigSoundBank: per-sound pages, keeping only files marked free / CC0.
  2. **`build`:** select, encode and hash.
     - CC0 music is loudness-normalised (two-pass `loudnorm` I=-16 LUFS, TP=-1.5 dBTP).
     - CC0 music over 6 min is trimmed to 6:00 with a 3 s fade. Music over 15 min is skipped.
     - Everything is encoded to MP3: 192 kbps stereo 44.1 kHz for music, 128 kbps for SFX.
     - SFX are peak-normalised to -1 dBFS.
     - Incompetech files are passed through unmodified when they are already MP3.
     - Probe the real duration, hash the output, write the key, and update the manifest.
  3. **`upload`:** S3 `PutObject` to both buckets with the cache headers above. Skip keys that already exist (HEAD first).
  4. **`sync-db`:**
     - Upsert curated rows by `storageKey`, with `userId`, `workspaceId` and `createdByUserId` null.
     - Soft-delete (`deletedAt`) curated rows whose key is no longer in the manifest.
     - Never hard-delete, because brand profiles and editor documents reference these ids.
- **Curation targets:**
  - About 45 Incompetech classics, all tagged `Popular` plus their moods, with `sortOrder` 1–99.
  - About 110 FreePD tracks across moods.
  - About 150 Kenney sounds picked by pack and filename (interface, impact, digital, casino coins and cash, sci-fi, UI, music jingles as success and fail stingers).
  - About 40 BigSoundBank sounds (applause, laughter, camera shutter, typing, cash register, ding, whoosh, ambience).
  - Skip game-only sounds (footsteps, RPG sword clanks) unless they fit a creator use.

## Deploy order

1. Apply the migration on the direct URL.
2. Deploy the API (Worker).
3. Run ingest: `fetch`, `build`, `upload`, `sync-db` against the dev resources.
4. Set `NEXT_PUBLIC_AUDIO_LIBRARY_ORIGIN` in Vercel, then push `dev` for the web deploy.

Modal does not change.

## Verification

- Fast gates.
- A live check in the Studio:
  - The list paints from the prefetched cache.
  - Scrolling loads more.
  - Search and chips filter with no flash.
  - Preview plays from r2.dev with no API call.
  - Use, then export, then render, plays the private copy.
  - The credit Copy works.
