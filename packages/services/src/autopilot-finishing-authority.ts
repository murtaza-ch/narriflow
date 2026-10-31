import type { AutopilotRule, Prisma, PrismaClient } from "@prisma/client";
import { autopilotFinishingAuthoritySchema, type AutopilotFinishingAuthority } from "@narriflow/validators/autopilot-finishing-authority";
import { recipeContentPackSchema, finishingSettingsSchema, type AcceptedRecipe, type ContentPack, type FinishingSettings } from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { ruleFingerprint } from "./standing-grant";
import { operationFingerprint } from "./operation-receipt";

type Tx = Prisma.TransactionClient;
type RuleSnapshot = Pick<AutopilotRule, "id" | "workspaceId" | "createdByUserId" | "recipeId" | "sourceKind" | "rssUrl" | "titlePrefix" | "zoomConnectionId" | "zoomTopicFilter">;
export type AutopilotImportSource = Readonly<{ ruleId: string; recipeId: string; recipeContentRevision: number; sourceRuleFingerprint: string }>;
export class AutopilotSourceChanged extends ExpectedDomainFailureError<"autopilot_source_changed"> {
  constructor() { super({ code: "autopilot_source_changed", kind: "conflict", message: "The Autopilot source settings changed before this import was accepted. Retry with the current settings." }); }
}

async function lockedRule(tx: Tx, workspaceId: string, recipeId: string, ruleId: string) {
  // Recipe edits take Recipe then Rule. Never invert that order during intake.
  await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${recipeId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id" = ${ruleId}::uuid AND "workspaceId" = ${workspaceId}::uuid FOR SHARE`;
  const rule = await tx.autopilotRule.findFirst({ where: { id: ruleId, workspaceId, recipeId, status: { in: ["active", "running"] }, recipe: { deletedAt: null } }, include: { recipe: true } });
  if (!rule) throw new AutopilotSourceChanged();
  return rule;
}

/** Capture before fetching a source. Lease renewals do not change this identity. */
export function readAutopilotImportSource(database: PrismaClient, expected: RuleSnapshot): Promise<AutopilotImportSource> {
  return database.$transaction(async tx => {
    const live = await lockedRule(tx, expected.workspaceId, expected.recipeId, expected.id);
    for (const key of ["createdByUserId", "sourceKind", "rssUrl", "titlePrefix", "zoomConnectionId", "zoomTopicFilter"] as const)
      if (live[key] !== expected[key]) throw new AutopilotSourceChanged();
    const fingerprint = await ruleFingerprint(tx, live.id);
    if (!fingerprint) throw new AutopilotSourceChanged();
    return { ruleId: live.id, recipeId: live.recipeId, recipeContentRevision: live.recipe.contentRevision, sourceRuleFingerprint: fingerprint };
  });
}

/** Run in the intake transaction, before any reservation or Project is created. */
export async function freezeAutopilotFinishingAuthority(tx: Tx, input: {
  workspaceId: string; actorUserId: string; source: AutopilotImportSource;
  recipe: AcceptedRecipe | null | undefined; finishing: FinishingSettings | null | undefined;
  contentPack: ContentPack | undefined; languageCode: string | null | undefined; brandProfileId: string | null;
}): Promise<AutopilotFinishingAuthority> {
  const { source } = input;
  const live = await lockedRule(tx, input.workspaceId, source.recipeId, source.ruleId);
  if (live.createdByUserId !== input.actorUserId || input.recipe?.id !== source.recipeId || input.recipe.revision !== live.recipe.revision || live.recipe.contentRevision !== source.recipeContentRevision || await ruleFingerprint(tx, live.id) !== source.sourceRuleFingerprint)
    throw new AutopilotSourceChanged();
  const acceptedSettings = { contentPack: input.contentPack, languageCode: input.languageCode ?? null, brandProfileId: input.brandProfileId, finishing: input.finishing ?? null };
  const recipeSettings = { contentPack: recipeContentPackSchema.parse(live.recipe.contentPack), languageCode: live.recipe.languageCode, brandProfileId: live.recipe.brandProfileId, finishing: live.recipe.finishing === null ? null : finishingSettingsSchema.parse(live.recipe.finishing) };
  if (operationFingerprint(acceptedSettings) !== operationFingerprint(recipeSettings)) throw new AutopilotSourceChanged();
  // Rule SHARE also serializes grant creation/renewal, whose first lock is Rule UPDATE.
  const destinations = input.finishing?.delivery === "propose_to_queue" ? input.finishing.queueAccountIds : [];
  const grants = await tx.standingGrant.findMany({ where: { workspaceId: input.workspaceId, autopilotRuleId: live.id, status: "active", expiresAt: { gt: new Date() }, ruleFingerprint: source.sourceRuleFingerprint,
    OR: [{ kind: "publish", socialAccountId: { in: destinations } }, ...(input.finishing?.delivery === "send_review_round" ? [{ kind: "review_send" as const }] : [])],
  }, take: 11, select: { id: true, revision: true, ruleFingerprint: true, kind: true, socialAccountId: true } });
  const tuple = (grant: typeof grants[number] | undefined) => grant ? { id: grant.id, revision: grant.revision, ruleFingerprint: grant.ruleFingerprint } : null;
  return autopilotFinishingAuthoritySchema.parse({
    sourceRuleFingerprint: source.sourceRuleFingerprint,
    publish: destinations.map(socialAccountId => ({ socialAccountId, grant: tuple(grants.find(grant => grant.kind === "publish" && grant.socialAccountId === socialAccountId)) })),
    review: input.finishing?.delivery === "send_review_round" ? tuple(grants.find(grant => grant.kind === "review_send")) : null,
  });
}
