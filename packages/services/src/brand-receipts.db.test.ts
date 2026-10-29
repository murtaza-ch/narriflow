import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import { Pool } from "pg";
import { brandProfileService } from "./brand-profile.service";
import { brandTemplateService } from "./brand-template.service";
import { sceneTemplateService } from "./scene-template.service";

/**
 * Retryable Brand Kit creates (profile, caption style, style duplicate, scene)
 * are Operation Receipts: one durable acceptance per key, replay before any new
 * work, and the limiter outcome enforced only for a genuinely new acceptance.
 * Runs under the Brand Profile disposable-schema gate.
 */
const databaseUrl = process.env.BRAND_PROFILE_TEST_DATABASE_URL;
const databaseSchema = process.env.BRAND_PROFILE_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_BRAND_PROFILE_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Brand Kit create receipts (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Brand Profile test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture(label: string, tier = "business", personal = false) {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `receipt-${label}-${suffix}`, primaryEmail: `receipt-${label}-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({
      data: {
        name: `Receipts ${label}`,
        ownerUserId: user.id,
        personalOwnerUserId: personal ? user.id : null,
        pricingTier: tier,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    return {
      user,
      workspace,
      scope: {
        actorUserId: user.id,
        workspaceId: workspace.id,
        workspaceOwnerUserId: user.id,
        role: "owner" as const,
        status: "active" as const,
        pricingTier: tier,
        isPersonalWorkspace: personal,
      },
    };
  }

  const mutation = (key: string, beforeAccept?: () => Promise<void>) => ({ clientIdempotencyKey: key, beforeAccept });

  test("a profile create replays under its key and never makes a second profile", async () => {
    const f = await fixture("profile-replay");
    const input = { name: "Acme", slug: "acme" };
    const first = await brandProfileService.create(f.scope, input, mutation("profile-key-1"));
    const replay = await brandProfileService.create(f.scope, input, mutation("profile-key-1"));
    expect(replay.id).toBe(first.id);
    expect(await prisma.brandProfile.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    // The receipt keeps the profile as created, without expiring signed URLs.
    const receipt = await prisma.operationReceipt.findFirstOrThrow({ where: { workspaceId: f.workspace.id, command: "create_brand_profile" } });
    expect(receipt.result).toMatchObject({ id: first.id, name: "Acme", slug: "acme", assets: [], fonts: [] });
    expect(JSON.stringify(receipt.result)).not.toContain("X-Amz");
    expect(receipt.resourceType).toBe("brand_profile");
    expect(receipt.actorUserId).toBe(f.user.id);
  });

  test("the same key with other input conflicts; a new key is new work", async () => {
    const f = await fixture("profile-conflict");
    await brandProfileService.create(f.scope, { name: "One", slug: "one" }, mutation("key-a"));
    await expect(brandProfileService.create(f.scope, { name: "Other", slug: "other" }, mutation("key-a")))
      .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    const second = await brandProfileService.create(f.scope, { name: "Two", slug: "two" }, mutation("key-b"));
    expect(second.name).toBe("Two");
    expect(await prisma.brandProfile.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
  });

  test("simultaneous requests with one key accept once", async () => {
    const f = await fixture("profile-race");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => brandProfileService.create(f.scope, { name: "Race", slug: "race" }, mutation("race-key"))),
    );
    expect(new Set(results.map((profile) => profile.id)).size).toBe(1);
    expect(await prisma.brandProfile.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.operationReceipt.count({ where: { workspaceId: f.workspace.id, command: "create_brand_profile" } })).toBe(1);
  });

  test("the limiter outcome is enforced for new work and skipped on replay", async () => {
    const f = await fixture("profile-limiter");
    const refuse = mock429();
    await expect(brandProfileService.create(f.scope, { name: "Held", slug: "held" }, mutation("limited", refuse)))
      .rejects.toMatchObject({ code: "rate_limited" });
    expect(await prisma.brandProfile.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    // Accepted once, the same key replays even though the limiter would now refuse.
    const accepted = await brandProfileService.create(f.scope, { name: "Held", slug: "held" }, mutation("limited"));
    const replay = await brandProfileService.create(f.scope, { name: "Held", slug: "held" }, mutation("limited", refuse));
    expect(replay.id).toBe(accepted.id);
  });

  test("a replay is authorized against current membership", async () => {
    const f = await fixture("profile-removed");
    await brandProfileService.create(f.scope, { name: "Mine", slug: "mine" }, mutation("removed-key"));
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: f.workspace.id, userId: f.user.id } });
    await expect(brandProfileService.create(f.scope, { name: "Mine", slug: "mine" }, mutation("removed-key")))
      .rejects.toMatchObject({ code: "workspace_access_denied" });
  });

  test("a plan limit refusal leaves no receipt, so the key can be used once there is room", async () => {
    const f = await fixture("profile-limit", "pro", true);
    for (let index = 0; index < 4; index += 1) {
      await prisma.brandProfile.create({ data: { userId: f.user.id, createdByUserId: f.user.id, updatedByUserId: f.user.id, name: `P${index}`, slug: `p${index}`, visualIdentity: {}, voiceGuidance: {} } });
    }
    await expect(brandProfileService.create(f.scope, { name: "Fifth", slug: "fifth" }, mutation("full")))
      .rejects.toMatchObject({ code: "plan_limit_reached" });
    expect(await prisma.operationReceipt.count({ where: { workspaceId: f.workspace.id, command: "create_brand_profile" } })).toBe(0);
  });

  test("a style create and a duplicate replay with the style itself", async () => {
    const f = await fixture("styles");
    const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id };
    const input = { name: "Mine", captionPreset: DEFAULT_CAPTION_PRESET };
    const first = await brandTemplateService.create(scope, input as never, mutation("style-1"));
    const replay = await brandTemplateService.create(scope, input as never, mutation("style-1"));
    expect(replay).toEqual(first);
    expect(await prisma.brandTemplate.count({ where: { workspaceId: f.workspace.id, isBuiltIn: false } })).toBe(1);

    const copy = await brandTemplateService.duplicate(scope, first.id, "Copy", mutation("dup-1"));
    expect(await brandTemplateService.duplicate(scope, first.id, "Copy", mutation("dup-1"))).toEqual(copy);
    await expect(brandTemplateService.duplicate(scope, first.id, "Renamed copy", mutation("dup-1")))
      .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    expect(await prisma.brandTemplate.count({ where: { workspaceId: f.workspace.id, isBuiltIn: false } })).toBe(2);
    // Create and duplicate keep separate receipts even for the same caller key.
    const sameKey = await brandTemplateService.duplicate(scope, first.id, "Third", mutation("style-1"));
    expect(sameKey.id).not.toBe(first.id);
  });

  test("simultaneous style creates under one key accept once", async () => {
    const f = await fixture("style-race");
    const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id };
    const input = { name: "Raced", captionPreset: DEFAULT_CAPTION_PRESET };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => brandTemplateService.create(scope, input as never, mutation("style-race"))),
    );
    expect(new Set(results.map((style) => style.id)).size).toBe(1);
    expect(await prisma.brandTemplate.count({ where: { workspaceId: f.workspace.id, isBuiltIn: false } })).toBe(1);
  });

  test("a scene create replays and its default pointer moves once", async () => {
    const f = await fixture("scenes");
    const profile = await brandProfileService.create(f.scope, { name: "Scenes", slug: "scenes" }, mutation("scene-profile"));
    const input = {
      name: "Intro",
      role: "intro" as const,
      makeDefault: true,
      definition: {
        schemaVersion: 1,
        durationSec: 2,
        content: { kind: "color", color: "#1D4ED8" },
        motion: { entrance: "none", exit: "none", durationSec: 0.5 },
      },
    };
    const first = await sceneTemplateService.create(f.scope, profile.id, input, mutation("scene-1"));
    const replay = await sceneTemplateService.create(f.scope, profile.id, input, mutation("scene-1"));
    expect(replay.id).toBe(first.id);
    expect(await prisma.sceneTemplate.count({ where: { profileId: profile.id } })).toBe(1);
    // The default moved with the first acceptance only: one revision step for the pointer.
    expect((await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } })).revision).toBe(profile.revision + 1);
    await expect(sceneTemplateService.create(f.scope, profile.id, { ...input, name: "Other" }, mutation("scene-1")))
      .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
  });

  test("simultaneous scene creates under one key accept once", async () => {
    const f = await fixture("scene-race");
    const profile = await brandProfileService.create(f.scope, { name: "Raced", slug: "raced" }, mutation("race-profile"));
    const input = {
      name: "Inline",
      role: "inline" as const,
      definition: {
        schemaVersion: 1,
        durationSec: 2,
        content: { kind: "color", color: "#1D4ED8" },
        motion: { entrance: "none", exit: "none", durationSec: 0.5 },
      },
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => sceneTemplateService.create(f.scope, profile.id, input, mutation("scene-race"))),
    );
    expect(new Set(results.map((scene) => scene.id)).size).toBe(1);
    expect(await prisma.sceneTemplate.count({ where: { profileId: profile.id } })).toBe(1);
  });

  // Sol wave-B B02: a replay answers from the receipt, never from mutable state.
  describe("replays ignore later changes to the source, the plan and the profile", () => {
    const sceneInput = {
      name: "Intro",
      role: "intro" as const,
      makeDefault: true,
      definition: {
        schemaVersion: 1,
        durationSec: 2,
        content: { kind: "color", color: "#1D4ED8" },
        motion: { entrance: "none", exit: "none", durationSec: 0.5 },
      },
    };
    const downgrade = (f: Awaited<ReturnType<typeof fixture>>) =>
      prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "free" } });

    test("a duplicate replays after its source was deleted", async () => {
      const f = await fixture("dup-deleted");
      const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id };
      const source = await brandTemplateService.create(scope, { name: "Source", captionPreset: DEFAULT_CAPTION_PRESET } as never, mutation("src"));
      const copy = await brandTemplateService.duplicate(scope, source.id, "Copy", mutation("dup-del"));
      await prisma.brandTemplate.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
      expect(await brandTemplateService.duplicate(scope, source.id, "Copy", mutation("dup-del"))).toEqual(copy);
      await expect(brandTemplateService.duplicate(scope, source.id, "Other", mutation("dup-del")))
        .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    });

    test("style create and duplicate replay after a downgrade; a changed body still conflicts", async () => {
      const f = await fixture("style-downgrade");
      const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id };
      const input = { name: "Mine", captionPreset: DEFAULT_CAPTION_PRESET };
      const first = await brandTemplateService.create(scope, input as never, mutation("style-dg"));
      const copy = await brandTemplateService.duplicate(scope, first.id, "Copy", mutation("dup-dg"));
      await downgrade(f);
      expect(await brandTemplateService.create(scope, input as never, mutation("style-dg"))).toEqual(first);
      expect(await brandTemplateService.duplicate(scope, first.id, "Copy", mutation("dup-dg"))).toEqual(copy);
      await expect(brandTemplateService.create(scope, { ...input, name: "Changed" } as never, mutation("style-dg")))
        .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
      // New work is still refused on the downgraded plan.
      await expect(brandTemplateService.create(scope, input as never, mutation("style-new")))
        .rejects.toMatchObject({ code: "plan_feature_required" });
    });

    test("a profile create replays as created after a downgrade, a later edit and a deletion", async () => {
      const f = await fixture("profile-downgrade");
      const input = { name: "Acme", slug: "acme" };
      const first = await brandProfileService.create(f.scope, input, mutation("profile-dg"));
      await downgrade(f);
      const downgraded = { ...f.scope, pricingTier: "free" };
      expect(await brandProfileService.create(downgraded, input, mutation("profile-dg"))).toEqual(first);
      await expect(brandProfileService.create(downgraded, { name: "Changed", slug: "acme" }, mutation("profile-dg")))
        .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
      await prisma.brandProfile.update({ where: { id: first.id }, data: { name: "Renamed" } });
      expect((await brandProfileService.create(downgraded, input, mutation("profile-dg"))).name).toBe("Acme");
      await prisma.brandProfile.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
      expect(await brandProfileService.create(downgraded, input, mutation("profile-dg"))).toEqual(first);
      await expect(brandProfileService.create(downgraded, { name: "New", slug: "new" }, mutation("profile-new")))
        .rejects.toMatchObject({ code: "plan_feature_required" });
    });

    test("a scene create replays after a downgrade", async () => {
      const f = await fixture("scene-downgrade");
      const profile = await brandProfileService.create(f.scope, { name: "Scenes", slug: "scenes" }, mutation("scene-dg-profile"));
      const first = await sceneTemplateService.create(f.scope, profile.id, sceneInput, mutation("scene-dg"));
      await downgrade(f);
      const downgraded = { ...f.scope, pricingTier: "free" };
      const replay = await sceneTemplateService.create(downgraded, profile.id, sceneInput, mutation("scene-dg"));
      expect(replay.id).toBe(first.id);
      await expect(sceneTemplateService.create(downgraded, profile.id, { ...sceneInput, name: "Other" }, mutation("scene-dg")))
        .rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    });
  });

  test("listAll returns every live profile past the ordinary 24-row page", async () => {
    const f = await fixture("list-all");
    await prisma.brandProfile.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        workspaceId: f.workspace.id,
        createdByUserId: f.user.id,
        updatedByUserId: f.user.id,
        name: `Profile ${index}`,
        slug: `profile-${index}`,
        visualIdentity: {},
        voiceGuidance: {},
      })),
    });
    expect(await brandProfileService.list(f.scope)).toHaveLength(24);
    const all = await brandProfileService.listAll(f.scope);
    expect(all).toHaveLength(30);
    expect(new Set(all.map((profile) => profile.id)).size).toBe(30);
  });
});

function mock429() {
  return async () => {
    const { ExpectedDomainFailureError } = await import("./expected-domain-failure");
    throw new ExpectedDomainFailureError({
      code: "rate_limited",
      kind: "rate_limited",
      message: "Too many requests. Wait before trying again.",
      retryAfterSeconds: 30,
    });
  };
}
