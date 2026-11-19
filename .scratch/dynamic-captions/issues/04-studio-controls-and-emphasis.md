# 04 - Studio controls and emphasis

**What to build:** The Captions panel exposes the dynamic controls and the Emphasis row (spec section 7).

**Blocked by:** 03c

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] Customize tab layout per section 7 (main controls, Advanced, hidden controls).
- [x] Emphasis row: tap, Join next, No emphasis, Auto; `setCaptionEmphasis` in `editorActionSchema`, reducer, undo, contract test; `studioEdits.captionEmphasis` in `studioEditsEqual`.
- [x] Drag semantics for centre and left styles; brand colour mapping for dynamic presets.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: Studio controls and emphasis landed

Not committed. A ticket 05 agent started editing the catalog (`caption-preset.ts`, `caption-dynamic.ts`, `caption-style.ts`, the plan, `caption-sample-cue.ts`) in this worktree while this ran; none of those edits are mine except one function appended to `caption-dynamic.ts`.

**What changed**

- `packages/validators`: `setCaptionEmphasis` (`keys`: 1 to 2,000 Word Keys, `value`: `"hero" | "pair" | "plain" | null`, strict) in `editorActionSchema`, with a reducer case. `studio-edits.ts` gains `captionWordKeySchema` and `withCaptionEmphasis(edits, keys, value)`: it sets or clears the keys, drops the field once it is empty, and returns null past the 2,000 cap, so the reducer refuses the edit. `caption-dynamic.ts` gains `captionStyleUsesAccent(style)` (roles, hero alternation, tile fills). `brand-template.ts` gains `applyBrandColorsToCaption` (moved from the service; `brand-template.service.ts` imports it) and its inverse `brandColorsFromCaption`. Tests: the contract test (schema, undo, redo, coalesced gesture, no-ops, cap, emptied field), a test that the apply-to-all patch cannot carry `captionEmphasis`, and `brand-template.test.ts`.
- `packages/caption-fonts/src/caption-block.ts`: `CaptionBlockLayout.shift`, the safe-area shift in canvas px (additive; test in `caption-block.test.ts`).
- `apps/web` Studio: `tool-panels/captions-panel-model.ts` (+test) holds the pure decisions: animations per preset, the Emphasis row, gesture to actions, and the cap check. In `captions-panel.tsx`, Customize splits into a classic panel (controls unchanged) and a dynamic panel. The dynamic panel shows Size, Position, Colors (Text, Hero, and Accent only when the style uses it), Emphasis, Display (Subtitles, Punctuation) and Advanced (Text font, Hero font, Text transform, Animation, Words on screen 2 to 5, Emphasis size 0.70 to 1.40, Shadow, Effects: Outline and Glow). `studio-shell.tsx` adds `setCaptionEmphasis(changes)`, which sends each change as an editor action under one coalescing key, then ends the gesture (one undo step). The edit travels in the editor document through the existing autosave; no route was added. `caption-cue-at.ts` (+test) adds `captionBlockDragPoint` and `captionBlockDroppedPosition`; `caption-block-painter.tsx` exposes the cue `direction`; `interactive-caption-overlay.tsx` uses them for block drags.
- `apps/web` brand kit: `template-form.tsx` keeps caption colours in sync through `applyBrandColorsToCaption`, and picking a catalog look takes the brand colours from `brandColorsFromCaption`, so the form preview and the saved template agree.

**Interpretations** (for review)

1. "Style (the gallery)" is the Presets tab. Customize does not repeat it (one control per job).
2. Dynamic main order follows section 7: Size, Position, Colors, Emphasis, then the Display toggles where they already are, then Advanced. Advanced is closed by default and its open state is local to the panel.
3. Hidden for dynamic presets: Emoji, Backdrop, Highlight pill, Glow on the active word (blocks have no active word, decision 6) and Second outline (not in section 7's list). The Outline on/off chip moves into Advanced as an Outline effect with colour and width. Curve and Hero behind speaker are not shown; a comment in Advanced marks where tickets 07 and 09 add them.
4. Animation: a dynamic preset lists the motions `captionBlockAnimation` accepts (word reveal, no effect, not jelly), and the chosen chip is the motion the block actually draws. A classic preset never lists a dynamic-only motion.
5. Hero font chips are built-in faces; choosing the style's own face stores `heroFontName: undefined`. Emphasis size 1.00 stores `emphasisScale: undefined`. Both keep the preset matching its catalog look.
6. Emphasis chips show `block.texts`. A 2-word hero is one chip. The hero chip carries the Join next toggle (link icon); while the words are joined, the same toggle splits them ("hero" on the first word). It appears only when the hero has a next word in the cue. Tapping the hero chip does nothing.
7. A tap clears the cue's overrides, then writes `"hero"`. Join writes `"pair"` after the same clear. With two `"hero"` overrides the scorer keeps the higher-scoring one, not the latest tap, so the clear is needed. Auto and No emphasis are a segmented switch under the chips: Auto is current when the cue has no overrides, No emphasis when every word is plain, neither for a chosen hero.
8. Dub cues (null keys) show their chips read-only with "Dubbed captions use automatic emphasis." With no block under the playhead (between cues, untimed cues, no captions) the row says "Move the playhead onto a caption to choose its emphasis."
9. Past the 2,000 cap the panel shows an error toast and sends nothing; the reducer refuses it too.
10. Drag: the drag point is the block as drawn (its centre, or its left edge for a left style, the right edge for an RTL cue in a left style), including the safe-area shift. The dropped point is stored as `positionX/Y`, so a block the safe area had pushed up lands where it is dropped instead of snapping back. The stored value never includes the shift, and rendering reapplies it only when the dropped place is outside the safe area. 03c added the stored anchor's delta, so dragging a shifted block (for example Headline at Bottom) could leave it where it was. Resize still scales `fontSize`. The Position switch compares a left style against its `leftGuidePct`.
11. Brand colours: support keeps the preset's text colour (the style's white or cream). Primary goes to `highlightColor`. Secondary goes to `accentColor` only for styles that draw an accent, and only when it differs from the accent the preset already draws, so a catalog look whose colours are the brand's still matches its catalog entry.
12. Apply to all clips already sends only `captionPreset`, and the apply-studio-edits patch is limited to transition, background and framing, so emphasis stays per clip. No code change; there is a test for the patch.

**Visual check** (temporary harness route over a mock Studio context and the real plan, deleted afterwards along with a temporary `StudioContext` export), in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/04/`: `dynamic-customize-collapsed.png`, `dynamic-customize-advanced.png`, `emphasis-hero.png` (stored `{"600":"hero"}`), `emphasis-pair.png` (`{"600":"pair"}`), `emphasis-none.png` (all four plain), `emphasis-dub.png`, `classic-customize.png` (Bold Pop, unchanged apart from Slide/Slam/Drop not listed), `dynamic-accent-marker.png` (05's Marker shows Accent). Auto returned `{}`.

**Seen, not fixed (03c):** the panel's live preview cuts off the top of tall blocks (the hero or lead row is clipped in the 112 px stage; see `emphasis-hero.png`).

**Not verified:** the live Studio (sign-in), so the real autosave round trip and the on-video drag were not driven in a browser. The drag math and the action path are unit tested.

**Verification** (Bun 1.4.4, worktree root)

- Touched tests: validators `editor-document-contract`, `studio-edits`, `brand-template` (pass); caption-fonts `caption-block` 33 pass; web `captions-panel-model` 11 and `caption-cue-at` 9 pass.
- `bun run lint`: 0 errors (the 20 warnings and 1 info baseline); `biome check` on every touched file is clean.
- `bun run typecheck`: 14 of 15 pass. web fails only in `_shared/caption-preset-backdrops.ts` (missing editorial, cutout, marker, stack), from ticket 05's in-progress catalog.
- `bun run test` (`turbo run test --continue`): web 1158, services 1629, composition-plan 140, caption-fonts 122, api-client 232, mcp-core 169, auth 96 and the rest pass. Failures not from this ticket: validators 5 (catalog count, Dynamic group, Headline row, two `captionRoleLook` cases: 05's catalog edits), api 2 (OpenAPI snapshot and artifact gain 05's preset ids; needs `openapi:generate` once the catalog lands), media 2 (`cutout-*` Caption Block ASS cases from 05's fixtures), mcp-server 1 (upload part order race in `upload.test.ts`; passed 3 of 3 reruns; `apps/mcp` untouched).
- `bun run check:web-split`: passed. `bun run --cwd apps/api test:inventory`: 301 routes, 0 problems.

