import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { acceptedRecipe, contentPackSchema, finishingSettingsSchema } from "@narriflow/validators";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { readAutopilotImportSource } from "./autopilot-finishing-authority";
import { projectService } from "./project.service";
import { recipeService } from "./recipe.service";
import { ruleFingerprint } from "./standing-grant";
import { getIngestJobLifecycle } from "./ingest-job-lifecycle-runtime";
import { appendExecutionDispatch } from "./execution-dispatch";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Autopilot authority frozen at accepted source intake", () => {
  let db: PrismaClient;
  const context = createDatabaseTestContext();
  const scoped = <T>(run: () => Promise<T>) => bindServiceTestEnvironment(context.bind(run));
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6 }, { schema }) });
    context.client = db;
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `authority:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Frozen source authority", ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    const account = () => db.socialAccount.create({ data: { workspaceId: workspace.id, userId: user.id, platform: "youtube_shorts", providerAccountId: crypto.randomUUID(), displayName: "Synthetic", accessTokenEncrypted: "not-used", scopes: [] } });
    const first = await account(), second = await account();
    const finishing = finishingSettingsSchema.parse({ topClips: 1, delivery: "propose_to_queue", queueAccountIds: [first.id, second.id] });
    const pack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "test" });
    const recipe = await db.recipe.create({ data: { workspaceId: workspace.id, name: "Frozen authority", contentPack: pack, finishing, createdByUserId: user.id } });
    const rule = await db.autopilotRule.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, name: "Frozen authority", rssUrl: "https://feeds.example.test/authority", recipeId: recipe.id } });
    const fingerprint = (await ruleFingerprint(db, rule.id))!;
    const grant = await db.standingGrant.create({ data: { workspaceId: workspace.id, autopilotRuleId: rule.id, kind: "publish", socialAccountId: first.id, ruleFingerprint: fingerprint, dailyCap: 3, weeklyCap: 10, expiresAt: new Date(Date.now() + 86400_000), grantedByUserId: user.id } });
    const scope = { workspaceId: workspace.id, actorUserId: user.id };
    const source = await readAutopilotImportSource(db, rule);
    const resolved = await recipeService.resolve(scope, recipe.id);
    const input = { rssUrl: rule.rssUrl!, episodes: [{ id: crypto.randomUUID(), title: "Synthetic episode", enclosureUrl: "https://cdn.example.test/episode.mp3", durationSeconds: 60 }] };
    const options = { autopilotSource: source, generationContext: { contentPack: resolved.contentPack, languageCode: resolved.languageCode, finishing: resolved.finishing, recipe: acceptedRecipe(resolved) } };
    return { user, workspace, first, second, recipe, rule, grant, fingerprint, scope, source, input, options };
  }
  test("an accepted import freezes exact grant tuples and explicit absence, and replay cannot acquire a renewed grant", scoped(async () => {
    const f = await fixture();
    const admitted = await projectService.importResolvedRssEpisodes(f.scope, f.input, f.options);
    const pack = await db.contentPack.findFirstOrThrow({ where: { projectId: admitted.projects[0]!.project.id } });
    const expected = { sourceRuleFingerprint: f.fingerprint, publish: [{ socialAccountId: f.first.id, grant: { id: f.grant.id, revision: 1, ruleFingerprint: f.fingerprint } }, { socialAccountId: f.second.id, grant: null }], review: null };
    expect(pack.autopilotAuthority).toEqual(expected);
    await db.standingGrant.update({ where: { id: f.grant.id }, data: { revision: 2 } });
    expect((await projectService.importResolvedRssEpisodes(f.scope, f.input, f.options)).count).toBe(0);
    expect((await db.contentPack.findUniqueOrThrow({ where: { id: pack.id } })).autopilotAuthority).toEqual(expected);
  }));
  test("source authority cannot accompany settings different from the accepted Recipe", scoped(async () => {
    const f = await fixture();
    const changed = { ...f.options, generationContext: { ...f.options.generationContext, contentPack: { ...f.options.generationContext.contentPack, clipCountTarget: 9 } } };
    await expect(projectService.importResolvedRssEpisodes(f.scope, f.input, changed)).rejects.toMatchObject({ code: "autopilot_source_changed" });
    expect(await db.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await db.processingUsageReservation.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  }));
  test("a grant renewed or created during the source wait cannot replace the source's intended authority", scoped(async () => {
    const f = await fixture();
    await db.standingGrant.update({ where: { id: f.grant.id }, data: { revision: 2 } });
    await db.standingGrant.create({ data: { workspaceId: f.workspace.id, autopilotRuleId: f.rule.id, kind: "publish", socialAccountId: f.second.id, ruleFingerprint: f.fingerprint, dailyCap: 3, weeklyCap: 10, expiresAt: new Date(Date.now() + 86400_000), grantedByUserId: f.user.id } });
    const admitted = await projectService.importResolvedRssEpisodes(f.scope, f.input, f.options);
    const pack = await db.contentPack.findFirstOrThrow({ where: { projectId: admitted.projects[0]!.project.id } });
    expect(pack.autopilotAuthority).toEqual({ sourceRuleFingerprint: f.fingerprint, publish: [{ socialAccountId: f.first.id, grant: { id: f.grant.id, revision: 1, ruleFingerprint: f.fingerprint } }, { socialAccountId: f.second.id, grant: null }], review: null });
  }));
  test("a rule or Recipe edited during source fetch cannot grant the old import new authority", scoped(async () => {
    for (const change of ["rule", "recipe"] as const) {
      const f = await fixture();
      if (change === "rule") await db.autopilotRule.update({ where: { id: f.rule.id }, data: { titlePrefix: "Changed source" } });
      else await db.recipe.update({ where: { id: f.recipe.id }, data: { revision: 2, contentRevision: 2 } });
      await expect(projectService.importResolvedRssEpisodes(f.scope, f.input, f.options)).rejects.toMatchObject({ code: "autopilot_source_changed" });
      expect(await db.project.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.processingUsageReservation.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      if (change === "rule") await expect(readAutopilotImportSource(db, f.rule)).rejects.toMatchObject({ code: "autopilot_source_changed" });
    }
  }));
  test("review delivery freezes its own exact grant and never substitutes a later revision", scoped(async () => {
    const f = await fixture();
    const finishing = finishingSettingsSchema.parse({ topClips: 1, delivery: "send_review_round" });
    await db.recipe.update({ where: { id: f.recipe.id }, data: { revision: 2, contentRevision: 2, finishing } });
    const fingerprint = (await ruleFingerprint(db, f.rule.id))!;
    const grant = await db.standingGrant.create({ data: { workspaceId: f.workspace.id, autopilotRuleId: f.rule.id, kind: "review_send", revision: 4, ruleFingerprint: fingerprint, reviewerEmails: ["reviewer@example.test"], dailyCap: 2, weeklyCap: 5, expiresAt: new Date(Date.now() + 86400_000), grantedByUserId: f.user.id } });
    const recipe = await recipeService.resolve(f.scope, f.recipe.id);
    const options = { autopilotSource: await readAutopilotImportSource(db, f.rule), generationContext: { contentPack: recipe.contentPack, languageCode: recipe.languageCode, finishing: recipe.finishing, recipe: acceptedRecipe(recipe) } };
    const admitted = await projectService.importResolvedRssEpisodes(f.scope, f.input, options);
    const pack = await db.contentPack.findFirstOrThrow({ where: { projectId: admitted.projects[0]!.project.id } });
    expect(pack.autopilotAuthority).toEqual({ sourceRuleFingerprint: fingerprint, publish: [], review: { id: grant.id, revision: 4, ruleFingerprint: fingerprint } });
    await db.standingGrant.update({ where: { id: grant.id }, data: { revision: 5 } });
    await projectService.importResolvedRssEpisodes(f.scope, f.input, options);
    expect((await db.contentPack.findUniqueOrThrow({ where: { id: pack.id } })).autopilotAuthority).toEqual(pack.autopilotAuthority);
  }));
  test("the ingest handoff copies authority unchanged after renewal, and SQL forbids rewriting it", scoped(async () => {
    const f = await fixture();
    const admitted = await projectService.importResolvedRssEpisodes(f.scope, f.input, f.options);
    const projectId = admitted.projects[0]!.project.id, jobId = admitted.projects[0]!.queuedJobId;
    const pack = await db.contentPack.findFirstOrThrow({ where: { projectId } });
    await db.standingGrant.update({ where: { id: f.grant.id }, data: { revision: 2, status: "revoked" } });
    await db.project.update({ where: { id: projectId }, data: { ingestStatus: "ready", sourceDurationSeconds: 60, sourceProbe: { durationSec: 60, video: null, audio: null } } });
    const job = await db.ingestJob.update({ where: { id: jobId }, data: { status: "completed", completedAt: new Date() } });
    const dispatch = await db.$transaction(tx => appendExecutionDispatch(tx, { kind: "import_pipeline", subject: { kind: "ingest_job", id: job.id }, generation: job.generation, deploymentEpoch: job.deploymentEpoch, inputHash: "a".repeat(64), dueAt: job.createdAt }));
    const handoff = await db.$transaction(tx => getIngestJobLifecycle().handoffGenerationWithinTransaction(tx, dispatch.reference));
    expect(handoff.kind).toBe("admitted");
    const finishing = await db.generationFinishing.findFirstOrThrow({ where: { projectId } });
    expect(finishing.autopilotAuthority).toEqual(pack.autopilotAuthority);
    await expect(Promise.resolve(db.contentPack.update({ where: { id: pack.id }, data: { autopilotAuthority: { sourceRuleFingerprint: f.fingerprint, publish: [], review: null } } }))).rejects.toThrow("content pack Autopilot authority is immutable");
    await expect(Promise.resolve(db.contentPack.update({ where: { id: pack.id }, data: { recipe: { id: f.recipe.id, revision: 2 } } }))).rejects.toThrow("content pack Autopilot authority is immutable");
  }));
});
