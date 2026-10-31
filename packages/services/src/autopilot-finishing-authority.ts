import type { AutopilotRule, Prisma, PrismaClient } from "@prisma/client";
import { autopilotFinishingAuthoritySchema, type AutopilotFinishingAuthority } from "@narriflow/validators/autopilot-finishing-authority";
import { recipeContentPackSchema, finishingSettingsSchema, sourceLanguageCodeSchema, type AcceptedRecipe, type ContentPack, type FinishingSettings } from "@narriflow/validators";
import type { ResolvedRecipe } from "./recipe.service";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { ruleFingerprint } from "./standing-grant";
import { operationFingerprint } from "./operation-receipt";

type Tx = Prisma.TransactionClient;
type RuleSnapshot = Pick<AutopilotRule, "id" | "workspaceId" | "createdByUserId" | "recipeId" | "sourceKind" | "rssUrl" | "titlePrefix" | "zoomConnectionId" | "zoomTopicFilter">;
export type AutopilotImportSource = Readonly<{ ruleId: string; recipeId: string; recipeRevision: number; recipeContentRevision: number; sourceRuleFingerprint: string; authority: AutopilotFinishingAuthority }>;
export type AutopilotImportPlan = Readonly<{ source: AutopilotImportSource; recipe: ResolvedRecipe }>;
export class AutopilotSourceChanged extends ExpectedDomainFailureError<"autopilot_source_changed"> {
  constructor() { super({ code: "autopilot_source_changed", kind: "conflict", message: "The Autopilot source settings changed before this import was accepted. Retry with the current settings." }); }
}

async function lockedRule(tx: Tx, workspaceId: string, recipeId: string, ruleId: string, forUpdate = false) {
  // Recipe edits take Recipe then Rule. Never invert that order during intake.
  await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${recipeId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR SHARE`;
  if (forUpdate) await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR NO KEY UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR SHARE`;
  const rule = await tx.autopilotRule.findFirst({ where: { id: ruleId, workspaceId, recipeId, status: { in: ["active", "running"] }, recipe: { deletedAt: null } }, include: { recipe: true } });
  if (!rule) throw new AutopilotSourceChanged();
  return rule;
}

async function intendedAuthority(tx: Tx, rule: Awaited<ReturnType<typeof lockedRule>>, fingerprint: string, finishing: FinishingSettings | null): Promise<AutopilotFinishingAuthority> {
  const destinations = finishing?.delivery === "propose_to_queue" ? finishing.queueAccountIds : [];
  // Rule SHARE serializes grant creation/renewal, whose first lock is Rule UPDATE.
  const grants = await tx.standingGrant.findMany({ where: { workspaceId: rule.workspaceId, autopilotRuleId: rule.id, status: "active", expiresAt: { gt: new Date() }, ruleFingerprint: fingerprint,
    OR: [{ kind: "publish", socialAccountId: { in: destinations } }, ...(finishing?.delivery === "send_review_round" ? [{ kind: "review_send" as const }] : [])],
  }, take: 11, select: { id: true, revision: true, ruleFingerprint: true, kind: true, socialAccountId: true } });
  const tuple = (grant: typeof grants[number] | undefined) => grant ? { id: grant.id, revision: grant.revision, ruleFingerprint: grant.ruleFingerprint } : null;
  return autopilotFinishingAuthoritySchema.parse({ sourceRuleFingerprint: fingerprint,
    publish: destinations.map(socialAccountId => ({ socialAccountId, grant: tuple(grants.find(grant => grant.kind === "publish" && grant.socialAccountId === socialAccountId)) })),
    review: finishing?.delivery === "send_review_round" ? tuple(grants.find(grant => grant.kind === "review_send")) : null });
}

/** Freeze source settings and grant intent together before any source I/O.
 * Neither a lease heartbeat nor a later grant renewal replaces this intent. */
export function readAutopilotImportPlan(database: PrismaClient, expected: RuleSnapshot): Promise<AutopilotImportPlan> {
  return database.$transaction(tx => capturePlan(tx, expected, false));
}
/** Admit a cycle and its child probe under the same transaction. Recipe is
 * locked before Rule UPDATE, with no SHARE-to-UPDATE lock upgrade. */
export function lockAutopilotImportPlan(tx: Tx, expected: RuleSnapshot): Promise<AutopilotImportPlan> {
  return capturePlan(tx, expected, true);
}
async function capturePlan(tx: Tx, expected: RuleSnapshot, forUpdate: boolean): Promise<AutopilotImportPlan> {
    const live = await lockedRule(tx, expected.workspaceId, expected.recipeId, expected.id, forUpdate);
    for (const key of ["createdByUserId", "sourceKind", "rssUrl", "titlePrefix", "zoomConnectionId", "zoomTopicFilter"] as const)
      if (live[key] !== expected[key]) throw new AutopilotSourceChanged();
    const fingerprint = await ruleFingerprint(tx, live.id);
    if (!fingerprint) throw new AutopilotSourceChanged();
    const recipe: ResolvedRecipe = { id: live.recipe.id, revision: live.recipe.revision, brandProfileId: live.recipe.brandProfileId,
      languageCode: sourceLanguageCodeSchema.parse(live.recipe.languageCode), contentPack: recipeContentPackSchema.parse(live.recipe.contentPack),
      finishing: live.recipe.finishing === null ? null : finishingSettingsSchema.parse(live.recipe.finishing) };
    const authority = await intendedAuthority(tx, live, fingerprint, recipe.finishing);
    return { source: { ruleId: live.id, recipeId: live.recipeId, recipeRevision: recipe.revision, recipeContentRevision: live.recipe.contentRevision, sourceRuleFingerprint: fingerprint, authority }, recipe };
}
export async function readAutopilotImportSource(database: PrismaClient, expected: RuleSnapshot): Promise<AutopilotImportSource> {
  return (await readAutopilotImportPlan(database, expected)).source;
}

/** Run in the intake transaction, before any reservation or Project is created. */
export async function freezeAutopilotFinishingAuthority(tx: Tx, input: {
  workspaceId: string; actorUserId: string; source: AutopilotImportSource;
  recipe: AcceptedRecipe | null | undefined; finishing: FinishingSettings | null | undefined;
  contentPack: ContentPack | undefined; languageCode: string | null | undefined; brandProfileId: string | null;
}): Promise<AutopilotFinishingAuthority> {
  const { source } = input;
  const live = await lockedRule(tx, input.workspaceId, source.recipeId, source.ruleId);
  if (live.createdByUserId !== input.actorUserId || input.recipe?.id !== source.recipeId || input.recipe.revision !== source.recipeRevision || live.recipe.contentRevision !== source.recipeContentRevision || await ruleFingerprint(tx, live.id) !== source.sourceRuleFingerprint)
    throw new AutopilotSourceChanged();
  const acceptedSettings = { contentPack: input.contentPack, languageCode: input.languageCode ?? null, brandProfileId: input.brandProfileId, finishing: input.finishing ?? null };
  const recipeSettings = { contentPack: recipeContentPackSchema.parse(live.recipe.contentPack), languageCode: live.recipe.languageCode, brandProfileId: live.recipe.brandProfileId, finishing: live.recipe.finishing === null ? null : finishingSettingsSchema.parse(live.recipe.finishing) };
  if (operationFingerprint(acceptedSettings) !== operationFingerprint(recipeSettings)) throw new AutopilotSourceChanged();
  // Preserve the source's original authority even if a grant was added or renewed
  // while its native probe ran. Finishing rechecks each exact tuple before use.
  const authority = autopilotFinishingAuthoritySchema.parse(source.authority);
  const destinations = input.finishing?.delivery === "propose_to_queue" ? input.finishing.queueAccountIds : [];
  if (authority.sourceRuleFingerprint !== source.sourceRuleFingerprint || JSON.stringify(authority.publish.map(item => item.socialAccountId)) !== JSON.stringify(destinations) || input.finishing?.delivery !== "send_review_round" && authority.review !== null)
    throw new AutopilotSourceChanged();
  return authority;
}
