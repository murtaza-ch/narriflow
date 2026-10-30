# 11 — Studio preview parity + client/language contracts

**What to build:** Studio (`apps/web` caption-style-engine, caption-fonts, transcript panel): lazy fallback faces (`preload:false`, unicode-range), `lang`/`dir` on cues from effective language/first strong char, word order + karaoke sweep for RTL, locale casing, `joinTranscriptWords` in transcript panel selection/copy; mirror ticket 10's geometry/degradation contract. Language picker: flat Scribe list, Auto first (keep picker everywhere it exists: import, generation setup, recipes); remove accuracy bands/model groups (`languages.ts`, `language-select.tsx`, `advanced-clip-settings.tsx`, `recipes-panel.tsx`, `recipe-picker.tsx`). Regenerate public OpenAPI (`openapi:check`), REST snapshot, MCP tool schemas/descriptions, docs pages mentioning languages.

**Blocked by:** 01, 08, 09 (parity finish after 10)

**Status:** ready-for-agent

**Acceptance:**
- [ ] `bun run --cwd apps/web test`, `check:web-split`, `openapi:check`, api-client tests green.
- [ ] Browser check in owner's logged-in Chrome (new tab) of Urdu, Arabic, Japanese, Hindi clips vs exported frames.
