import type { Prisma } from "@prisma/client";
import { pauseGrantsWhoseRuleChanged } from "./standing-grant";

/** Runs inside every Recipe save that changes what new work would use (not a
 * rename), with the rules that use the Recipe, in the save's transaction. It
 * pauses the active Standing Grants that cover those rules (`rule_changed`), so
 * a Recipe edit never widens what a grant authorized. Lock order is the
 * Recipe row (the save's own write), then each rule's row in id order, then its
 * grants, as in `AutopilotService.updateRule`. The caller flushes the audit
 * and notice events as its last write. */
export async function onRecipeContentChanged(tx: Prisma.TransactionClient, changedRuleIds: readonly string[]): Promise<void> {
  if (changedRuleIds.length === 0) return;
  const ids = [...changedRuleIds].sort();
  await tx.$queryRaw`SELECT "id" FROM "AutopilotRule" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
  for (const ruleId of ids) await pauseGrantsWhoseRuleChanged(tx, ruleId);
}
