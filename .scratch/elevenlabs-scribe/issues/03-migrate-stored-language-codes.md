# 03 — Forward migration for stored language codes

**What to build:** Spec D9 as a new SQL migration in `packages/db/prisma/migrations/` (no schema.prisma edits).
Transforms: `en_us/en_uk/en_au`→`en`, `jw`→`jv`, `tl`→`fil`, other codes outside the new catalog → NULL for inputs (`Project.languageCode`, `Recipe.languageCode`, `UploadSession.generationSettings.languageCode`, `IngestJob.payload` language paths incl. `generationContext.languageCode`), and ISO 639-3 / retired codes in `Transcript.languageCode` normalized (keep recognizable codes). Expire/reset pending upload acceptances whose fingerprint covers language. Field-specific JSON updates only.

**Blocked by:** 01

**Status:** ready-for-agent

**Acceptance:**
- [ ] Migration fixture test on a disposable schema (fresh + upgraded) — follow the existing `*.db.test.ts` disposable-schema pattern.
- [ ] Not applied to the shared Neon DB by the implementer.
