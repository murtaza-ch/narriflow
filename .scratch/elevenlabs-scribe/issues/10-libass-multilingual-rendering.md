# 10 — Multilingual burn-in: font precedence, shaped geometry, RTL

**What to build:** Spec D11/D12 in `apps/worker/src/caption-glyphs.ts` and `caption-ass.ts`: locale font precedence by effective language; HarfBuzz-shaped measurement of same-face runs (e.g. `harfbuzzjs` with the vendored font files) replacing per-grapheme advances, giving visual word boxes for pills/plates/emoji/motion in bidi visual order; Nastaliq-aware line metrics; `Encoding -1`; verified RTL karaoke/active-word sweep on the pinned libass (fallback: animated clip). Same typed degradation contract when geometry is unavailable (documented for ticket 11).

**Blocked by:** 08, 09

**Status:** ready-for-agent

**Acceptance:**
- [ ] Golden frames rendered with the pinned ffmpeg/libass for: Urdu (Nastaliq, long word, top/bottom), Arabic+numbers, Hebrew, Hindi conjuncts, Bengali, Tamil, Thai, Japanese, Cantonese, Amharic, Georgian, English pill style — inspected and committed as test evidence.
- [ ] Worker caption tests green.
