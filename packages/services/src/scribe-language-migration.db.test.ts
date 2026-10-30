import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { SCRIBE_LANGUAGES, sourceLanguageCodeSchema } from "@narriflow/validators";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(120_000);

const MIGRATIONS = resolve(import.meta.dir, "../../db/prisma/migrations");
const SCRIBE_MIGRATION = "20261030160000_scribe_language_codes";
const migrationSql = (folder: string) => readFileSync(resolve(MIGRATIONS, folder, "migration.sql"), "utf8");
const allFolders = () => readdirSync(MIGRATIONS).filter((entry) => /^\d+_/.test(entry)).sort();

/** The fingerprint `immutableInputFingerprint` computes for a request without a Recipe. */
const requestFingerprint = (input: { title: string; fileName: string; languageCode: string | null }) =>
  JSON.stringify({
    title: input.title,
    source: { fileName: input.fileName, sizeBytes: 1024, contentType: "video/mp4", browserFingerprint: "browser" },
    generation: { languageCode: input.languageCode, contentPack: { mode: "clips" } },
  });

/** The migration is the only thing that moves stored language codes onto the Scribe registry, so it
 * runs against a schema built from every earlier migration and holding rows with the old codes. */
describeDb("Scribe language codes migration", () => {
  const upgraded = `scribe_lang_up_${randomUUID().replaceAll("-", "")}`;
  const fresh = `scribe_lang_new_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let client: PoolClient;

  const user = randomUUID();
  const workspace = randomUUID();
  const recipeIds = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const transcriptIds = new Map<string, string>();
  const sessionIds = new Map<string, string>();
  const jobIds = new Map<string, string>();
  const rssPayload = { rssUrl: "https://feeds.example.test/show.xml", episode: { title: "Episode", guid: "g-1" } };
  const utterances = [{ start: 0, end: 1, text: "hello", words: [] }];
  const unparsedFingerprint = "{not json at all";

  async function createSchema(name: string, folders: string[]) {
    await client.query(`CREATE SCHEMA "${name}"`);
    await client.query(`SET search_path TO "${name}"`);
    for (const folder of folders) await client.query(migrationSql(folder));
  }

  async function project(key: string, languageCode: string | null) {
    const id = randomUUID();
    projectIds.set(key, id);
    await client.query(
      `INSERT INTO "Project" ("id", "workspaceId", "title", "sourceMediaUrl", "languageCode", "updatedAt") VALUES ($1, $2, $3, 'r2://bucket/source', $4, now())`,
      [id, workspace, key, languageCode],
    );
    return id;
  }

  async function transcript(key: string, languageCode: string | null, provider: string | null = "elevenlabs") {
    const projectId = await project(`transcript-${key}`, null);
    const id = randomUUID();
    transcriptIds.set(key, id);
    await client.query(
      `INSERT INTO "Transcript" ("id", "projectId", "provider", "providerModel", "languageCode", "text", "utterancesJson", "updatedAt")
       VALUES ($1, $2, $3, 'model', $4, 'hello', $5, now())`,
      [id, projectId, provider, languageCode, JSON.stringify(utterances)],
    );
  }

  async function recipe(key: string, languageCode: string | null) {
    const id = randomUUID();
    recipeIds.set(key, id);
    await client.query(
      `INSERT INTO "Recipe" ("id", "workspaceId", "name", "languageCode", "contentPack", "updatedAt") VALUES ($1, $2, $3, $4, '{}', '2026-10-01T00:00:00Z')`,
      [id, workspace, key, languageCode],
    );
  }

  async function session(
    key: string,
    status: string,
    generation: Record<string, unknown>,
    fingerprint: string,
  ) {
    const id = randomUUID();
    sessionIds.set(key, id);
    await client.query(
      `INSERT INTO "UploadSession" ("id", "workspaceId", "actorUserId", "clientIdempotencyKey", "immutableInputFingerprint", "preallocatedProjectId", "title", "fileName", "fileSizeBytes", "contentType",
         "browserFingerprint", "generationSettings", "transferKind", "storageKey", "status", "expiresAt", "hardExpiresAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'clip.mp4', 1024, 'video/mp4', 'browser', $8, 'single', $9, $10::"UploadSessionStatus", now() + interval '1 day', now() + interval '2 days', now())`,
      [id, workspace, user, randomUUID(), fingerprint, randomUUID(), key, JSON.stringify(generation), `workspaces/${workspace}/upload-sessions/${id}/clip.mp4`, status],
    );
  }

  const column = async (table: string, key: string, ids: Map<string, string>, name: string) =>
    (await client.query(`SELECT "${name}" AS value FROM "${table}" WHERE "id" = $1`, [ids.get(key)])).rows[0].value;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    client = await pool.connect();
    await createSchema(upgraded, allFolders().filter((entry) => entry !== SCRIBE_MIGRATION));

    await client.query(`INSERT INTO "User" ("id", "clerkId", "updatedAt") VALUES ($1, $2, now())`, [user, `scribe-${user}`]);
    await client.query(`INSERT INTO "Workspace" ("id", "name", "ownerUserId", "updatedAt") VALUES ($1, 'Scribe', $2, now())`, [workspace, user]);

    for (const code of ["en_us", "en_uk", "en_au", "jw", "tl", "auto", "eu", "nn", "es", "zh", "yue", " ES "]) await project(`project-${code}`, code);
    await project("project-null", null);

    for (const code of ["en_us", "jw", "tl", "bo", "es", " ES "]) await recipe(`recipe-${code}`, code);
    await recipe("recipe-null", null);

    for (const code of ["eng", "urd", "cmn", "zho", "en_us", "en_au", "pt-BR", "tl", "jw", "fil", "yue", "en", "eu", "xx-yy", "Spa"]) await transcript(code, code);
    await transcript("null", null);
    await transcript("assemblyai-en_us", "en_us", "assemblyai");

    const settings = (languageCode?: string | null) => ({
      ...(languageCode === undefined ? {} : { languageCode }),
      contentPack: { mode: "clips" },
      finishing: null,
      recipe: null,
    });
    const sessionTitle = "Old en_us session";
    await session("pending-en_au", "uploading", settings("en_au"), requestFingerprint({ title: sessionTitle, fileName: "clip.mp4", languageCode: "en_au" }));
    await session("finalizing-jw", "finalizing", settings("jw"), requestFingerprint({ title: "Finalizing jw", fileName: "clip.mp4", languageCode: "jw" }));
    await session("queued-tl", "queued_for_ingest", settings("tl"), requestFingerprint({ title: "Queued tl", fileName: "clip.mp4", languageCode: "tl" }));
    await session("unsupported-nn", "reconciling", settings("nn"), requestFingerprint({ title: "Unsupported nn", fileName: "clip.mp4", languageCode: "nn" }));
    await session("kept-es", "uploading", settings("es"), requestFingerprint({ title: "Spanish", fileName: "clip.mp4", languageCode: "es" }));
    await session("auto-null", "uploading", settings(null), requestFingerprint({ title: "Auto", fileName: "clip.mp4", languageCode: null }));
    await session("no-language-key", "uploading", settings(), requestFingerprint({ title: "No key", fileName: "clip.mp4", languageCode: null }));
    // A title carrying the key text is escaped inside the fingerprint, so only the real key is rewritten.
    const trapTitle = 'x","languageCode":"en_us"';
    await session("trap-title", "uploading", settings("en_us"), requestFingerprint({ title: trapTitle, fileName: "clip.mp4", languageCode: "en_us" }));
    // A session built from a Recipe fingerprints only the Recipe's ID; its frozen language is still rewritten.
    await session("recipe-session", "uploading", { ...settings("en_uk"), recipe: { id: randomUUID(), revision: 1 } }, JSON.stringify({ title: "Recipe", recipeId: randomUUID() }));
    await session("unparsed-fingerprint", "uploading", settings("tl"), unparsedFingerprint);

    for (const [key, jobType, payload] of [
      ["rss", "rss_import", rssPayload],
      ["link", "link_import", { url: "https://example.test/v", provider: "youtube", requestedTitle: null }],
    ] as const) {
      const id = randomUUID();
      jobIds.set(key, id);
      await client.query(
        `INSERT INTO "IngestJob" ("id", "projectId", "jobType", "payload", "updatedAt") VALUES ($1, $2, $3::"IngestJobType", $4, now())`,
        [id, projectIds.get("project-es"), jobType, JSON.stringify(payload)],
      );
    }

    await client.query(migrationSql(SCRIBE_MIGRATION));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
    await client?.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
    client?.release();
    await pool?.end();
  });

  test("Project languages move onto the registry; retired and unsupported codes become Auto", async () => {
    const result = new Map<string, string | null>();
    for (const key of projectIds.keys()) if (key.startsWith("project-")) result.set(key, await column("Project", key, projectIds, "languageCode"));
    expect(Object.fromEntries(result)).toEqual({
      "project-en_us": "en",
      "project-en_uk": "en",
      "project-en_au": "en",
      "project-jw": "jv",
      "project-tl": "fil",
      "project-auto": null,
      "project-eu": null,
      "project-nn": null,
      "project-es": "es",
      "project-zh": "zh",
      "project-yue": "yue",
      "project- ES ": "es",
      "project-null": null,
    });
    for (const value of result.values()) expect(sourceLanguageCodeSchema.safeParse(value).success).toBe(true);
  });

  test("Recipe languages follow the same rule, and only a changed Recipe is revised", async () => {
    const read = async (key: string) =>
      (await client.query(`SELECT "languageCode", "revision", "contentRevision" FROM "Recipe" WHERE "id" = $1`, [recipeIds.get(key)])).rows[0];
    expect(await read("recipe-en_us")).toEqual({ languageCode: "en", revision: 2, contentRevision: 2 });
    expect(await read("recipe-jw")).toEqual({ languageCode: "jv", revision: 2, contentRevision: 2 });
    expect(await read("recipe-tl")).toEqual({ languageCode: "fil", revision: 2, contentRevision: 2 });
    expect(await read("recipe-bo")).toEqual({ languageCode: null, revision: 2, contentRevision: 2 });
    expect(await read("recipe- ES ")).toEqual({ languageCode: "es", revision: 2, contentRevision: 2 });
    expect(await read("recipe-es")).toEqual({ languageCode: "es", revision: 1, contentRevision: 1 });
    expect(await read("recipe-null")).toEqual({ languageCode: null, revision: 1, contentRevision: 1 });
  });

  test("Transcript languages gain the canonical spelling; unknown codes and everything else stay", async () => {
    const expected: Record<string, string | null> = {
      eng: "en",
      urd: "ur",
      cmn: "zh",
      zho: "zh",
      en_us: "en",
      en_au: "en",
      "pt-BR": "pt",
      tl: "fil",
      jw: "jv",
      fil: "fil",
      yue: "yue",
      en: "en",
      eu: "eu",
      "xx-yy": "xx-yy",
      Spa: "es",
      null: null,
    };
    for (const [key, value] of Object.entries(expected)) expect(await column("Transcript", key, transcriptIds, "languageCode")).toBe(value);
  });

  test("a historical assemblyai Transcript keeps its provider, text and utterances", async () => {
    const row = (await client.query(`SELECT * FROM "Transcript" WHERE "id" = $1`, [transcriptIds.get("assemblyai-en_us")])).rows[0];
    expect(row).toMatchObject({ provider: "assemblyai", providerModel: "model", text: "hello", languageCode: "en" });
    expect(row.utterancesJson).toEqual(utterances);
  });

  test("Upload Sessions rewrite the frozen language and the fingerprint that covers it, in step", async () => {
    const read = async (key: string) =>
      (await client.query(`SELECT "generationSettings", "immutableInputFingerprint", "status" FROM "UploadSession" WHERE "id" = $1`, [sessionIds.get(key)])).rows[0];

    const pending = await read("pending-en_au");
    expect(pending.generationSettings).toEqual({ languageCode: "en", contentPack: { mode: "clips" }, finishing: null, recipe: null });
    // A replay of the same idempotency key now sends the canonical code and must still match.
    expect(pending.immutableInputFingerprint).toBe(requestFingerprint({ title: "Old en_us session", fileName: "clip.mp4", languageCode: "en" }));
    expect(pending.status).toBe("uploading");

    const finalizing = await read("finalizing-jw");
    expect(finalizing.generationSettings.languageCode).toBe("jv");
    expect(finalizing.immutableInputFingerprint).toBe(requestFingerprint({ title: "Finalizing jw", fileName: "clip.mp4", languageCode: "jv" }));
    expect(finalizing.status).toBe("finalizing");

    const queued = await read("queued-tl");
    expect(queued.generationSettings.languageCode).toBe("fil");
    expect(queued.immutableInputFingerprint).toBe(requestFingerprint({ title: "Queued tl", fileName: "clip.mp4", languageCode: "fil" }));

    const unsupported = await read("unsupported-nn");
    expect(unsupported.generationSettings.languageCode).toBeNull();
    expect(unsupported.immutableInputFingerprint).toBe(requestFingerprint({ title: "Unsupported nn", fileName: "clip.mp4", languageCode: null }));

    for (const [key, title, languageCode] of [["kept-es", "Spanish", "es"], ["auto-null", "Auto", null], ["no-language-key", "No key", null]] as const) {
      const untouched = await read(key);
      expect(untouched.immutableInputFingerprint).toBe(requestFingerprint({ title, fileName: "clip.mp4", languageCode }));
    }
    expect((await read("kept-es")).generationSettings.languageCode).toBe("es");
    expect((await read("auto-null")).generationSettings.languageCode).toBeNull();
    expect("languageCode" in (await read("no-language-key")).generationSettings).toBe(false);

    const trap = await read("trap-title");
    expect(trap.generationSettings.languageCode).toBe("en");
    expect(trap.immutableInputFingerprint).toBe(requestFingerprint({ title: 'x","languageCode":"en_us"', fileName: "clip.mp4", languageCode: "en" }));

    const withRecipe = await read("recipe-session");
    expect(withRecipe.generationSettings.languageCode).toBe("en");
    expect(JSON.parse(withRecipe.immutableInputFingerprint)).toMatchObject({ title: "Recipe" });
    expect(Object.keys(JSON.parse(withRecipe.immutableInputFingerprint))).toEqual(["title", "recipeId"]);

    // A fingerprint the migration cannot place is left alone rather than failing the deploy.
    const odd = await read("unparsed-fingerprint");
    expect(odd.generationSettings.languageCode).toBe("fil");
    expect(odd.immutableInputFingerprint).toBe(unparsedFingerprint);
  });

  test("Ingest Job payloads carry no language and are untouched", async () => {
    const read = async (key: string) => (await client.query(`SELECT "payload" FROM "IngestJob" WHERE "id" = $1`, [jobIds.get(key)])).rows[0].payload;
    expect(await read("rss")).toEqual(rssPayload);
    expect(await read("link")).toEqual({ url: "https://example.test/v", provider: "youtube", requestedTitle: null });
  });

  test("running the migration again changes nothing, and leaves no helpers behind", async () => {
    const snapshot = async () => ({
      projects: (await client.query(`SELECT "id", "languageCode" FROM "Project" ORDER BY "id"`)).rows,
      recipes: (await client.query(`SELECT "id", "languageCode", "revision", "contentRevision" FROM "Recipe" ORDER BY "id"`)).rows,
      transcripts: (await client.query(`SELECT "id", "languageCode" FROM "Transcript" ORDER BY "id"`)).rows,
      sessions: (await client.query(`SELECT "id", "generationSettings", "immutableInputFingerprint" FROM "UploadSession" ORDER BY "id"`)).rows,
    });
    const before = await snapshot();
    await client.query(migrationSql(SCRIBE_MIGRATION));
    expect(await snapshot()).toEqual(before);
    const leftovers = await client.query(`SELECT to_regclass('pg_temp."_input_language"') AS input, to_regclass('pg_temp."_transcript_language"') AS transcript`);
    expect(leftovers.rows[0]).toEqual({ input: null, transcript: null });
  });

  test("every registry code and Scribe code maps to itself or its canonical code", async () => {
    // The migration's tables are generated from the registry; this keeps them from drifting.
    await client.query(`SET search_path TO "${upgraded}"`);
    for (const language of SCRIBE_LANGUAGES) {
      const probe = `probe-${language.code}`;
      await project(probe, language.code);
      await transcript(probe, language.providerCode);
    }
    await client.query(migrationSql(SCRIBE_MIGRATION));
    for (const language of SCRIBE_LANGUAGES) {
      const probe = `probe-${language.code}`;
      expect(await column("Project", probe, projectIds, "languageCode")).toBe(language.code);
      expect(await column("Transcript", probe, transcriptIds, "languageCode")).toBe(language.code);
    }
  });

  test("a fresh schema built from every migration applies cleanly", async () => {
    await createSchema(fresh, allFolders());
    const { rows } = await client.query(`SELECT count(*)::int AS projects FROM "Project"`);
    expect(rows[0].projects).toBe(0);
  });
});
