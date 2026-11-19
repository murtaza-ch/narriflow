# 06b - Catalog polish from the visual review

**What to build:** The five phase 1 styles separate clearly from each other and match their references more closely, and cues stop ending on a stray function word. From the Opus visual review of the 05b sheets (2026-11-19) with the orchestrator's calls.

**Blocked by:** 06 (done).

**Status:** done

Spec: [../spec.md](../spec.md). Update the spec's section 6 catalog rows and 5.4 to match what ships.

## Changes

1. **Cue breaks, every preset (spec 5.4).** A cue never ends on a minor (closed-class) word when the next token is in the same sentence: that word moves to the start of the next cue. Use the emphasis word lists' minor classification by language (no roles needed). Example: "week of content in / one hour" becomes "week of content / in one hour". Tests in `caption-cues.test.ts` and the plan. Subtitle files follow, as they read the same layers.
2. **Headline.** `rowGapEm` 0.06 → 0.04. Heroes in all caps (every cased letter upper) cap at 3.0 S instead of 3.4 S (a shared geometry rule driven by a style field, e.g. `heroFill.maxEmCaps`).
3. **Stack.** Support words in a light face: vendor Inter Regular (OFL, official Google Fonts / rsms Inter static file, same procedure as the other faces) and use it for Stack's text slot; keep S 64 and the 2.4 S hero. Check with an ink mask that the "i" dot of "captions" does not touch the row above; raise `rowGapEm` to 0.06 if it does.
4. **Marker.** Support words to Inter SemiBold at about 52 px (hero stays Poppins ExtraBold lowercase), so the pair follows section 6 rule 2.
5. **Editorial.** `staggerEm` about 0.6 (rows visibly offset, alternating by seed); minor sans 52 px in white `#FFFFFF`; body serif 68 px; hero unchanged. Check legibility on the bright frame.
6. **Cutout.** Anton instead of Bebas Neue, S about 110 so a 5-word row spans about 80% of the frame (the fit clamp handles long words); pink tiles only for words of 1–2 letters (tile colour by letter count, not by minor role); the `drop` word track compressed to 0–90 ms (rule 6). Re-check the tilt reads at the new size.

7. **Groove.** Support caps read smaller than reference 03: raise support from 64 to about 80 px (keep hero 176 px, check rule 1).
8. **Stack stars.** Smaller and further out than reference 08: sizes 0.36 and 0.26 hero-em, pushed out 0.12 hero-em instead of 0.3, one star overlapping the hero's top-right corner as in 08.

Render contact sheets for all six styles (worker vs Studio, three backgrounds, entrance moments, references) into `scratchpad/06b/` and record final values in the ticket.

Not taken from the review: a karaoke highlight on the spoken word. Dynamic styles already reveal each word as it is spoken, and the classic Karaoke preset exists.

## Acceptance

- [x] Changes 1 to 6 with tests; spec updated; fixtures, snapshots, REST/OpenAPI and docs frames regenerated where values changed.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`, `bun run --cwd apps/api openapi:check` pass. No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: catalog polish landed (changes 1 to 8)

Not committed.

**Change 1, cue breaks (every preset).** `captionWordIsMinor(raw, language)` (`caption-emphasis.ts`) exposes the scorer's own closed-class classification without roles (language lists; without lists, 2 letters or fewer outside no-space scripts). `groupCaptionTokens` takes it as a fourth optional argument: when a cue closes on the budget, its trailing run of minor tokens moves to the start of the next cue. The run stops at a soft break (sentence or clause punctuation, or a pause of 0.35 s or more), never empties the closed cue, and a cue made only of minor words keeps them. The cue that takes the words may hold one word over the budget; past that it closes on the budget as usual and may carry again. Grouping runs per utterance and per dub segment, so nothing crosses those. `captionLayersForTarget` passes it on both paths, so burn-in, Studio and subtitles follow. The classic ASS snapshot uses fixed cues and did not change. Examples (same timings, no pauses):

| wordsPerCue | Before | After |
| --- | --- | --- |
| 3 | she left her / keys in the / car again | she left / her keys / in the car again |
| 4 | the trick is to / start with the hook / and then cut to / the payoff | the trick / is to start / with the hook / and then cut / to the payoff |
| 4 | we went to the / store. And then we / drove to the coast | we went / to the store. / And then we drove / to the coast |
| 3 | Today we build. / It is the / best part of / the week | Today we build. / It is the / best part / of the week |
| 3 (ur) | یہ بات ہم / نے کل کہی / تھی | یہ بات / ہم نے کل کہی / تھی |
| 2 | go to / the store / now | go / to the store / now |

Known limits, by design: an all-minor cue ("It is the") stays as it is, and carrying a run can add a cue (the "trick" line goes from 4 cues to 5). Tests: `caption-cues.test.ts` (carry, runs, the one-word allowance, sentence end, comma, pause before and after the run, all-minor cue, 1-word budget, Urdu, a list-less language), `subtitles.test.ts` (burn-in and subtitles agree; the existing cut test now reads "Hello Today / we build.", start 1.95 s), `caption-override.test.ts` (a minor word that ends a dub segment stays; inside a segment it carries).

**Final values**

| Style | Values | Notes |
| --- | --- | --- |
| Headline | rowGap 0.04; `heroFill.maxEmCaps` 3.0 | Shared geometry rule (`captionTextIsAllCaps`): every cased letter upper and at least one, over the hero words together. Digits-only heroes ("50") and uncased scripts keep 3.4. "BEST" is now 3.0 S (headline-en events 41 → 36, fewer gradient bands). |
| Stack | text slot **Inter Regular** (new face), S 64, hero 2.4 S | i-dot ink check below; rowGap stays 0.04. |
| Marker | text slot Inter SemiBold, S 52, hero Poppins ExtraBold lowercase 120 px (120/52 = 2.31 S); shadow **two black 100% layers (sigma 0.12 em, 0.04 down; sigma 0.05 em, 0.01 down)** | Shadow change below. |
| Editorial | S 68: body Instrument Serif 68 px cream (`primary`), minor Inter SemiBold 52 px literal `#FFFFFF`, **hero 2.2 S (149.6 px)**, stagger 0.6 S (40.8 px), rowGap 0.10 | Hero deviation below. |
| Cutout | Anton (preset `fontName` and style `heroFontName`), **S 105**, `drop` 0–90 ms; tiles `fill #16161A` with text-colour ink, `short: { maxLetters: 2, fill: accent, ink: #16161A }` | Tile shape, pad, radius, gap, tilts unchanged; hard shadow stays 3/84 em (≈3.75 px at 105). |
| Groove | S 80 (support 80 px), hero 176 px = 2.2 S, rowGap 8 px (8/80) | Rule 1 exactly at 2.2. |
| Stack stars | 0.36, 0.26, 0.26 hero-em; push 0.12 hero-em | First star centred on the hero row's top edge, 0.12 out from its leading side (it overlaps the corner, as in 08); if the row above is wider it moves out until it clears that row's box. Others 0.12 out on both axes from the block's other top corner and the bottom corner under it. Odd seeds still mirror the set (rule 9), so "top-right" is top-left on odd seeds. |

**Interpretations and deviations**

- **Editorial hero 2.2 S, not 144 px.** With the body at 68 px, 144 px is 2.12 times the body, under rule 1's 2.2. 149.6 px is the smallest hero that keeps rule 1. A catalog test now checks rule 1 for every hero style.
- **Editorial minor colour** is a literal `#FFFFFF` (a style constant, like Cutout's ink), so Text colour changes the cream body words only.
- **Cutout S 105, not 110.** Measured on `cutout-en` ("AND I KEEP IT SHORT") with Anton: S 100 spans 77% of the frame, 105 spans 81%, 110 spans 85%. The ticket's goal is about 80%. Long words still go through the fit clamp (`cutout-long-word-fit` settles at 57.7 px, above the 40 px floor).
- **Cutout letter count** counts letters and digits (`captionTileWordLength`), so "I", "IT", "50%" are pink; "AND" is now dark. `captionRoleLook` takes the word's text as a fifth argument; Cutout's minor role colour went back to `primary`. The tile `fill` is now one colour plus `short`. Docs text and alt text say so.
- **Marker shadow.** Inter SemiBold is thinner than the Poppins ExtraBold it replaced. On the bright frame, "in" over the white table read 2.44:1 with the small-text pair (rule 5 needs 3:1). Tried: 90% pair 2.64, 100% pair 2.84, 90% wide 0.16 2.65, 90% 0.16 + 100% tight 0.05 2.92, **100% 0.12 + 100% tight 0.05: 3.05** (chosen, the weakest that passes), 100% 0.14/0.16 + tight 0.05 3.08.
- **Inter Regular source.** Google Fonts' own static download for Inter (`fonts.google.com/download/list?family=Inter` → `static/Inter_28pt-Regular.ttf`, served from fonts.gstatic.com `s/inter/v20`). This is the same build as the vendored SemiBold and ExtraBold ("Version 4.001;git-66647c0bb", full name pattern "Inter 28pt …"). That file's own SemiBold has 2926 glyphs against the vendored 2933, so it is a newer packaging of the same version. SHA-256 `3081ede8…aac5e613f`, pinned in `runtime-lock.json`. Full name "Inter 28pt Regular" (family "Inter 28pt", RIBBI naming). Metrics from the file: winAscent 1.1079, winDescent 0.3223, "H" top 0.7275 (UPM 2048), identical to the other Inter faces; `shaping.test.ts` checks them. Licence: the existing `licenses/inter-OFL.txt` (same project and copyright). Registered as "Inter Regular" in `CAPTION_FONT_FACES`, `apps/web/app/caption-fonts.ts` (`--font-caption-inter-regular`) and `CAPTION_FACE_OWN_SCRIPTS` (Cyrillic, Greek; the script-fonts test holds that to the file).
- **Stack "i" dot.** Ink masks (text events only, settled) of the lead row and the hero, rendered separately: at threshold 1 the lowest lead pixel is row 1332 and the highest hero pixel row 1334, so one fully clear pixel row lies between the two bands. In any column both share, at least 4 clear rows. They do not touch, so `rowGapEm` stays 0.04.
- **Groove rule 3**: 8 px at S 80 is 0.10 S, inside 0.04 to 0.20.

**Legibility (bright frame, ring method of ticket 05, worst support word, shipped shadow / none):** stack-en 3.48 / 2.04 (Inter Regular "how"), editorial-en 3.26 / 1.68, marker-en 3.05 (after the change) / 1.33, marker-urdu 3.80 / 1.97, groove-en 3.10 / 1.85, headline-en 3.41 / 1.81, headline-short-words 4.37 / 2.77. Dark and busy only add contrast.

**Parity**

- Studio vs worker layout (parity page metrics vs `captionBlockGeometry`, settled): 0.00 px on baselines, left edges and sizes in all 12 cases (headline-en, headline-short-words, headline-number-unit, headline-urdu, editorial-en, cutout-en, cutout-long-word-fit, marker-en, marker-urdu, stack-en, stack-slam, groove-en). Gradient box, star boxes and the underline wipe clip also 0.00 (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/studio-vs-worker.md`).
- Real libass (`CAPTION_BLOCK_PARITY=1`, 23 pass, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/libass-parity.txt`), max |Δ| px over every case: words baseline 0.23, left 1.39, right 1.56, top 0.64, bottom 0.62; tiles 0.58 / 0.61 / 0.56 / 0.57; decorations 1.05 / 1.18 / 0.98 / 1.24 (Stack's new stars); gradient bands equal the whole word in all 20 hero checks. Cutout with Anton: words ≤ 1.07, tiles ≤ 0.61.
- Events per cue: headline-urdu 83 (max), headline-number-unit 53, headline-short-words 39, headline-en 36, stack 21, cutout 15, marker 15, editorial 12, groove 12. All under 120.

**Contact sheets** (worker | Studio per row, three backgrounds, entrance moments, a second case, the reference): `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/sheet-headline.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/sheet-editorial.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/sheet-cutout.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/sheet-marker.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/sheet-stack.jpg`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/sheet-groove.jpg`. Frames: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/worker/<case>/`, `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/studio/<case>/`. Temporary scripts: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/06b/scripts/`. In every pair the worker and Studio frames agree by eye. Cutout's tilts still read at the larger size.

**Docs.** All six docs frames re-rendered from worker settled frames. Text updated for Editorial (white minor words, offset rows), Cutout (condensed caps, pink tiles for 1 or 2 letters), Marker, Stack (light rows, star layout), and a paragraph on cue breaks under "How the hero is chosen". Spec 5.4, 5.6 rule 3, 5.7 (`drop` 90 ms), 5.8 (`maxEmCaps`, tile `fill`/`short`), the phase 1 catalog rows and the Groove and stars notes updated. REST snapshot and public OpenAPI carry preset ids only and did not change (`openapi:check` matches 32 operations).

**Verification** (Bun 1.4.4, worktree root): `bun run lint` exit 0 (the 20 warnings and 1 info baseline); `bun run typecheck` 15/15; `bun run test` 14/14 (validators 927, composition-plan 144, caption-fonts 141, services 1629, api 984, api-client 232, web 1166, media 1040, mcp-core 170, the rest pass; 0 failures; the one web test that pinned `drop`'s 120 ms halfway pose now samples 45 ms); `bun run check:web-split` passed; `bun run --cwd apps/api openapi:check` matches 32 operations; `CAPTION_BLOCK_PARITY=1 bun test apps/media/src/caption-block-render.test.ts` 23 pass. No PostgreSQL or heavy suites, no `next build`.

