-- Stored language codes move onto the Scribe v2 registry
-- (packages/validators/src/language.ts, spec D8/D9). Field-specific updates
-- only: no schema change, no rewrite of provider="assemblyai" Transcript rows
-- beyond their languageCode, no touch of raw provider JSON, utterances,
-- IngestJob payloads (no job payload carries a language) or Operation Receipts
-- (historical results stay as recorded).
--
-- Inputs (Project, Recipe, UploadSession.generationSettings): the registry's
-- canonical codes stay; en_us/en_uk/en_au -> en, jw -> jv, tl -> fil; anything
-- else (retired codes, "auto", unsupported languages) -> NULL, i.e. detect it.
-- Transcript.languageCode records what was detected, so it keeps any code it
-- cannot place and only gains the canonical spelling (ISO 639-3 such as eng or
-- urd, cmn -> zh, regional tags such as en_us or pt-BR keep the language).

CREATE TEMP TABLE "_input_language" ("alias" TEXT PRIMARY KEY, "canonical" TEXT NOT NULL);
INSERT INTO "_input_language" ("alias", "canonical") VALUES
    ('af', 'af'),
    ('am', 'am'),
    ('ar', 'ar'),
    ('hy', 'hy'),
    ('as', 'as'),
    ('ast', 'ast'),
    ('az', 'az'),
    ('be', 'be'),
    ('bn', 'bn'),
    ('bs', 'bs'),
    ('bg', 'bg'),
    ('my', 'my'),
    ('yue', 'yue'),
    ('ca', 'ca'),
    ('ceb', 'ceb'),
    ('ny', 'ny'),
    ('zh', 'zh'),
    ('hr', 'hr'),
    ('cs', 'cs'),
    ('da', 'da'),
    ('nl', 'nl'),
    ('en', 'en'),
    ('et', 'et'),
    ('fil', 'fil'),
    ('fi', 'fi'),
    ('fr', 'fr'),
    ('ff', 'ff'),
    ('gl', 'gl'),
    ('lg', 'lg'),
    ('ka', 'ka'),
    ('de', 'de'),
    ('el', 'el'),
    ('gu', 'gu'),
    ('ha', 'ha'),
    ('he', 'he'),
    ('hi', 'hi'),
    ('hu', 'hu'),
    ('is', 'is'),
    ('ig', 'ig'),
    ('id', 'id'),
    ('ga', 'ga'),
    ('it', 'it'),
    ('ja', 'ja'),
    ('jv', 'jv'),
    ('kea', 'kea'),
    ('kn', 'kn'),
    ('kk', 'kk'),
    ('km', 'km'),
    ('ko', 'ko'),
    ('ku', 'ku'),
    ('ky', 'ky'),
    ('lo', 'lo'),
    ('lv', 'lv'),
    ('ln', 'ln'),
    ('lt', 'lt'),
    ('luo', 'luo'),
    ('lb', 'lb'),
    ('mk', 'mk'),
    ('ms', 'ms'),
    ('ml', 'ml'),
    ('mt', 'mt'),
    ('mi', 'mi'),
    ('mr', 'mr'),
    ('mn', 'mn'),
    ('ne', 'ne'),
    ('nso', 'nso'),
    ('no', 'no'),
    ('oc', 'oc'),
    ('or', 'or'),
    ('ps', 'ps'),
    ('fa', 'fa'),
    ('pl', 'pl'),
    ('pt', 'pt'),
    ('pa', 'pa'),
    ('ro', 'ro'),
    ('ru', 'ru'),
    ('sr', 'sr'),
    ('sn', 'sn'),
    ('sd', 'sd'),
    ('si', 'si'),
    ('sk', 'sk'),
    ('sl', 'sl'),
    ('so', 'so'),
    ('es', 'es'),
    ('sw', 'sw'),
    ('sv', 'sv'),
    ('tg', 'tg'),
    ('ta', 'ta'),
    ('te', 'te'),
    ('th', 'th'),
    ('tr', 'tr'),
    ('uk', 'uk'),
    ('umb', 'umb'),
    ('ur', 'ur'),
    ('uz', 'uz'),
    ('vi', 'vi'),
    ('cy', 'cy'),
    ('wo', 'wo'),
    ('xh', 'xh'),
    ('yo', 'yo'),
    ('zu', 'zu'),
    ('en_us', 'en'),
    ('en_uk', 'en'),
    ('en_au', 'en'),
    ('jw', 'jv'),
    ('tl', 'fil');

CREATE TEMP TABLE "_transcript_language" ("alias" TEXT PRIMARY KEY, "canonical" TEXT NOT NULL);
INSERT INTO "_transcript_language" ("alias", "canonical")
SELECT "alias", "canonical" FROM "_input_language";
INSERT INTO "_transcript_language" ("alias", "canonical") VALUES
    ('afr', 'af'),
    ('amh', 'am'),
    ('ara', 'ar'),
    ('hye', 'hy'),
    ('asm', 'as'),
    ('aze', 'az'),
    ('bel', 'be'),
    ('ben', 'bn'),
    ('bos', 'bs'),
    ('bul', 'bg'),
    ('mya', 'my'),
    ('cat', 'ca'),
    ('nya', 'ny'),
    ('zho', 'zh'),
    ('hrv', 'hr'),
    ('ces', 'cs'),
    ('dan', 'da'),
    ('nld', 'nl'),
    ('eng', 'en'),
    ('est', 'et'),
    ('fin', 'fi'),
    ('fra', 'fr'),
    ('ful', 'ff'),
    ('glg', 'gl'),
    ('lug', 'lg'),
    ('kat', 'ka'),
    ('deu', 'de'),
    ('ell', 'el'),
    ('guj', 'gu'),
    ('hau', 'ha'),
    ('heb', 'he'),
    ('hin', 'hi'),
    ('hun', 'hu'),
    ('isl', 'is'),
    ('ibo', 'ig'),
    ('ind', 'id'),
    ('gle', 'ga'),
    ('ita', 'it'),
    ('jpn', 'ja'),
    ('jav', 'jv'),
    ('kan', 'kn'),
    ('kaz', 'kk'),
    ('khm', 'km'),
    ('kor', 'ko'),
    ('kur', 'ku'),
    ('kir', 'ky'),
    ('lao', 'lo'),
    ('lav', 'lv'),
    ('lin', 'ln'),
    ('lit', 'lt'),
    ('ltz', 'lb'),
    ('mkd', 'mk'),
    ('msa', 'ms'),
    ('mal', 'ml'),
    ('mlt', 'mt'),
    ('mri', 'mi'),
    ('mar', 'mr'),
    ('mon', 'mn'),
    ('nep', 'ne'),
    ('nor', 'no'),
    ('oci', 'oc'),
    ('ori', 'or'),
    ('pus', 'ps'),
    ('fas', 'fa'),
    ('pol', 'pl'),
    ('por', 'pt'),
    ('pan', 'pa'),
    ('ron', 'ro'),
    ('rus', 'ru'),
    ('srp', 'sr'),
    ('sna', 'sn'),
    ('snd', 'sd'),
    ('sin', 'si'),
    ('slk', 'sk'),
    ('slv', 'sl'),
    ('som', 'so'),
    ('spa', 'es'),
    ('swa', 'sw'),
    ('swe', 'sv'),
    ('tgk', 'tg'),
    ('tam', 'ta'),
    ('tel', 'te'),
    ('tha', 'th'),
    ('tur', 'tr'),
    ('ukr', 'uk'),
    ('urd', 'ur'),
    ('uzb', 'uz'),
    ('vie', 'vi'),
    ('cym', 'cy'),
    ('wol', 'wo'),
    ('xho', 'xh'),
    ('yor', 'yo'),
    ('zul', 'zu'),
    ('cmn', 'zh');

CREATE FUNCTION pg_temp.input_language(raw TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT "canonical" FROM "_input_language" WHERE "alias" = lower(btrim(raw))
$$;

CREATE FUNCTION pg_temp.transcript_language(raw TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT "canonical" FROM "_transcript_language" WHERE "alias" = lower(replace(btrim(raw), '_', '-'))),
    (SELECT "canonical" FROM "_transcript_language" WHERE "alias" = split_part(lower(replace(btrim(raw), '_', '-')), '-', 1)),
    raw
  )
$$;

UPDATE "Project"
SET "languageCode" = pg_temp.input_language("languageCode")
WHERE "languageCode" IS NOT NULL
  AND "languageCode" IS DISTINCT FROM pg_temp.input_language("languageCode");

-- A Recipe whose language moved is an edit of what work would use: bump both
-- revisions so a stale editor re-reads it and Standing Grants (which
-- fingerprint contentRevision) pause for renewal.
UPDATE "Recipe"
SET "languageCode" = pg_temp.input_language("languageCode"),
    "revision" = "revision" + 1,
    "contentRevision" = "contentRevision" + 1,
    "updatedAt" = now()
WHERE "languageCode" IS NOT NULL
  AND "languageCode" IS DISTINCT FROM pg_temp.input_language("languageCode");

UPDATE "Transcript"
SET "languageCode" = pg_temp.transcript_language("languageCode")
WHERE "languageCode" IS NOT NULL
  AND "languageCode" IS DISTINCT FROM pg_temp.transcript_language("languageCode");

-- An Upload Session fingerprints its requested generation settings (language
-- included) and freezes them for the handoff. Sessions are rewritten, not
-- expired: expiring one that is finalizing would discard a finished upload,
-- and rewriting keeps a replay of the same idempotency key (now carrying the
-- canonical code) matching its fingerprint. The fingerprint is compact
-- JSON.stringify output, so the exact key text is replaced; a file name or
-- title cannot contain it unescaped. Recipe-based sessions fingerprint only
-- the Recipe ID, so there the replace is a no-op.
UPDATE "UploadSession"
SET "generationSettings" = jsonb_set(
      "generationSettings",
      '{languageCode}',
      COALESCE(to_jsonb(pg_temp.input_language("generationSettings" ->> 'languageCode')), 'null'::jsonb)
    ),
    "immutableInputFingerprint" = replace(
      "immutableInputFingerprint",
      '"languageCode":' || ("generationSettings" -> 'languageCode')::text,
      '"languageCode":' || COALESCE(to_jsonb(pg_temp.input_language("generationSettings" ->> 'languageCode'))::text, 'null')
    )
WHERE jsonb_typeof("generationSettings" -> 'languageCode') = 'string'
  AND ("generationSettings" ->> 'languageCode') IS DISTINCT FROM pg_temp.input_language("generationSettings" ->> 'languageCode');

DROP FUNCTION pg_temp.transcript_language(TEXT);
DROP FUNCTION pg_temp.input_language(TEXT);
DROP TABLE "_transcript_language";
DROP TABLE "_input_language";
