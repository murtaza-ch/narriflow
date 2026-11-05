import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { logFailure } from "./log-failure";

/** docs/tracking-plan.md is the catalog. Rows with no name here stay internal. */
const LEDGER_EVENTS: Record<string, string> = {
  render_completed: "clip_render_complete",
  download_opened: "clip_download_start",
  social_scheduled: "social_post_schedule",
  social_cancelled: "social_post_cancel",
  social_posted: "social_post_publish",
  social_failed: "social_post_fail",
  dub_completed: "clip_dub_complete",
  review_sent: "review_send",
  review_opened: "review_open",
  review_changes_requested: "review_changes_request",
  review_item_approved: "review_item_approve",
  campaign_approved: "campaign_approve",
  campaign_scheduled: "campaign_schedule",
  assisted_copy_generated: "social_copy_generate",
  generated_asset_completed: "generated_image_complete",
  brand_profile_created: "brand_profile_create",
  brand_profile_applied: "brand_profile_apply",
};
const OPERATION_NAMES: Record<string, string> = { intake: "import", generation: "clip_generation", export: "clip_export" };
const OPERATION_STATES: Record<string, string> = { completed: "complete", partial: "partial", failed: "fail", cancelled: "cancel" };
const TIER_RANK: Record<string, number> = { free: 0, creator: 1, pro: 2, business: 3 };

const WINDOW_MS = 60 * 60_000;
/** A row written just before the hour may not have committed when the cron reads. */
const COMMIT_LAG_MS = 2 * 60_000;
const MAX_EVENTS_PER_RUN = 20_000;

export type ProductEventRow = {
  id: string; source: string; detail: string | null; state: string | null; at: Date; distinctId: string;
  workspaceId: string | null; projectId: string | null; clipId: string | null; platform: string | null; planTier: string | null;
};
export interface ProductEvent {
  uuid: string; event: string; distinctId: string; timestamp: Date;
  properties: Record<string, string | Record<string, string>>;
}

function eventName(row: ProductEventRow): string | null {
  if (row.source === "user") return "user_sign_up";
  if (row.source === "workspace") return "workspace_create";
  if (row.source === "project") return "project_create";
  if (row.source === "export") return "clip_export_create";
  if (row.source === "ledger") return LEDGER_EVENTS[row.detail ?? ""] ?? null;
  if (row.source === "operation") {
    const name = OPERATION_NAMES[row.detail ?? ""], state = OPERATION_STATES[row.state ?? ""];
    return name && state ? `${name}_${state}` : null;
  }
  if (row.source === "billing") {
    const previous = TIER_RANK[row.detail ?? ""], next = TIER_RANK[row.planTier ?? ""];
    if (previous === undefined || next === undefined || previous === next) return null;
    if (previous === 0) return "subscription_start";
    if (next === 0) return "subscription_cancel";
    return next > previous ? "subscription_upgrade" : "subscription_downgrade";
  }
  return null;
}

/** Built from named columns only. Metadata can hold captions, so it never leaves. */
export function toProductEvent(row: ProductEventRow): ProductEvent | null {
  const event = eventName(row);
  if (!event) return null;
  const properties: ProductEvent["properties"] = {};
  if (row.workspaceId) properties.workspace_id = row.workspaceId;
  if (row.projectId) properties.project_id = row.projectId;
  if (row.clipId) properties.clip_id = row.clipId;
  if (row.platform) properties.platform = row.platform;
  if (row.planTier) {
    properties.plan_tier = row.planTier;
    properties.$set = { plan_tier: row.planTier };
  }
  if (row.source === "project" && row.detail) properties.source_type = row.detail;
  return { uuid: row.id, event, distinctId: row.distinctId, timestamp: row.at, properties };
}

/** Whole, non-overlapping hours, because a re-sent event could still be billed. */
export function productEventWindow(scheduledAt: Date) {
  const to = new Date(scheduledAt.getTime() - COMMIT_LAG_MS);
  return { from: new Date(to.getTime() - WINDOW_MS), to };
}

export async function readProductEvents(database: Pick<PrismaClient, "$queryRaw">, window: { from: Date; to: Date }): Promise<ProductEventRow[]> {
  const from = window.from, to = window.to;
  const inWindow = (column: Prisma.Sql) => Prisma.sql`${column} >= (${from}::timestamp) AND ${column} < (${to}::timestamp)`;
  return database.$queryRaw<ProductEventRow[]>`
    SELECT * FROM (
      SELECT u.id::text AS id, 'user' AS source, NULL::text AS detail, NULL::text AS state, u."createdAt" AS at, u."clerkId" AS "distinctId",
        NULL::text AS "workspaceId", NULL::text AS "projectId", NULL::text AS "clipId", NULL::text AS platform, NULL::text AS "planTier"
      FROM "User" u WHERE u."deletedAt" IS NULL AND ${inWindow(Prisma.sql`u."createdAt"`)}
      UNION ALL
      SELECT w.id::text, 'workspace', NULL, NULL, w."createdAt", u."clerkId", w.id::text, NULL, NULL, NULL, w."pricingTier"::text
      FROM "Workspace" w JOIN "User" u ON u.id = w."ownerUserId" WHERE ${inWindow(Prisma.sql`w."createdAt"`)}
      UNION ALL
      SELECT p.id::text, 'project', p."sourceType"::text, NULL, p."createdAt", u."clerkId", p."workspaceId"::text, p.id::text, NULL, NULL, w."pricingTier"::text
      FROM "Project" p JOIN "User" u ON u.id = p."createdByUserId" JOIN "Workspace" w ON w.id = p."workspaceId" WHERE ${inWindow(Prisma.sql`p."createdAt"`)}
      UNION ALL
      SELECT e.id::text, 'export', NULL, NULL, e."createdAt", u."clerkId", p."workspaceId"::text, e."projectId"::text, e."clipId"::text, NULL, w."pricingTier"::text
      FROM "ClipExport" e JOIN "Project" p ON p.id = e."projectId" JOIN "User" u ON u.id = e."createdByUserId" JOIN "Workspace" w ON w.id = p."workspaceId" WHERE ${inWindow(Prisma.sql`e."createdAt"`)}
      UNION ALL
      SELECT e.id::text, 'ledger', e.type::text, NULL, e."createdAt", u."clerkId", e."workspaceId"::text, e."projectId"::text, NULL, NULL, w."pricingTier"::text
      FROM "ProgramAnalyticsEvent" e JOIN "User" u ON u.id = e."actorUserId" JOIN "Workspace" w ON w.id = e."workspaceId" WHERE ${inWindow(Prisma.sql`e."createdAt"`)}
      UNION ALL
      SELECT e.id::text, 'ledger', e.type::text, NULL, e."createdAt", u."clerkId", p."workspaceId"::text, e."projectId"::text, e."clipId"::text, e.platform::text, w."pricingTier"::text
      FROM "ProjectAnalyticsEvent" e JOIN "Project" p ON p.id = e."projectId" JOIN "User" u ON u.id = p."createdByUserId" JOIN "Workspace" w ON w.id = p."workspaceId" WHERE ${inWindow(Prisma.sql`e."createdAt"`)}
      UNION ALL
      SELECT e.id::text, 'operation', e.subject -> 'operation' ->> 'kind', e.subject ->> 'state', e."occurredAt", u."clerkId", e."workspaceId"::text, e.subject ->> 'projectId', NULL, NULL, w."pricingTier"::text
      FROM "WorkspaceEvent" e JOIN "Workspace" w ON w.id = e."workspaceId"
        JOIN "Project" p ON p.id::text = e.subject ->> 'projectId' JOIN "User" u ON u.id = p."createdByUserId"
      WHERE e.type = 'operation.finished' AND ${inWindow(Prisma.sql`e."createdAt"`)}
      UNION ALL
      SELECT t.id::text, 'billing', t."previousTier"::text, NULL, t."effectiveAt", u."clerkId", w.id::text, NULL, NULL, NULL, t."nextTier"::text
      FROM "WorkspaceBillingTransition" t JOIN "WorkspaceBillingAccount" a ON a.id = t."billingAccountId"
        JOIN "Workspace" w ON w.id = a."workspaceId" JOIN "User" u ON u.id = w."ownerUserId" WHERE ${inWindow(Prisma.sql`t."createdAt"`)}
    ) events ORDER BY at LIMIT ${MAX_EVENTS_PER_RUN}`;
}

/** Reads what committed, so analytics can never report work that rolled back. */
export async function forwardProductEvents(input: { scheduledAt: Date; send(events: ProductEvent[]): Promise<void>; database?: Pick<PrismaClient, "$queryRaw"> }) {
  try {
    const database = input.database ?? getPrismaClient();
    if (!database) throw new Error("Product events require a database scope");
    const rows = await readProductEvents(database, productEventWindow(input.scheduledAt));
    if (rows.length >= MAX_EVENTS_PER_RUN) logFailure("product_events_truncated", Object.assign(new Error("An hour of product events exceeded the run limit"), { code: "product_events_truncated" }));
    const events = rows.flatMap(row => toProductEvent(row) ?? []);
    if (events.length) await input.send(events);
  } catch (error) { logFailure("product_events_forward_failed", error); }
}
