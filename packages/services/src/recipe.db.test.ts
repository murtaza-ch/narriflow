import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { buildGenerationContentPack, creditDebitSeconds, MAX_RECIPES_PER_WORKSPACE, processingPeriodStart, type FinishingSettingsInput } from "@narriflow/validators";
import { AutopilotService } from "./autopilot.service";
import { generateClips, submitVideo } from "./integration-commands";
import { OperationIdempotencyConflictError } from "./operation-receipt";
import { onRecipeContentChanged, recipeService } from "./recipe.service";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const CREDENTIAL = { scopes: ["projects:read", "processing:write"] };
const FINISHING = { topClips: 2, minScore: 40, aspectRatios: ["9:16"], resolution: "1080p", copyPlatforms: [], delivery: "ready_to_review", queueAccountIds: [] } as const satisfies FinishingSettingsInput;

describeDb("Recipes on PostgreSQL", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const globalPrisma = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

  beforeAll(() => {
    if (!databaseUrl || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Integration DB tests require a disposable integration_test_ schema");
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    priorPrisma = globalPrisma.narriflowPrismaClient;
    globalPrisma.narriflowPrismaClient = prisma;
  });
  afterAll(async () => {
    globalPrisma.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function workspace(pricingTier: "business" | "creator" = "business") {
    const user = await prisma.user.create({ data: { clerkId: `recipe:${randomUUID()}` } });
    const created = await prisma.workspace.create({ data: { name: "Recipes", ownerUserId: user.id, pricingTier, members: { create: { userId: user.id, role: "owner" } } } });
    return { user, workspaceId: created.id, scope: { actorUserId: user.id, workspaceId: created.id } };
  }
  type Owner = Awaited<ReturnType<typeof workspace>>;
  const input = (name: string, clipCountTarget = 10, finishing: FinishingSettingsInput | null = null) =>
    ({ name, brandProfileId: null, contentPack: buildGenerationContentPack({ clipCountTarget }), finishing });

  describe("saving", () => {
    test("a Recipe starts at revision 1, every edit bumps it, and an edit made on a stale revision is refused", async () => {
      const owner = await workspace();
      const created = await recipeService.create(owner.scope, input("Weekly show"));
      expect(created).toMatchObject({ name: "Weekly show", revision: 1, brandProfileId: null, languageCode: null, finishing: null, ruleCount: 0 });

      const renamed = await recipeService.update(owner.scope, created.id, { expectedRevision: 1, name: "Weekly podcast", languageCode: "es" });
      expect(renamed).toMatchObject({ name: "Weekly podcast", languageCode: "es", revision: 2 });
      // Fields the edit did not send stay as they were.
      expect(renamed.contentPack.clipCountTarget).toBe(10);

      await expect(recipeService.update(owner.scope, created.id, { expectedRevision: 1, name: "Stale" })).rejects.toMatchObject({ code: "recipe_revision_conflict" });
      expect((await recipeService.get(owner.scope, created.id)).name).toBe("Weekly podcast");

      // Two editors on the same revision: exactly one wins.
      const race = await Promise.allSettled([
        recipeService.update(owner.scope, created.id, { expectedRevision: 2, name: "Editor A" }),
        recipeService.update(owner.scope, created.id, { expectedRevision: 2, name: "Editor B" }),
      ]);
      expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await recipeService.get(owner.scope, created.id)).revision).toBe(3);
    });

    test("duplicating keeps the settings under a new name and ID; deleting hides the Recipe but a rule's Recipe can't be deleted", async () => {
      const owner = await workspace();
      const original = await recipeService.create(owner.scope, input("Shorts", 7, FINISHING));
      const copy = await recipeService.duplicate(owner.scope, original.id);
      expect(copy).toMatchObject({ name: "Shorts (copy)", revision: 1, finishing: expect.objectContaining({ topClips: 2 }) });
      expect(copy.id).not.toBe(original.id);
      expect(copy.contentPack.clipCountTarget).toBe(7);

      const rule = await prisma.autopilotRule.create({ data: { workspaceId: owner.workspaceId, createdByUserId: owner.user.id, name: "Rule", rssUrl: "https://feeds.example.test/a.xml", recipeId: original.id } });
      expect((await recipeService.get(owner.scope, original.id)).ruleCount).toBe(1);
      await expect(recipeService.delete(owner.scope, original.id)).rejects.toMatchObject({ code: "recipe_in_use" });

      await prisma.autopilotRule.delete({ where: { id: rule.id } });
      await recipeService.delete(owner.scope, original.id);
      expect((await recipeService.list(owner.scope)).map((recipe) => recipe.id)).toEqual([copy.id]);
      await expect(recipeService.get(owner.scope, original.id)).rejects.toMatchObject({ code: "recipe_not_found" });
      await expect(recipeService.delete(owner.scope, original.id)).rejects.toMatchObject({ code: "recipe_not_found" });
      // The row stays for the receipts and Projects that named it.
      expect((await prisma.recipe.findUniqueOrThrow({ where: { id: original.id } })).deletedAt).not.toBeNull();
    });

    test("a Recipe is the Workspace's own: another Workspace and a viewer can't read or write it", async () => {
      const owner = await workspace();
      const other = await workspace();
      const recipe = await recipeService.create(owner.scope, input("Private"));
      await expect(recipeService.get(other.scope, recipe.id)).rejects.toMatchObject({ code: "recipe_not_found" });
      await expect(recipeService.update(other.scope, recipe.id, { expectedRevision: 1, name: "Mine" })).rejects.toMatchObject({ code: "recipe_not_found" });
      await expect(recipeService.delete(other.scope, recipe.id)).rejects.toMatchObject({ code: "recipe_not_found" });
      expect(await recipeService.list(other.scope)).toEqual([]);

      const viewer = await prisma.user.create({ data: { clerkId: `recipe-viewer:${randomUUID()}` } });
      await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: viewer.id, role: "viewer" } });
      const viewerScope = { actorUserId: viewer.id, workspaceId: owner.workspaceId };
      expect((await recipeService.list(viewerScope)).map((entry) => entry.id)).toEqual([recipe.id]);
      await expect(recipeService.create(viewerScope, input("Nope"))).rejects.toThrow();
      await expect(recipeService.delete(viewerScope, recipe.id)).rejects.toThrow();
    });

    test("finishing needs the plan that runs it, at Recipe save as at rule save; a Workspace holds a bounded number", async () => {
      const creator = await workspace("creator");
      const finishingRefusal = { code: "plan_feature_required", kind: "payment_required", details: { feature: "campaign.operations", currentTier: "creator", requiredTier: "pro" } };
      await expect(recipeService.create(creator.scope, input("Finished", 10, FINISHING))).rejects.toMatchObject(finishingRefusal);
      const plain = await recipeService.create(creator.scope, input("Plain"));
      await expect(recipeService.update(creator.scope, plain.id, { expectedRevision: 1, finishing: FINISHING })).rejects.toMatchObject(finishingRefusal);
      expect((await recipeService.get(creator.scope, plain.id)).revision).toBe(1);

      const owner = await workspace();
      await prisma.recipe.createMany({ data: Array.from({ length: MAX_RECIPES_PER_WORKSPACE }, (_, index) => ({ workspaceId: owner.workspaceId, name: `Recipe ${index}`, contentPack: buildGenerationContentPack() })) });
      await expect(recipeService.create(owner.scope, input("One too many"))).rejects.toMatchObject({ code: "recipe_limit_reached" });
    });
  });

  describe("a save that changes what rules do", () => {
    test("lists the rules whose member can't manage publishing when the Recipe starts proposing to a queue, and never blocks the save", async () => {
      const owner = await workspace();
      const demoted = await prisma.user.create({ data: { clerkId: `recipe-demoted:${randomUUID()}` } });
      await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: demoted.id, role: "editor" } });
      const account = await prisma.socialAccount.create({ data: { userId: owner.user.id, workspaceId: owner.workspaceId, platform: "youtube_shorts", providerAccountId: `recipe:${randomUUID()}`,
        displayName: "Shorts", accessTokenEncrypted: "encrypted-test-token" } });
      const recipe = await recipeService.create(owner.scope, input("Shared"));
      const service = new AutopilotService({ fetchFeed: async (rssUrl) => ({ title: "Feed", finalUrl: rssUrl, episodes: [], etag: null, lastModified: null, notModified: false }) });
      const mine = await service.createRule(owner.scope, { name: "Owner's rule", rssUrl: "https://feeds.example.test/a.xml", recipeId: recipe.id });
      const theirs = await service.createRule({ actorUserId: demoted.id, workspaceId: owner.workspaceId }, { name: "Member's rule", rssUrl: "https://feeds.example.test/b.xml", recipeId: recipe.id });
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: demoted.id } }, data: { role: "viewer" } });

      // Not proposing: nothing to warn about.
      expect((await recipeService.update(owner.scope, recipe.id, { expectedRevision: 1, name: "Shared, renamed" })).warnings).toEqual([]);
      const saved = await recipeService.update(owner.scope, recipe.id, { expectedRevision: 2,
        finishing: { ...FINISHING, delivery: "propose_to_queue", queueAccountIds: [account.id], copyPlatforms: ["youtube_shorts"] } });
      expect(saved.revision).toBe(3);
      expect(saved.finishing?.delivery).toBe("propose_to_queue");
      expect(saved.warnings).toEqual([{ code: "rules_cannot_propose", ruleIds: [theirs.id], ruleNames: ["Member's rule"] }]);
      expect(saved.warnings[0]!.ruleIds).not.toContain(mine.id);
      expect(typeof onRecipeContentChanged).toBe("function");
    });
  });

  describe("a request that names a Recipe", () => {
    const submit = (owner: Owner, key: string, recipeId: string, credential = CREDENTIAL) =>
      submitVideo(owner.scope, { url: URL, title: "From a Recipe", recipeId }, { clientIdempotencyKey: key }, credential);

    test("a retry after the Recipe is edited replays the original receipt; a new key uses the edit", async () => {
      const owner = await workspace();
      const recipe = await recipeService.create(owner.scope, input("Weekly show", 10));
      const key = `rest-${randomUUID()}`;

      const first = await submit(owner, key, recipe.id);
      expect(first).toMatchObject({ replayed: false, recipe: { id: recipe.id, revision: 1 } });
      const stored = await prisma.contentPack.findFirstOrThrow({ where: { projectId: first.projectId } });
      expect(stored).toMatchObject({ clipCountTarget: 10, draft: false });

      await recipeService.update(owner.scope, recipe.id, { expectedRevision: 1, contentPack: buildGenerationContentPack({ clipCountTarget: 4 }) });

      const retry = await submit(owner, key, recipe.id);
      expect(retry).toMatchObject({ replayed: true, projectId: first.projectId, operation: first.operation, recipe: { id: recipe.id, revision: 1 } });
      expect(await prisma.project.count({ where: { workspaceId: owner.workspaceId } })).toBe(1);
      // The accepted Project keeps the settings it froze.
      expect((await prisma.contentPack.findFirstOrThrow({ where: { projectId: first.projectId } })).clipCountTarget).toBe(10);
      // The stored result names the revision; the fingerprint holds only the ID.
      const receipt = await prisma.operationReceipt.findFirstOrThrow({ where: { workspaceId: owner.workspaceId, clientIdempotencyKey: key } });
      expect(receipt.result).toMatchObject({ recipe: { id: recipe.id, revision: 1 } });

      const next = await submit(owner, `rest-${randomUUID()}`, recipe.id);
      expect(next).toMatchObject({ replayed: false, recipe: { id: recipe.id, revision: 2 } });
      expect((await prisma.contentPack.findFirstOrThrow({ where: { projectId: next.projectId } })).clipCountTarget).toBe(4);
    });

    test("a retry after the Recipe is deleted still replays; a new key is told the Recipe is gone", async () => {
      const owner = await workspace();
      const recipe = await recipeService.create(owner.scope, input("Short lived"));
      const key = `rest-${randomUUID()}`;
      const first = await submit(owner, key, recipe.id);
      await recipeService.delete(owner.scope, recipe.id);
      expect(await submit(owner, key, recipe.id)).toMatchObject({ replayed: true, projectId: first.projectId });
      await expect(submit(owner, `rest-${randomUUID()}`, recipe.id)).rejects.toMatchObject({ code: "recipe_not_found" });
      expect(await prisma.project.count({ where: { workspaceId: owner.workspaceId } })).toBe(1);
    });

    test("the same key with another Recipe, or with inline settings, is a conflict; a Recipe beside inline settings is refused", async () => {
      const owner = await workspace();
      const [one, two] = [await recipeService.create(owner.scope, input("One")), await recipeService.create(owner.scope, input("Two"))];
      const key = `rest-${randomUUID()}`;
      await submit(owner, key, one.id);
      await expect(submit(owner, key, two.id)).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
      await expect(submitVideo(owner.scope, { url: URL, title: "From a Recipe", generation: {} }, { clientIdempotencyKey: key }, CREDENTIAL)).rejects.toBeInstanceOf(OperationIdempotencyConflictError);

      for (const inline of [{ generation: {} }, { finishing: { topClips: 2 } }, { brandProfileId: randomUUID() }]) {
        await expect(submitVideo(owner.scope, { url: URL, recipeId: one.id, ...inline }, { clientIdempotencyKey: `rest-${randomUUID()}` }, CREDENTIAL)).rejects.toMatchObject({ code: "recipe_with_inline_settings" });
      }
      expect(await prisma.project.count({ where: { workspaceId: owner.workspaceId } })).toBe(1);
    });

    test("the Recipe's language and finishing commit with the intake", async () => {
      const owner = await workspace();
      const recipe = await recipeService.create(owner.scope, { ...input("Spanish", 8, FINISHING), languageCode: "es" });
      const accepted = await submit(owner, `rest-${randomUUID()}`, recipe.id);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: accepted.projectId }, include: { contentPacks: true } });
      expect(project.languageCode).toBe("es");
      expect(project.brandProfileId).toBeNull();
      expect(project.contentPacks[0]).toMatchObject({ clipCountTarget: 8, finishing: expect.objectContaining({ topClips: 2, minScore: 40 }) });
    });

    test("finishing that proposes to the queue needs the publishing scope, checked as the Recipe is read", async () => {
      const owner = await workspace();
      const queued = await prisma.recipe.create({ data: { workspaceId: owner.workspaceId, name: "Queue", contentPack: buildGenerationContentPack(), finishing: { ...FINISHING, delivery: "propose_to_queue", queueAccountIds: [randomUUID()] } } });
      await expect(submit(owner, `rest-${randomUUID()}`, queued.id)).rejects.toMatchObject({ code: "scope_required", details: { scope: "publishing:write" } });
      expect(await prisma.project.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
    });

    test("saving an Autopilot rule on a queue-proposing Recipe needs the credential's publishing scope, before anything else is checked", async () => {
      const owner = await workspace();
      const queued = await prisma.recipe.create({ data: { workspaceId: owner.workspaceId, name: "Queue", contentPack: buildGenerationContentPack(), finishing: { ...FINISHING, delivery: "propose_to_queue", queueAccountIds: [randomUUID()] } } });
      const plain = await recipeService.create(owner.scope, input("Plain"));
      const service = new AutopilotService({ fetchFeed: async (rssUrl) => ({ title: "Feed", finalUrl: rssUrl, episodes: [], etag: null, lastModified: null, notModified: false }) });
      const rule = { name: "Rule", rssUrl: "https://feeds.example.test/scope.xml", recipeId: queued.id };
      const autopilotOnly = { scopes: ["autopilot:write"] };

      await expect(service.createRule(owner.scope, rule, { clientIdempotencyKey: randomUUID() }, autopilotOnly)).rejects.toMatchObject({ code: "scope_required", details: { scope: "publishing:write" } });
      expect(await prisma.autopilotRule.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
      // With the scope the credential gets past that check (the unconnected account then refuses the save).
      await expect(service.createRule(owner.scope, rule, { clientIdempotencyKey: randomUUID() }, { scopes: ["autopilot:write", "publishing:write"] })).rejects.not.toMatchObject({ code: "scope_required" });
      // Moving an existing rule onto it is the same save.
      const existing = await service.createRule(owner.scope, { ...rule, recipeId: plain.id }, { clientIdempotencyKey: randomUUID() }, autopilotOnly);
      await expect(service.updateRule(owner.scope, existing.id, { recipeId: queued.id }, autopilotOnly)).rejects.toMatchObject({ code: "scope_required" });
      expect((await prisma.autopilotRule.findUniqueOrThrow({ where: { id: existing.id } })).recipeId).toBe(plain.id);
    });

    test("a Recipe holding settings Narriflow no longer accepts is a typed refusal, not a failure", async () => {
      const owner = await workspace();
      const badLanguage = await prisma.recipe.create({ data: { workspaceId: owner.workspaceId, name: "Odd language", languageCode: "klingon", contentPack: buildGenerationContentPack() } });
      const captioned = await prisma.recipe.create({ data: { workspaceId: owner.workspaceId, name: "Captioned", contentPack: { ...buildGenerationContentPack({ mode: "caption_only" }), captionedVideo: { framing: "fit", aspectRatios: ["9:16"], resolution: "1080p", captions: { source: "auto" } } } } });
      for (const recipe of [badLanguage, captioned]) {
        await expect(recipeService.get(owner.scope, recipe.id)).rejects.toMatchObject({ code: "recipe_settings_invalid", kind: "conflict" });
        await expect(submit(owner, `rest-${randomUUID()}`, recipe.id)).rejects.toMatchObject({ code: "recipe_settings_invalid" });
      }
      expect(await prisma.project.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
    });

    test("a generation freezes the Recipe's finishing, and a retry after an edit replays that run", async () => {
      const owner = await workspace();
      const recipe = await recipeService.create(owner.scope, input("Generate", 6, FINISHING));
      const project = await prisma.project.create({ data: { workspaceId: owner.workspaceId, createdByUserId: owner.user.id, title: "Ready", sourceMediaUrl: "https://example.test/ready.mp4", sourceDurationSeconds: 60, ingestStatus: "ready" } });
      // Every accepted intake holds a credit reservation until speech-to-text settles it.
      await prisma.processingUsageReservation.create({ data: { projectId: project.id, workspaceId: owner.workspaceId, actorUserId: owner.user.id, intakeKind: "upload",
        periodStart: processingPeriodStart(new Date()), reservedSeconds: creditDebitSeconds(60) } });
      const key = `rest-${randomUUID()}`;
      const generate = () => generateClips(owner.scope, { projectId: project.id, recipeId: recipe.id, forceRegenerate: false }, { clientIdempotencyKey: key }, CREDENTIAL);

      const first = await generate();
      expect(first).toMatchObject({ replayed: false, recipe: { id: recipe.id, revision: 1 } });
      expect(await prisma.generationFinishing.findUniqueOrThrow({ where: { originRunId: first.operation.id } })).toMatchObject({ projectId: project.id, settings: expect.objectContaining({ topClips: 2, minScore: 40 }) });
      expect((await prisma.contentPack.findFirstOrThrow({ where: { projectId: project.id } })).clipCountTarget).toBe(6);

      await recipeService.update(owner.scope, recipe.id, { expectedRevision: 1, contentPack: buildGenerationContentPack({ clipCountTarget: 3 }), finishing: null });
      const retry = await generate();
      expect(retry).toMatchObject({ replayed: true, operation: first.operation, recipe: { id: recipe.id, revision: 1 } });
      expect(await prisma.generationFinishing.count({ where: { projectId: project.id } })).toBe(1);
    });

    test("only Recipes of the caller's Workspace resolve", async () => {
      const owner = await workspace();
      const other = await workspace();
      const foreign = await recipeService.create(other.scope, input("Elsewhere"));
      await expect(submit(owner, `rest-${randomUUID()}`, foreign.id)).rejects.toMatchObject({ code: "recipe_not_found" });
    });
  });
});
