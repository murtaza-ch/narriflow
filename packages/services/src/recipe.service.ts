import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  finishingSettingsSchema,
  MAX_RECIPES_PER_WORKSPACE,
  recipeContentPackSchema,
  recipeInputSchema,
  recipeUpdateSchema,
  sourceLanguageCodeSchema,
  workspaceAllowsCapability,
  type ContentPack,
  type FinishingSettings,
  type RecipeInput,
  type RecipeSaveResult,
  type RecipeSnapshot,
  type RecipeUpdate,
  type RecipeWarning,
  type WorkspaceAccessStatus,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { brandProfileService } from "./brand-profile.service";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { requireQueueDeliveryScope } from "./integration-admission";
import { requirePlanFeature } from "./plan-features";
import { assertFinishingQueue } from "./publishing-queue.service";
import { onRecipeContentChanged } from "./recipe-content-change";
import { workspaceService } from "./workspace.service";
import { flushWorkspaceEvents } from "./workspace-event";

const recipeFailureCatalog = {
  recipe_not_found: "missing",
  recipe_revision_conflict: "conflict",
  recipe_in_use: "conflict",
  recipe_limit_reached: "conflict",
  recipe_settings_invalid: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type RecipeFailureCode = keyof typeof recipeFailureCatalog;

const recipeFailureMessages: Record<RecipeFailureCode, string> = {
  recipe_not_found: "This Recipe doesn't exist in the Workspace, or it was deleted. List Recipes for current IDs.",
  recipe_revision_conflict: "Someone else changed this Recipe. Reload it and apply your edit again.",
  recipe_in_use: "An Autopilot rule imports with this Recipe. Move the rule to another Recipe or delete it first.",
  recipe_limit_reached: `A Workspace can have ${MAX_RECIPES_PER_WORKSPACE} Recipes. Delete one you no longer use.`,
  recipe_settings_invalid: "This Recipe holds settings Narriflow no longer accepts, such as an unsupported language. Open it in Narriflow, correct the settings, and save it.",
};

export class RecipeError extends ExpectedDomainFailureError<RecipeFailureCode> {
  constructor(code: RecipeFailureCode) {
    super({ code, kind: recipeFailureCatalog[code], message: recipeFailureMessages[code] });
    this.name = "RecipeError";
  }
}

/** A Recipe as work consumes it: the settings plus the revision they were read at. */
export interface ResolvedRecipe {
  id: string;
  revision: number;
  brandProfileId: string | null;
  languageCode: string | null;
  contentPack: ContentPack;
  finishing: FinishingSettings | null;
}

/** A new Recipe, checked and ready to insert. */
export interface PlannedRecipe {
  name: string;
  brandProfileId: string | null;
  languageCode: string | null;
  contentPack: ContentPack;
  finishing: FinishingSettings | null;
}

/** A request that names a Recipe. `resolve` reads it when the request is
 * accepted, after any replay lookup, so honest retries replay instead of
 * seeing a Recipe someone edited since. */
export interface RecipeUse {
  id: string;
  resolve(): Promise<ResolvedRecipe>;
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

type RecipeRow = {
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  brandProfileId: string | null;
  languageCode: string | null;
  contentPack: unknown;
  finishing: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** The settings a Recipe holds, checked against what a Recipe may hold now.
 * Settings saved under older rules that no longer pass are a typed refusal
 * for the caller, not an unexpected failure. */
function resolved(row: RecipeRow): ResolvedRecipe {
  const contentPack = recipeContentPackSchema.safeParse(row.contentPack);
  const languageCode = sourceLanguageCodeSchema.safeParse(row.languageCode);
  const finishing = row.finishing ? finishingSettingsSchema.safeParse(row.finishing) : null;
  if (!contentPack.success || !languageCode.success || (finishing && !finishing.success)) throw new RecipeError("recipe_settings_invalid");
  return {
    id: row.id,
    revision: row.revision,
    brandProfileId: row.brandProfileId,
    languageCode: languageCode.data,
    contentPack: contentPack.data,
    finishing: finishing?.success ? finishing.data : null,
  };
}

function toSnapshot(row: RecipeRow & { _count?: { autopilotRules: number } }): RecipeSnapshot {
  return {
    ...resolved(row),
    workspaceId: row.workspaceId,
    name: row.name,
    ruleCount: row._count?.autopilotRules ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const withRuleCount = { _count: { select: { autopilotRules: true } } } as const;

/** Locks a live Recipe so a rule can point at it without a concurrent delete
 * slipping in between. Delete takes the same row for update. */
export async function lockLiveRecipe(tx: Prisma.TransactionClient, workspaceId: string, recipeId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Recipe"
    WHERE "id" = ${recipeId}::uuid AND "workspaceId" = ${workspaceId}::uuid AND "deletedAt" IS NULL
    FOR SHARE`;
  if (rows.length === 0) throw new RecipeError("recipe_not_found");
}

export class RecipeService {
  async list(scope: ActorScope): Promise<RecipeSnapshot[]> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const rows = await requirePrisma().recipe.findMany({
      where: { workspaceId: scope.workspaceId, deletedAt: null },
      include: withRuleCount,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: MAX_RECIPES_PER_WORKSPACE,
    });
    return rows.map(toSnapshot);
  }

  async get(scope: ActorScope, recipeId: string): Promise<RecipeSnapshot> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    return toSnapshot(await this.requireRow(scope.workspaceId, recipeId));
  }

  /** Reads a Recipe for work that uses its settings. The caller has already
   * been admitted for that work. */
  async resolve(scope: ActorScope, recipeId: string): Promise<ResolvedRecipe> {
    return resolved(await this.requireRow(scope.workspaceId, recipeId));
  }

  /** Refuses a Recipe whose settings this actor couldn't save: finishing
   * needs the plan and queue rights, and the Brand Profile must apply now.
   * Rule saves and Recipe saves both run it, so a rule never runs settings
   * its saver couldn't have chosen. */
  async requireUsable(scope: ActorScope, recipe: Pick<ResolvedRecipe, "brandProfileId" | "finishing">) {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    if (recipe.finishing) requirePlanFeature(actor.pricingTier, "campaign.operations");
    // Review Rounds are what the standing grant sends; below Review Rooms the
    // step could only be skipped. A Recipe saved before a downgrade still runs
    // and ends ready to review with `review_not_sent_plan`.
    if (recipe.finishing?.delivery === "send_review_round") requirePlanFeature(actor.pricingTier, "review.rooms");
    await assertFinishingQueue(scope, recipe.finishing);
    if (recipe.brandProfileId) await brandProfileService.requireApplicableId(actor, recipe.brandProfileId);
  }

  /** The Recipe a rule is being pointed at, checked as the rule's saver. A
   * credential (MCP) that saves a rule whose Recipe proposes to the queue needs
   * the publishing scope too: the rule will act in publishing state. */
  async resolveForRule(scope: ActorScope, recipeId: string, credential?: { scopes: readonly string[] }): Promise<ResolvedRecipe> {
    const recipe = await this.resolve(scope, recipeId);
    if (credential) requireQueueDeliveryScope(credential, recipe.finishing);
    await this.requireUsable(scope, recipe);
    return recipe;
  }

  async create(scope: ActorScope, input: RecipeInput): Promise<RecipeSnapshot> {
    const plan = await this.planCreate(scope, input);
    return requirePrisma().$transaction((tx) => this.insertPlanned(tx, scope, plan));
  }

  /** Checks a new Recipe and settles what it will hold, without writing. A
   * receipt-backed create plans after its replay lookup and inserts in its own
   * transaction. An omitted Brand Profile freezes the Workspace default onto
   * the Recipe now, so a later default change doesn't move it; null means none. */
  async planCreate(scope: ActorScope, input: RecipeInput): Promise<PlannedRecipe> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const parsed = recipeInputSchema.parse(input);
    const brandProfileId = parsed.brandProfileId === undefined ? await brandProfileService.getApplicableDefaultId(actor) : parsed.brandProfileId;
    const finishing = parsed.finishing ?? null;
    await this.requireUsable(scope, { brandProfileId, finishing });
    return { name: parsed.name, brandProfileId, languageCode: parsed.languageCode ?? null, contentPack: parsed.contentPack, finishing };
  }

  /** Inserts a planned Recipe, serializing the Workspace's Recipe budget with the write. */
  async insertPlanned(tx: Prisma.TransactionClient, scope: ActorScope, plan: PlannedRecipe): Promise<RecipeSnapshot> {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${scope.workspaceId}::uuid FOR UPDATE`;
    if ((await tx.recipe.count({ where: { workspaceId: scope.workspaceId, deletedAt: null } })) >= MAX_RECIPES_PER_WORKSPACE) {
      throw new RecipeError("recipe_limit_reached");
    }
    const row = await tx.recipe.create({
      data: {
        workspaceId: scope.workspaceId,
        name: plan.name,
        brandProfileId: plan.brandProfileId,
        languageCode: plan.languageCode,
        contentPack: plan.contentPack as unknown as Prisma.InputJsonValue,
        ...(plan.finishing && { finishing: plan.finishing }),
        createdByUserId: scope.actorUserId,
        updatedByUserId: scope.actorUserId,
      },
      include: withRuleCount,
    });
    return toSnapshot(row);
  }

  /** Saves an edit on top of the revision the editor read. Rules and requests
   * that use the Recipe see it from their next run; work already accepted
   * keeps the settings it froze. */
  async update(scope: ActorScope, recipeId: string, input: RecipeUpdate): Promise<RecipeSaveResult> {
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const parsed = recipeUpdateSchema.parse(input);
    const existing = await this.requireRow(scope.workspaceId, recipeId);
    if (existing.revision !== parsed.expectedRevision) throw new RecipeError("recipe_revision_conflict");
    // Check what this edit sets: a Recipe whose Brand Profile is gone can still
    // be renamed, and choosing another profile is what fixes it.
    await this.requireUsable(scope, {
      brandProfileId: parsed.brandProfileId && parsed.brandProfileId !== existing.brandProfileId ? parsed.brandProfileId : null,
      finishing: parsed.finishing ?? null,
    });
    const prisma = requirePrisma();
    // A rename is not content: it moves the edit revision but not the content revision.
    const contentChanged = parsed.brandProfileId !== undefined || parsed.languageCode !== undefined || parsed.contentPack !== undefined || parsed.finishing !== undefined;
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.recipe.updateMany({
        where: { id: recipeId, workspaceId: scope.workspaceId, deletedAt: null, revision: parsed.expectedRevision },
        data: {
          ...(parsed.name !== undefined && { name: parsed.name }),
          ...(parsed.brandProfileId !== undefined && { brandProfileId: parsed.brandProfileId }),
          ...(parsed.languageCode !== undefined && { languageCode: parsed.languageCode }),
          ...(parsed.contentPack !== undefined && { contentPack: parsed.contentPack as unknown as Prisma.InputJsonValue }),
          ...(parsed.finishing !== undefined && { finishing: parsed.finishing ?? Prisma.DbNull }),
          revision: { increment: 1 },
          ...(contentChanged && { contentRevision: { increment: 1 } }),
          updatedByUserId: scope.actorUserId,
        },
      });
      if (updated.count !== 1) throw new RecipeError("recipe_revision_conflict");
      if (contentChanged) {
        const rules = await tx.autopilotRule.findMany({ where: { recipeId }, select: { id: true } });
        await onRecipeContentChanged(tx, rules.map((rule) => rule.id));
        // Counter last: the events grants queued are written after every lock.
        await flushWorkspaceEvents(tx);
      }
      return tx.recipe.findUniqueOrThrow({ where: { id: recipeId }, include: withRuleCount });
    });
    const snapshot = toSnapshot(row);
    return { ...snapshot, warnings: await this.warningsFor(snapshot, actor.status) };
  }

  /** Rules run as the member who saved them. When the Recipe now proposes
   * posts to a queue, say which rules have a member who can't manage
   * publishing: those rules will finish without proposing. Never blocks a save. */
  private async warningsFor(recipe: RecipeSnapshot, status: WorkspaceAccessStatus): Promise<RecipeWarning[]> {
    if (recipe.finishing?.delivery !== "propose_to_queue") return [];
    const prisma = requirePrisma();
    const rules = await prisma.autopilotRule.findMany({
      where: { recipeId: recipe.id },
      select: { id: true, name: true, createdByUserId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: recipe.workspaceId, userId: { in: rules.flatMap((rule) => (rule.createdByUserId ? [rule.createdByUserId] : [])) }, user: { deletedAt: null } },
      select: { userId: true, role: true },
    });
    const may = new Set(members.filter((member) => workspaceAllowsCapability({ role: member.role, status }, "publishing.manage")).map((member) => member.userId));
    const lacking = rules.filter((rule) => !rule.createdByUserId || !may.has(rule.createdByUserId));
    return lacking.length === 0 ? [] : [{ code: "rules_cannot_propose", ruleIds: lacking.map((rule) => rule.id), ruleNames: lacking.map((rule) => rule.name) }];
  }

  async duplicate(scope: ActorScope, recipeId: string): Promise<RecipeSnapshot> {
    const plan = await this.planDuplicate(scope, recipeId);
    return requirePrisma().$transaction((tx) => this.insertPlanned(tx, scope, plan));
  }

  /** The copy a duplicate would save, checked like any new Recipe. */
  async planDuplicate(scope: ActorScope, recipeId: string): Promise<PlannedRecipe> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const source = await this.requireRow(scope.workspaceId, recipeId);
    const settings = resolved(source);
    return this.planCreate(scope, {
      name: `${source.name.slice(0, 112)} (copy)`,
      brandProfileId: settings.brandProfileId,
      languageCode: settings.languageCode as RecipeInput["languageCode"],
      contentPack: settings.contentPack,
      finishing: settings.finishing,
    });
  }

  async delete(scope: ActorScope, recipeId: string): Promise<void> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    await requirePrisma().$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Recipe"
        WHERE "id" = ${recipeId}::uuid AND "workspaceId" = ${scope.workspaceId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) throw new RecipeError("recipe_not_found");
      if ((await tx.autopilotRule.count({ where: { recipeId } })) > 0) throw new RecipeError("recipe_in_use");
      await tx.recipe.update({ where: { id: recipeId }, data: { deletedAt: new Date(), updatedByUserId: scope.actorUserId } });
    });
  }

  private async requireRow(workspaceId: string, recipeId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipeId)) throw new RecipeError("recipe_not_found");
    const row = await requirePrisma().recipe.findFirst({
      where: { id: recipeId, workspaceId, deletedAt: null },
      include: withRuleCount,
    });
    if (!row) throw new RecipeError("recipe_not_found");
    return row;
  }
}

export const recipeService = new RecipeService();
