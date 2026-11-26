# 11 - Apply to all fills emojis on clips that have none

**What to build:** When the owner applies a caption style with emojis on to all clips, the other
clips get AI emojis too, instead of a switch that is on with nothing drawn. Rules:
[../RULES.md](../RULES.md). Spec D8.

**Blocked by:** [05 - AI tagging](05-ai-tagging.md)

**Status:** done

## Areas

`packages/services` (the apply-caption-preset service), `apps/api` (its route only if the response
shape changes), `packages/api-client` and the Studio's apply action only if needed to surface the
result.

## Deliverables

1. Find the apply service behind `POST .../clips/apply-caption-preset`
   (`packages/validators/src/clip.ts` about 146-149 for the request; the route in
   `apps/api/src/domains/clips` or `studio`). When the applied preset has `emojis: true`, for each
   target clip whose `studioEdits.captionEmojis` is empty, call `suggestClipEmojis` (ticket 05)
   with density `balanced` and write the result in the same document update that writes the preset
   (same revision handling as today). Bounded concurrency; a total time budget that keeps the
   request responsive (state it); a clip whose call fails or runs out of time keeps the preset and
   gets no emojis. The apply itself never fails because of emojis.
2. The response reports how many clips received emojis and how many did not, and the Studio's
   existing success message mentions it only when some did not ("Emojis could not be added to N
   clips. Open a clip and choose Add with AI.").
3. Keep the model calls out of any database transaction.
4. Tests with a stubbed tagger: preset with emojis on fills empty clips and skips clips that have
   emojis; preset with emojis off calls nothing; a failing tagger still applies the preset; the
   time budget stops further calls.

## Acceptance

- [x] Deliverables 1 to 4.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory` (lint, typecheck and test fail only in files outside this ticket; see Evidence).

## Evidence

Implemented 2026-11-26. Nothing committed, migrated or deployed.

### Files

- `packages/services/src/clip-caption-preset-apply.ts` (new): `applyCaptionPresetToProject`: read the
  selection, tag clips without emojis (bounded pool, budget, one retry), then one
  `mutateProjectSelection` with the emojis in the intent.
- `packages/services/src/clip-editor-document-persistence.ts`: `set_caption_preset` project intent
  takes `captionEmojis?: ReadonlyMap<clipId, emojis>`, written by `replaceCaptionEmojis` only when the
  stored map is empty at plan time (every retry re-plans from a fresh read, fenced by the existing
  project revision check); new public `readProjectSelection`; `mutateProjectSelection` returns
  `{ updated, captionEmojisAdded }`.
- `packages/services/src/clip.service.ts`: `clipService.applyCaptionPresetToAll` wires the key, the
  project language and clip titles, execution admission, `suggestClipEmojis` at
  `DEFAULT_CAPTION_EMOJI_DENSITY` (balanced) and `tagCaptionEmojis`.
- `apps/api/src/domains/clips/routes.ts`: the apply route calls the service with the request's abort
  signal; `apply-studio-edits` now returns `{ updated, field }` explicitly so the new result field does
  not leak into it.
- `captions-panel.tsx` (apply handler only): reads `captionEmojis.failed` and adds the description
  "Emojis could not be added to N clips. Open a clip and choose Add with AI." when it is above 0.
- Tests: `clip-caption-preset-apply.test.ts` (new, 8 tests, in-memory store + stub tagger);
  `captionEmojisAdded: 0` added to the result assertions in `clip-editor-document-persistence.test.ts`
  and `.db.test.ts` (db file edited mechanically, not run per the ban); `routes.test.ts` route test.

### Response

`POST /api/projects/:id/clips/apply-caption-preset` returns
`{ updated: number; captionEmojis: { added: number; failed: number } }`. Among clips that had no
emojis when read: `added` got some in the committed update; `failed` could not be tagged (provider
failure after one retry, a 429, no key, closed execution admission, or out of budget). A clip where
the model ran and nothing fits, or one that got emojis from someone else meanwhile, is in neither.

### Budget (measured)

Concurrency 8 clips, budget 20 s from the start of the apply; the tagger sends nothing with under
5 s left, so the last request starts by 15 s. Script:
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/4d7f2a35-ea5a-403a-a561-4917a287a95c/scratchpad/apply-bench/bench.ts`
(real `gpt-6-luna` through `suggestClipEmojis`, in-memory persistence, key from `apps/api/.dev.vars`,
never printed). 60 s clips of about 160 words, English and Urdu alternating:

| Clips | Wall | Per clip p50 / max | Added / failed |
| --- | --- | --- | --- |
| 30 (9 runs before retry) | 6.6-9.4 s | 1.5-1.8 s / 2.0-4.1 s | 28-30 / 0-2 |
| 20 (2 runs before retry) | 4.9-6.8 s | 1.7 s / 2.0-5.5 s | 18-20 / 0-2 |
| 30 (3 runs with retry) | 6.9-8.2 s | 1.6-1.7 s / 2.0-3.1 s | 30 / 0 |

Failures before the retry were not 429s: about one request in 30 to 60 ends `response.failed`
with the model's text starting "We need output..." or completes with non-JSON text. One retry per
failed clip (not after a 429, which `requestTaggingReport` already retried) recovered every case
seen. The same failure rate applies to the import and Studio paths (ticket 05's tagger); reported,
not fixed here.

### Verification

- `bun test packages/services/src/clip-caption-preset-apply.test.ts src/clip-editor-document-persistence.test.ts`: 8 + 56 pass.
- `bun test apps/api/src/domains/clips/routes.test.ts`: 24 pass.
- `bunx biome check` on the 9 touched files: clean. `bun run lint`: 168 errors, all in `.scratch/**`.
- `bun run typecheck`: 17/17 green (one intermediate run failed in `@narriflow/media` caption-emoji
  files while another ticket was mid-edit; green on re-run).
- `bun run test`: first run 16/16 green. Final re-run 15/16: only `@narriflow/media#test` fails
  (`caption-word-order`, caption ASS paint contract, classic preset snapshot, multilingual burn-in,
  libass pill/RTL suites, 146 failures), which is the media caption writer another ticket is changing;
  no services, API, API-client or web failure.
- `bun run --cwd apps/api test:inventory`: 302 routes, 0 problems. `build:worker`: audit passed.
