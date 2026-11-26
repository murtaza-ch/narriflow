# 18 - Fixes from Sol's re-check

**What to build:** Five defects Sol found when it re-ran its reproductions against the fixed tree.
Three it rates blockers (a wrong emoji on a word, or a lost hand edit). Rules:
[../RULES.md](../RULES.md).

**Blocked by:** [15](15-sol-backend-fixes.md), [16](16-studio-fixes.md)

**Status:** done

## Areas

Studio `emoji/caption-emoji-runs.ts`, `emoji/caption-emoji-words.ts` and their tests;
`packages/services/src/clip.service.ts` (the selection carry-over ticket 15 added) and its tests;
`packages/caption-scene/src/emoji/layer.ts` and its tests. Ticket 17 is editing the shared scene
build (`packages/caption-scene/src/{registry,cues,scene}.ts`), the plan's inserted-scene windows and
the two renderers' scene call sites at the same time: do not touch those.

## Defects

1. **An AI answer lands on a neighbour when its word's line is deleted mid-run** (blocker).
   `caption-emoji-runs.ts` (about line 119): deleting the `party` subtitle line (0.80 s) while the
   request runs makes its party popper land on `hospital` (1.00 s). The merge resolves the answer's
   key against the current words by nearest time, then accepts the neighbour because its own text
   is unchanged. An answer's pick is valid only if the word with that exact key is still visible
   and still has the text it had when the run started (the fingerprint taken at the start holds
   key and text). No nearest-time resolution for AI answers. If the key is gone, drop the pick.
   Tests: line deleted mid-run; word re-timed mid-run (dropped); word unchanged (kept).
2. **Regenerate silently removes a hand edit made during a run** (blocker).
   `caption-emoji-runs.ts` (about line 293): a flame added by hand while a run was pending is kept
   by the merge, but the whole committed map is then saved as the AI baseline, so the next
   Regenerate asks nothing and removes it. The baseline is only the AI picks that were committed;
   hand edits (before, during or after a run) are never part of it. Test the sequence.
3. **A clip made from a selection inherits an emoji onto different text** (blocker).
   `packages/services/src/clip.service.ts` (about line 557, `planCaptionEmojisForClipFromSelection`):
   in the parent, rewrite `hospital` at 1.00 s to `party` and give it a party popper; a clip
   created from that selection uses the project transcript, so it opens with `hospital` carrying
   the party popper. Carry an emoji only when the child's word matches the parent's word in both
   source timing and text (after the same normalisation captions use for comparison; say which).
   Applies to exact-key and clamped matches. Tests: the reproduction; an unedited word still
   carries; a re-timed word does not.
4. **The classic chip of a word split by an inserted scene has no edit target** (should fix).
   `caption-emoji-words.ts` (about line 156): after a scene is inserted inside a cue, the classic
   cue that resumes after the scene shows the split word (`GREAT`) but its chip maps the clipped
   start through `toBaseEdited` to a time 200 ms after the word's onset, outside the 80 ms
   tolerance. Match a continuation by the word's overlapping span (or by the Word Key if the plan's
   words carry it through the slice; check what ticket 15's slices carry). Test with the same
   insert.
5. **A late emoji that is dropped still suppresses an earlier one** (should fix).
   `packages/caption-scene/src/emoji/layer.ts` (about line 256): a rocket at 1.10 s draws alone;
   adding chains at 2.95 s in a cue that ends at 3.00 s moves the chains' planned start back to
   1.10 s (the late-anchor rule), the rocket drops for `no-time`, then the chains drop for
   `no-room`, and nothing draws. An earlier emoji keeps its slot when a later one would displace
   it by falling back to the cue's start; and when a later emoji fails placement, the earlier
   candidate it displaced is placed. Test the reproduction and that ticket 14's "dropped neighbour
   does not cut the earlier one short" test still passes. Re-run the placement tables; drop rates
   must not get worse.

## Acceptance

- [x] Items 1 to 5, each with a test that fails before the fix.
- [x] `bun run typecheck`; tests of `apps/web`, `packages/services`, `packages/caption-scene`;
      `bun run check:web-split`; biome on touched files.

## Evidence

Implemented 2026-11-26, test-first. Each test named "red" below failed before its fix. Nothing committed, migrated or
deployed.

### 1 and 2: the AI run (`studio/_components/emoji/caption-emoji-runs.ts`)

The principle: an AI pick lands only on the word the model tagged, and a hand edit is never AI output.

- **Picks by exact key only.** `planCaptionEmojiAnswer` no longer resolves the answer through
  `resolveCaptionEmojiAnchors`. A pick survives only when `model.byKey.get(key)` exists, that word shows, no other word
  shares the key, and its text equals the fingerprint's text for that key. If the key is gone, the pick is dropped.
  The server returns the saved words' own Word Keys, so an exact key is all a valid pick can have.
- **Baseline = committed AI picks only.** The run stores `committedPicks(plan.picks, committed)` as the clip's
  baseline, not the whole committed map. A hand edit kept by the merge (before, during or after the run) then makes
  `captionEmojisNeedConfirm` true, and Regenerate asks first. `added` is that same set's size.

Tests (`caption-emoji-runs.test.ts`):
- red: "its word's line deleted during the run: the pick is dropped, not moved to the next line's word" (party →
  hospital, the reproduction);
- red: "its word re-timed during the run…" (a rewrite moved `party` after `hospital`, so 0.8 s is nearest to
  `hospital`, whose key and text are unchanged);
- guard: "its word unchanged: the pick is kept on it";
- red: "a hand edit made during a run is kept and is not part of the AI baseline: the next Regenerate asks first"
  (plus the control: picks alone need no confirm);
- changed: the 500-cap test now expects a confirm (its crown was placed by hand). Before this, it asserted the
  defect.
- changed: `caption-emoji-words.test.ts` "picks on words cut since the save are dropped, and so are keys that are not
  a word's own". It used to keep a pick 20 ms off its word's key; that is the nearest-time resolution item 1 removes.

Other paths that broke the principle, found by re-reading the module (all fixed):
- **A hand edit stored a few ms off its word's key** (a re-timed line leaves entries off-key). If it was changed
  during the run, it was kept, but a pick on the same word's exact key was kept too. The plan's resolver gives the word
  to the exact key (distance 0), so the user's emoji disappeared under the AI's. Now a pick never lands on a word any
  kept entry resolves to. Test (red): "a hand edit during the run on the pick's word, stored a few ms off its key,
  keeps the word".
- **Add with AI when emojis already exist.** The section shows Add with AI (no confirm) when the clip has entries but
  none shows, for example all on cut words. The run then replaced them: hidden hand-placed emojis were deleted without
  a prompt, and uncutting the word would not bring them back. The run now takes the mode from the button the user
  pressed (`replace` = some emoji showed at click). Add with AI keeps every entry and only adds picks on free words; a
  partial answer can add, because nothing is lost. Test (red): "Add with AI on a clip whose emojis are all hidden…
  keeps them and adds the picks" (and the result asks before a Regenerate). Guard: "Regenerate (emojis that show)
  replaces them, and keeps those changed during the run".
- **A key two words share** (overlapping speakers starting at the same ms, or a line added at the same time). The
  fingerprint leaves such keys out, and the merge rejects a key that is shared now. The pick cannot say which word it
  means. Test (guard; the old code happened to drop the case with different texts): "a key two words share when
  tagged is dropped…".
- **A word whose text changed and changed back**, or a line deleted and restored by undo during the run: same key and
  same text, so it is the same word and the pick is kept. Test (guard): "…deleted and restored (undo)… the pick is
  kept".
- **The same key reused by a newly added line:** with other text, the text check drops it; with the same text and
  the old word gone, it is indistinguishable from the old word (kept); with both present, the key is shared (dropped).
- **Undo and redo during a run** are document states like any other. Entries: a key whose entry differs between the
  post-save snapshot and now keeps the user's version, and its pick is skipped. Words: the fingerprint check applies.
- **The 500-cap trim:** kept entries (hand edits, and in add mode every existing entry) come first, then the earliest
  picks. Since the baseline holds only picks, a trim that keeps a hand edit is also confirmed before the next
  Regenerate.

### 3: carry-over to a clip made from a selection (`packages/services/src/clip.service.ts`)

`planCaptionEmojisForClipFromSelection(source, target)` carries an entry only to a slice word that has the same text
and the same source timing as the parent's word. Text is compared with `captionWordComparable`, new in
`packages/validators/src/caption-emojis.ts`: NFKC, `toLocaleLowerCase("und")`, then only letters, digits and marks
are kept. The Studio's classic-chip match now uses it too (it used to have its own lower-case, letters-and-digits
helper that also dropped marks). Timing: each word is clamped to the other clip's window, and both start and end must
agree to the millisecond. Each slice clamps a word that crosses its window's edge, so one rule covers exact-key and
clamped matches, and a re-timed word never matches. The signature now takes the windows:

```ts
export function planCaptionEmojisForClipFromSelection(
  source: { clipStartSec: number; clipEndSec: number; transcriptSlice: readonly TranscriptUtterance[]; studioEdits: StudioEdits },
  target: { startSec: number; endSec: number; transcriptSlice: readonly TranscriptUtterance[] },
): Record<string, CaptionEmojiRef>;
export function captionWordComparable(text: string): string; // validators
```

`createClipAtRange` passes `plan` (it already has `startSec`, `endSec`, `transcriptSlice`), and `NewClipLook`'s
`captionEmojisFrom` gains the two clip bounds (the source `EditorDocument` already has them).

Tests (`clip-create-from-selection.test.ts`):
- red: the reproduction, the parent rewrote `hospital` (1.0 s) to `party` with a party popper → nothing carried; the
  reviewer's `selection.ts` printed `{ "1000": party-popper }` before. Also `Hospital!` still carries (case and
  punctuation are not a rewrite).
- red: a word the parent re-timed does not carry. `tonight` moved 1.5 → 1.6 s starts inside the transcript's
  `tonight` (the clamped-span path); `tonight` moved to 2.0 s takes `again`'s key (the exact-key path).
- guard: an unedited word carries.
- adjusted to the new signature: the three ticket-15 tests (outside the slice, off-key entry, clamped parent start).
- `captionWordComparable` tests in validators: case, punctuation and full-width forms are equal; a Hindi vowel sign
  and other words are different.

### 4: classic continuation chip (`caption-emoji-words.ts`)

Classic cue words carry no Word Key (checked: `captionCueSlice` cuts only `scene.keys` and `block.keys`). So
`classicCueWords` also accepts a kept word with the same letters whose edited span contains the mapped start: the part
of a word a scene inserted inside it leaves after the scene. Nearest start still wins, and ties go to the later word
as before. Test (red): "a classic cue split by an inserted scene: the word that resumes after it keeps its target".
It uses the ticket 15 reproduction (Electric, 4 words per cue, 2 s scene at 1.7 s), the real plan and the Studio's
`compositeToBaseEdited`. The resumed `people` chip now targets key 1400 with its flame; before, it was `null`.

### 5: a late emoji never removes an earlier one (`packages/caption-scene/src/emoji/layer.ts`)

`plan()` gives each emoji `waitsFor`: the earlier emojis of its cue it starts less than one placement frame after.
That is a late anchor clamped to the previous start, or two words at once. Such an emoji cuts no window while any of
them may draw. It is tried only once all of them are dropped, and otherwise is dropped `no-time`. This covers both
halves of the item. The earlier emoji keeps its slot. If the earlier one cannot be placed, the later one is tried, and
the previous emoji's window is lengthened only up to it. Pure and deterministic, so Studio and export still match.

Tests (`layer.test.ts`):
- red: "a late emoji that falls back to the cue's start does not displace an earlier one…". The reproduction pair from
  the reviewer's `neighbor.ts` (y = 248: `hundred` fits, `flame` never does) now gives `hundred` [1100, 3000] and
  `flame` `no-time` (before: both dropped). With a late emoji that fits, rocket keeps [1100, 3000].
- red: "an emoji starting within a frame of an earlier one waits for it…". The earlier one keeps the slot; when it
  cannot fit, the later draws [1110, 3000].
- Ticket 14's "an emoji that is not drawn does not cut the one before it short" and the rest of the emoji suite still
  pass (125).

Placement tables (`tools-v2/realtable.ts` extended to fake and HarfBuzz; before = a copy of the pre-change `layer.ts`;
run from `apps/media`). Per-style rows are byte-identical before and after:

| Run | Before | After |
| --- | --- | --- |
| Demo, fake | 4 / 1,221 | 4 / 1,221 |
| Fast, fake | 64 / 3,024 | 64 / 3,024 |
| Demo, HarfBuzz | 5 / 1,221 | 5 / 1,221 |
| Fast, HarfBuzz | 64 / 3,024 | 64 / 3,024 |
| Problems | 0 | 0 |

Those tables place one emoji per cue, which this rule never touches. So a dense variant also ran (an emoji on every
word, fake measure, 84 styles × 3 canvases):
- demo: 4,515 / 4,530 drawn before and after;
- fast: 8,941 → 8,942 drawn;
- cues with no emoji drawn: 3 and 62, unchanged;
- problems: 0.

Scripts: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/4fb60727-0daa-495f-bf0c-7d422c52d2e1/scratchpad/table.ts` and `dense.ts`.

### Files

- `studio/_components/emoji/caption-emoji-runs.ts`, `caption-emoji-runs.test.ts`
- `studio/_components/emoji/caption-emoji-words.ts`, `caption-emoji-words.test.ts`
- `packages/services/src/clip.service.ts`, `clip-create-from-selection.test.ts`
- `packages/caption-scene/src/emoji/layer.ts`, `layer.test.ts`
- Outside the named areas (minimal): `packages/validators/src/caption-emojis.ts` (`captionWordComparable`, the one
  shared normaliser) and `caption-emojis.test.ts`.

### Commands

- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd apps/web test`: 1,362 pass, 0 fail.
- `packages/services`: 1,696 pass, 1,567 skip (PostgreSQL), 0 fail.
- `packages/caption-scene`: 3,132 pass, 0 fail.
- `packages/validators`: 1,349 pass, 0 fail.
- `apps/media` emoji suites (`caption-emoji-ass`, `caption-inserted-scene`, `caption-studio-parity`): 35 pass.
- `bun run check:web-split`: passed. `bunx biome check` on the 10 touched files: clean.
- The reviewer's `state.ts`: wrong target `[]` for the deleted line and the rewrite; "next regen needs confirmation?
  true". `neighbor.ts`'s pair now draws the earlier emoji.
