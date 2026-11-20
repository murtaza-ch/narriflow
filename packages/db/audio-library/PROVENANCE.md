# Audio library provenance

Every file in `manifest.json` came from one of four free sources, fetched on 2026-11-20 by `scripts/audio-library` (`fetch`, then `build`). Per entry, the manifest records `source`, `sourceId`, `sourceUrl`, `license`, `artist`, `attribution` and `retrievedAt`. This file holds the licence proof and the rules that keep the licences true.

Totals: 349 entries, 157 music and 192 SFX, about 669 MB of encoded audio per bucket.

| Source | Kind | Licence | Entries |
| --- | --- | --- | --- |
| Incompetech (Kevin MacLeod) | music | CC BY 4.0 (`cc_by_4`), credit required | 44 |
| FreePD mirror | music | CC0 (`cc0`) | 113 |
| Kenney | SFX | CC0 | 150 |
| BigSoundBank | SFX | CC0 | 42 |

## Incompetech (CC BY 4.0)

- **Licence:** Creative Commons Attribution 4.0 International. Legal code: https://creativecommons.org/licenses/by/4.0/legalcode
- **Terms page:** the Incompetech FAQ, https://incompetech.com/music/royalty-free/faq.html. It gives the credit format below and says the music is free to use but not copyright free.
- **Retrieved:** 2026-11-20. Catalog `https://incompetech.com/music/royalty-free/pieces.json`; files `https://incompetech.com/music/royalty-free/mp3-royaltyfree/<URL-encoded filename field>`.
- **Selection:** 44 creator classics listed in order of fame in `incompetech-classics.json`; the position is the `sortOrder` (1-44). Each carries the `Popular` tag plus moods derived from the site's genre and "feel" words.
- **Credit text**, per track with its real title, stored in `attribution`:
  ```
  "<Title>" Kevin MacLeod (incompetech.com)
  Licensed under Creative Commons: By Attribution 4.0
  https://creativecommons.org/licenses/by/4.0/
  ```
- **Never modified.** The MP3 files are shipped byte for byte: no loudness normalisation, no trimming, no re-encoding. The manifest `sha256` equals the hash of the downloaded file. CC BY 4.0 requires saying so if a file is changed, and an unmodified file keeps the credit accurate. Do not add a processing step for these files.
- **Content ID:** the tracks are registered with YouTube Content ID. A claim is released once the credit is in the video description. UI copy says "Credit required", never "copyright free" or "no claims".

## FreePD (CC0)

- **Licence:** CC0 1.0 Universal Public Domain Dedication. Legal code: https://creativecommons.org/publicdomain/zero/1.0/legalcode
- **Proof:** FreePD's legal page, archived because FreePD closed in 2025: http://web.archive.org/web/20250603065532/https://freepd.com/legal.php. The mirror at https://a.ocv.me/pub/stuff/music/freepd/ carries the site's README ("this music is all licensed CC0 1.0 Universal Public Domain Dedication", with a commercial-use FAQ, including apps that generate movies for users) at https://a.ocv.me/pub/stuff/music/freepd/README.md.
- **Retrieved:** 2026-11-20 from the mirror's folder listings (`<folder>/?ls`) and files. Per-file URLs are in `sourceUrl`.
- **Selection:** 113 tracks from 12 folders (upbeat, comedy, chill, epic, scoring, classical, fantasy, romantic, horror, world, electronic, jazz), chosen by `freepd.json` and recorded in `freepd-selection.json`. Country, rock, misc and unsorted are skipped. Nothing over 15 minutes is used. Folders map to moods in `freepd.json`.
- **Artist:** taken from the mirror's file tags (Kevin MacLeod, Bryan Teoh, Rafael Krux and others). Files with no artist tag use "FreePD". No attribution is required (`attribution` is null).
- **Processing:** loudness-normalised (two-pass `loudnorm`, I=-16 LUFS, TP=-1.5 dBTP), encoded to MP3 192 kbps stereo 44.1 kHz; metadata stripped. Tracks over 6:00 are trimmed to 6:00 with a 3 s fade. None of the selected tracks needed it.

## Kenney (CC0)

- **Licence:** CC0 1.0 Universal, stated in each pack's `License.txt`. The packs were downloaded through the site's download button (`https://kenney.nl/assets/<slug>`); the text of each `License.txt` is kept in the fetch cache and reads, for Interface Sounds:
  > License: (Creative Commons Zero, CC0) http://creativecommons.org/publicdomain/zero/1.0/
  > This content is free to use in personal, educational and commercial projects. Support us by crediting Kenney or www.kenney.nl (this is not mandatory)
  The other packs state the same CC0 licence with the wording "You may use these assets in personal and commercial projects."
- **Retrieved:** 2026-11-20. Packs: `interface-sounds`, `impact-sounds`, `ui-audio`, `digital-audio`, `casino-audio`, `sci-fi-sounds`, `music-jingles`.
- **Selection:** 150 sounds picked by pack and file name in `kenney.json`. Footsteps, mining and engine sounds are left out as game-only. The music jingles were not auditioned; they ship as short stingers under `Success`.
- **Processing:** peak-normalised to -1 dBFS, MP3 128 kbps at 44.1 kHz, mono kept mono.
- **Credit:** not required. `artist` is "Kenney".

## BigSoundBank (CC0)

- **Licence page:** https://bigsoundbank.com/licence.html. It states CC0 1.0 Universal (public domain dedication) for the free sounds, and that sounds marked "Free and royalty-free" are not registered with Content ID. Credit ("Additional sounds: Joseph SARDIN - BigSoundBank.com") is welcome but not mandatory.
- **Per-sound proof:** `fetch` reads each sound's own page and keeps the sound only if it carries the line `CC0 (public domain): Free and royalty-free`; the matched line is stored with the retrieval record. All 43 fetched pages carried it, none were rejected. (One of them, a 4-minute bird bed, was then dropped for length and replaced.)
- **Retrieved:** 2026-11-20, sequentially with a one second pause. The audio is the site's public MP3 file `https://bigsoundbank.com/UPLOAD/mp3/<id>.mp3`, the same size as its MP3 download. The anti-bot download form was not used.
- **Selection:** 42 sounds listed in `bigsoundbank.json` (crowd applause and laughter, camera, keyboard, doorbell and bell notifications, coins, whooshes, doors, heartbeat, clock, rain, birds, city and forest ambience). Sounds that recorded Apple device UI tones were skipped. No free cash-register ring exists on the site, so Cash holds coins and checkout beeps.
- **Processing:** peak-normalised to -1 dBFS, MP3 128 kbps at 44.1 kHz.
- **Credit:** not required. `artist` is "Joseph Sardin".

## Not used

Copying other editors' libraries, chart music, ElevenLabs music, Freesound, Pixabay, YouTube Audio Library and Sonniss, for the reasons in `.scratch/audio-library/spec.md`.

## Keys and rebuilding

Keys are content addressed: `audio-library/<music|sfx>/<first 16 hex of sha256>.mp3`. Changed audio gets a new key and the old row is soft-deleted by `sync-db`; nothing is overwritten or hard-deleted. `bun run audio-library <fetch|build|upload|sync-db> [--dry-run]` reruns every step safely. The fetch cache is `~/.cache/narriflow-audio-library`.
