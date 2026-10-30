# 03 — Forward migration for stored language codes

**What to build:** Spec D9 as a new SQL migration in `packages/db/prisma/migrations/` (no schema.prisma edits).
Transforms: `en_us/en_uk/en_au`→`en`, `jw`→`jv`, `tl`→`fil`, other codes outside the new catalog → NULL for inputs (`Project.languageCode`, `Recipe.languageCode`, `UploadSession.generationSettings.languageCode`, `IngestJob.payload` language paths incl. `generationContext.languageCode`), and ISO 639-3 / retired codes in `Transcript.languageCode` normalized (keep recognizable codes). Expire/reset pending upload acceptances whose fingerprint covers language. Field-specific JSON updates only.

**Blocked by:** 01

**Status:** done

**Acceptance:**
- [x] Migration fixture test on a disposable schema (fresh + upgraded) — follow the existing `*.db.test.ts` disposable-schema pattern.
- [x] Not applied to the shared Neon DB by the implementer.

## Comments

Migration `20261030160000_scribe_language_codes` (SQL only, schema.prisma untouched), tested on a local Postgres 17 (port 55433), never the shared Neon DB.

- Inputs (`Project`, `Recipe`, `UploadSession.generationSettings.languageCode`): registry codes stay; `en_us/en_uk/en_au`→`en`, `jw`→`jv`, `tl`→`fil`; everything else (incl. `"auto"`, `nn`, `eu`, `bo`) → NULL. Lower/trim first.
- `Recipe`: a changed row bumps `revision` and `contentRevision` (same as a language edit; Standing Grants fingerprint `contentRevision`, so they pause for renewal).
- `Transcript.languageCode` (all providers, `provider`/`providerModel`/text/utterances/raw untouched): canonical, ISO 639-3 (`eng`, `urd`, `zho`), `cmn`→`zh`, aliases, regional tags (`en_us`, `pt-BR`) → canonical; unknown codes stay as-is.
- Pending Upload Sessions: **rewritten, not expired.** `generationSettings.languageCode` and the same key in `immutableInputFingerprint` (compact `JSON.stringify` text, exact key replace) move together, so a replay of the same idempotency key with the canonical code still matches, and a `finalizing`/`reconciling` session keeps its finished upload instead of being compensated. Recipe-based sessions fingerprint only the Recipe ID, so only their frozen settings change.
- No `IngestJob.payload` shape carries a language (link/drive/rss/zoom/upload_finalize inspected); no JSON column stores `generationContext` (it is transient and lands in `ContentPack` columns). Payloads and Operation Receipts are left as recorded.
- Evidence: `scribe-language-migration.db.test.ts` (9 tests, 269 expects; fails 6/9 with an empty migration) and the full `test:integration-api:db` runner, which also applies the migration through `prisma migrate deploy` (all suites green).
