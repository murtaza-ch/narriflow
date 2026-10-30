# 08 — Vendor script fonts + coverage

**What to build:** Spec D11 assets in `packages/caption-fonts`: download pinned Noto releases (official notofonts GitHub releases / Google Fonts), manifest with version, sha256, OFL license file, ASS family name, browser family name, unicode ranges; extend `CAPTION_FALLBACK_FONTS` (script faces, `letterSpacing: "disabled"` for complex scripts) and add language-aware entries (JP, TC, Nastaliq) with a `languages` field consumed later by ticket 10; regenerate `glyph-coverage-data.ts` with the existing generator; extend `apps/worker/scripts/check-render-environment.ts` with shaping specimens per script. No caption-ass or Studio changes.

**Blocked by:** 01

**Status:** ready-for-agent

**Acceptance:**
- [ ] Coverage table shows every script in the Scribe catalog's supported written forms covered (Mongolian = Cyrillic).
- [ ] Repo size impact recorded; CJK files ≤ what's needed (subset only if shaping tables preserved).
- [ ] `bun run --cwd packages/caption-fonts test` + typecheck green.
