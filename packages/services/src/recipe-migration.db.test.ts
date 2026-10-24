import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { recipeInputSchema } from "@narriflow/validators";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(120_000);

const MIGRATIONS = resolve(import.meta.dir, "../../db/prisma/migrations");
const RECIPES_MIGRATION = "20261024210000_recipes";

/** The migration is the only thing that moves existing rules onto Recipes, so
 * it runs here against a schema built from every earlier migration, holding
 * rules that carry their own settings. */
describeDb("Recipes migration", () => {
  const schema = `recipe_migration_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let client: PoolClient;

  const pack = (clipCountTarget: number) => ({ outputTypes: ["short_clip"], clipCountTarget, clipDurationSecTarget: 45, platformPlaybookVersion: "test" });
  const finishing = { topClips: 2, minScore: 0, resolution: "1080p", copyPlatforms: [], delivery: "ready_to_review", queueAccountIds: [] };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const folders = readdirSync(MIGRATIONS).filter((entry) => entry !== RECIPES_MIGRATION && entry.match(/^\d+_/)).sort();
    for (const folder of folders) await client.query(readFileSync(resolve(MIGRATIONS, folder, "migration.sql"), "utf8"));
  });
  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client?.release();
    await pool?.end();
  });

  test("creates one Recipe per distinct rule setting, per Workspace, and points the rules at it", async () => {
    const user = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    const profile = randomUUID();
    await client.query(`INSERT INTO "User" ("id", "clerkId", "updatedAt") VALUES ($1, $2, now())`, [user, `migration-${user}`]);
    for (const [id, name] of [[first, "First"], [second, "Second"]] as const) {
      await client.query(`INSERT INTO "Workspace" ("id", "name", "ownerUserId", "updatedAt") VALUES ($1, $2, $3, now())`, [id, name, user]);
    }
    await client.query(
      `INSERT INTO "BrandProfile" ("id", "workspaceId", "createdByUserId", "updatedByUserId", "name", "slug", "visualIdentity", "voiceGuidance", "updatedAt")
       VALUES ($1, $2, $3, $3, 'Acme', 'acme', '{}', '{}', now())`,
      [profile, first, user],
    );
    const rule = async (workspaceId: string, name: string, createdAt: string, settings: { brandProfileId?: string; languageCode?: string; contentPack: object; finishing?: object }) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO "AutopilotRule" ("id", "workspaceId", "createdByUserId", "name", "rssUrl", "brandProfileId", "languageCode", "contentPack", "finishing", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'https://feeds.example.test/show.xml', $5, $6, $7, $8, $9, now())`,
        [id, workspaceId, user, name, settings.brandProfileId ?? null, settings.languageCode ?? null, JSON.stringify(settings.contentPack), settings.finishing ? JSON.stringify(settings.finishing) : null, createdAt],
      );
      return id;
    };
    // Two rules share settings (the key order of the stored JSON does not matter); the others each differ in one setting.
    const a = await rule(first, "Morning show", "2026-10-01T00:00:00Z", { contentPack: pack(10), brandProfileId: profile });
    const b = await rule(first, "Evening show", "2026-10-02T00:00:00Z", { contentPack: { platformPlaybookVersion: "test", clipDurationSecTarget: 45, clipCountTarget: 10, outputTypes: ["short_clip"] }, brandProfileId: profile });
    const c = await rule(first, "Finished show", "2026-10-03T00:00:00Z", { contentPack: pack(10), brandProfileId: profile, finishing });
    const d = await rule(first, "Spanish show", "2026-10-04T00:00:00Z", { contentPack: pack(10), brandProfileId: profile, languageCode: "es" });
    const e = await rule(first, "Short show", "2026-10-05T00:00:00Z", { contentPack: pack(5) });
    const f = await rule(second, "Other Workspace", "2026-10-06T00:00:00Z", { contentPack: pack(10), brandProfileId: undefined });
    // Settings a rule could hold that a Recipe refuses: a language the provider doesn't list, and captioned-video settings.
    const g = await rule(second, "Odd settings", "2026-10-07T00:00:00Z", { contentPack: { ...pack(7), mode: "caption_only", captionedVideo: { framing: "fit" } }, languageCode: " Klingon " });
    const h = await rule(second, "Spoken Spanish", "2026-10-08T00:00:00Z", { contentPack: pack(7), languageCode: " ES " });

    await client.query(readFileSync(resolve(MIGRATIONS, RECIPES_MIGRATION, "migration.sql"), "utf8"));

    const { rows } = await client.query<{ id: string; recipeId: string }>(`SELECT "id", "recipeId" FROM "AutopilotRule"`);
    const recipeOf = new Map(rows.map((row) => [row.id, row.recipeId]));
    expect(recipeOf.get(a)).toBe(recipeOf.get(b));
    expect(new Set([a, c, d, e, f, g, h].map((id) => recipeOf.get(id))).size).toBe(7);
    expect(new Set(recipeOf.values()).size).toBe(7);

    const recipes = (await client.query(`SELECT * FROM "Recipe" ORDER BY "name"`)).rows;
    expect(recipes.map((recipe) => recipe.name)).toEqual(["Finished show", "Morning show and 1 more", "Odd settings", "Other Workspace", "Short show", "Spanish show", "Spoken Spanish"]);
    // An unsupported language becomes "detect it", a supported one is normalized, and captioned-video settings are dropped.
    const odd = recipes.find((recipe) => recipe.id === recipeOf.get(g));
    expect(odd.languageCode).toBeNull();
    expect(odd.contentPack).toEqual({ ...pack(7), mode: "caption_only" });
    expect(recipes.find((recipe) => recipe.id === recipeOf.get(h)).languageCode).toBe("es");
    // Every migrated Recipe passes what a Recipe accepts now.
    for (const recipe of recipes) {
      expect(recipeInputSchema.safeParse({ name: recipe.name, languageCode: recipe.languageCode, contentPack: { ...recipe.contentPack, platformPlaybookVersion: "test" } }).success).toBe(true);
    }
    const shared = recipes.find((recipe) => recipe.id === recipeOf.get(a));
    expect(shared).toMatchObject({ workspaceId: first, brandProfileId: profile, languageCode: null, finishing: null, revision: 1, deletedAt: null, createdByUserId: user, updatedByUserId: user });
    expect(shared.contentPack).toEqual(pack(10));
    expect(recipes.find((recipe) => recipe.id === recipeOf.get(c)).finishing).toEqual(finishing);
    expect(recipes.find((recipe) => recipe.id === recipeOf.get(d)).languageCode).toBe("es");
    expect(recipes.find((recipe) => recipe.id === recipeOf.get(e))).toMatchObject({ brandProfileId: null, contentPack: pack(5) });
    // The same settings in another Workspace are that Workspace's own Recipe.
    expect(recipes.find((recipe) => recipe.id === recipeOf.get(f)).workspaceId).toBe(second);
  });

  test("rules lose the settings a Recipe now holds, and a Recipe in use can't be removed from under a rule", async () => {
    const columns = (await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'AutopilotRule'`, [schema])).rows.map((row) => row.column_name);
    for (const gone of ["brandProfileId", "languageCode", "contentPack", "finishing"]) expect(columns).not.toContain(gone);
    expect(columns).toContain("recipeId");
    await expect(client.query(`DELETE FROM "Recipe" WHERE "id" = (SELECT "recipeId" FROM "AutopilotRule" LIMIT 1)`)).rejects.toThrow();
  });
});
