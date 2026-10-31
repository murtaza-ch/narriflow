import {planCoversGrant,pauseStandingGrantWithinTransaction} from "./standing-grant";
import {flushWorkspaceEvents} from "./workspace-event";
import {takeExecutionDispatchIds} from "./execution-dispatch-runtime";
import { Prisma } from "@prisma/client";
import type { MaintenancePage, MaintenancePhaseHandler, MaintenancePageResult } from "./execution-maintenance";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";
import { readExecutionAdmission } from "./execution-admission";
import { lockWorkspaceUsage } from "./processing-usage";
import { appendPublicationDispatch } from "./publication-dispatch";
import { appendPublicationGrantExpiry, restorePublication } from "./publication-producers";
import { appendPerformanceCapture, appendYouTubeReceiptEnrichment, appendPerformanceGuidance, isPublicationObservationReference, publicationObservationInputHash } from "./publication-observations";
import { lockPublicationAttempt } from "./publication-locks";
import { readExecutionDispatch } from "./execution-dispatch";

type Tx = Prisma.TransactionClient;
type Position = { id: string; at: Date };
type Parents = { workspaceId: string | null; projectId?: string | null; socialAccountId?: string | null; postId?: string };
const active = ["preparing_video", "scheduled", "publishing", "processing", "reconciling"] as const;
const validDate = (value: Date) => value instanceof Date && Number.isSafeInteger(value.getTime()) && value.getTime() >= 0;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
async function validate(tx: Tx, page: MaintenancePage) {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 32 || !validDate(page.cutoff) ||
    (page.after && (!validDate(page.after.at) || page.after.at > page.cutoff || !uuid.test(page.after.id) || page.after.tie !== undefined)))
    throw Error("publication_maintenance_page_invalid");
  if ((await readExecutionAdmission(tx)).epoch !== page.deploymentEpoch) throw Error("publication_maintenance_epoch_superseded");
}
function after(page: MaintenancePage, at: Prisma.Sql, id: Prisma.Sql) {
  return page.after ? Prisma.sql`AND (${at}, ${id}) > ((${page.after.at}::timestamptz AT TIME ZONE 'UTC'), ${page.after.id}::uuid)` : Prisma.empty;
}
function result(rows: Position[], limit: number, ids: string[]): MaintenancePageResult {
  const dispatchIds = [...new Set(ids)];
  if (dispatchIds.length > 127) throw Error("publication_maintenance_dispatch_bound");
  return { processed: Math.min(rows.length, limit), next: rows.length > limit ? { at: rows[limit - 1]!.at, id: rows[limit - 1]!.id } : null, dispatchIds };
}

/** Cursor order and lock order differ. Every page locks shared parents and
 * posts in UUID order before retaining any per-row domain locks. */
async function lockParents(tx: Tx, rows: Parents[]) {
  const unique = (values: (string | null | undefined)[]) => [...new Set(values.filter((id): id is string => Boolean(id)))].sort();
  const workspaces = unique(rows.map(row => row.workspaceId));
  for (const id of workspaces) await lockWorkspaceUsage(tx, id);
  if (workspaces.length) await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ANY(${workspaces}::uuid[]) ORDER BY "id" FOR SHARE`;
  const projects = unique(rows.map(row => row.projectId));
  if (projects.length) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ANY(${projects}::uuid[]) ORDER BY "id" FOR SHARE`;
  const accounts = unique(rows.map(row => row.socialAccountId));
  if (accounts.length) await tx.$queryRaw`SELECT "id" FROM "SocialAccount" WHERE "id" = ANY(${accounts}::uuid[]) ORDER BY "id" FOR SHARE`;
  const posts = unique(rows.map(row => row.postId));
  if (posts.length) await tx.$queryRaw`SELECT "id" FROM "SocialPost" WHERE "id" = ANY(${posts}::uuid[]) ORDER BY "id" FOR UPDATE`;
}

/** Repairs admitted intent only. The targeted driver rechecks actor, grant,
 * immutable source and provider permission before any physical execution. */
export const planPublicationRecoveryPage: MaintenancePhaseHandler = async (tx, page) => {
  await validate(tx, page);
  const rows = await tx.$queryRaw<Array<Position & Parents>>`SELECT "id", "createdAt" AS at, "id" AS "postId", "workspaceId", "projectId", "socialAccountId" FROM "SocialPost"
    WHERE "deploymentEpoch" = ${page.deploymentEpoch} AND "status" IN ('preparing_video','scheduled','publishing','processing','reconciling') AND "createdAt" <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
    ${after(page, Prisma.sql`"createdAt"`, Prisma.sql`"id"`)} ORDER BY "createdAt", "id" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit), ids: string[] = [];
  await lockParents(tx, selected);
  for (const row of selected) {
    const current = await tx.socialPost.findUnique({ where: { id: row.id }, select: { deploymentEpoch: true, status: true } });
    if (!current || current.deploymentEpoch !== page.deploymentEpoch || !(active as readonly string[]).includes(current.status)) continue;
    ids.push(await appendPublicationDispatch(tx, row.id, { wakeKind: `hourly_publication.${page.cutoff.getTime()}` }));
  }
  return result(rows, page.limit, ids);
};

/** Expiry itself belongs to the exact grant/revision timer and its audit
 * transaction. A maintenance page only restores that obligation. */
export const planStandingGrantExpiryPage: MaintenancePhaseHandler = (tx, page) => planGrantPage(tx,page,false);
/** Final restore registers even future accepted expiries before reopening. */
export const planStandingGrantRedispatchPage: MaintenancePhaseHandler = (tx, page) => planGrantPage(tx,page,true);
async function planGrantPage(tx: Tx, page: MaintenancePage, redispatch: boolean) {
  await validate(tx, page);
  const at = redispatch ? Prisma.sql`"createdAt"` : Prisma.sql`"expiresAt"`;
  const rows = await tx.$queryRaw<Array<Position & Parents>>`SELECT "id", ${at} AS at, "workspaceId" FROM "StandingGrant"
    WHERE "status" IN ('active','paused') AND ${at} <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
    ${after(page,at, Prisma.sql`"id"`)} ORDER BY ${at}, "id" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit), ids: string[] = [];
  await lockParents(tx, selected);
  for (const row of selected) {
    const grant = await tx.standingGrant.findUnique({ where: { id: row.id } });
    if (grant && ["active", "paused"].includes(grant.status) && (redispatch || grant.expiresAt <= page.cutoff)) ids.push(await appendPublicationGrantExpiry(tx, grant));
  }
  return result(rows, page.limit, ids);
}

const receiptDue = Prisma.sql`COALESCE(r."enrichmentLeaseExpiresAt", r."enrichmentNextCheckAt", r."createdAt")`;
export const planPublicationReceiptRecoveryPage: MaintenancePhaseHandler = (tx,page) => planReceiptPage(tx,page,false);
export const planPublicationReceiptRedispatchPage: MaintenancePhaseHandler = (tx,page) => planReceiptPage(tx,page,true);
async function planReceiptPage(tx: Tx, page: MaintenancePage, redispatch: boolean) {
  await validate(tx, page);
  const at = redispatch ? Prisma.sql`r."createdAt"` : receiptDue;
  const rows = await tx.$queryRaw<Array<Position & Parents & { attemptId: string }>>`SELECT r."id", ${at} AS at, r."attemptId", p."id" AS "postId", p."workspaceId", p."projectId", p."socialAccountId"
    FROM "ProviderReceipt" r JOIN "SocialPublicationAttempt" a ON a."id"=r."attemptId" JOIN "SocialPost" p ON p."id"=a."socialPostId"
    WHERE p."deploymentEpoch"=${page.deploymentEpoch} AND r."platform"='youtube_shorts' AND r."providerProcessingStatus"='processing' AND r."enrichedAt" IS NULL
      AND ${at} <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page, at, Prisma.sql`r."id"`)}
    ORDER BY ${at}, r."id" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit), ids: string[] = [];
  await lockParents(tx, selected);
  for (const id of [...new Set(selected.map(row => row.attemptId))].sort()) await lockPublicationAttempt(tx, id);
  for (const row of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT "id" FROM "ProviderReceipt" WHERE "id"=${row.id}::uuid FOR UPDATE`;
    const id = await appendYouTubeReceiptEnrichment(tx, row.id);
    if (id) ids.push(id);
  }
  return result(rows, page.limit, ids);
}

const captureDue = Prisma.sql`COALESCE(c."leaseExpiresAt", c."dueAt")`;
export const planPerformanceCaptureRecoveryPage: MaintenancePhaseHandler = (tx,page) => planCapturePage(tx,page,false);
export const planPerformanceCaptureRedispatchPage: MaintenancePhaseHandler = (tx,page) => planCapturePage(tx,page,true);
async function planCapturePage(tx: Tx, page: MaintenancePage, redispatch: boolean) {
  await validate(tx, page);
  const at = redispatch ? Prisma.sql`c."createdAt"` : captureDue;
  const rows = await tx.$queryRaw<Array<Position & Parents>>`SELECT c."id", ${at} AS at, v."workspaceId", p."projectId", p."socialAccountId", p."id" AS "postId"
    FROM "PerformanceCapture" c JOIN "TrackedVideo" v ON v."id"=c."trackedVideoId" LEFT JOIN "SocialPost" p ON p."id"=v."socialPostId"
    WHERE c."state"='scheduled' AND (p."id" IS NULL OR p."deploymentEpoch"=${page.deploymentEpoch}) AND ${at} <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
      ${after(page, at, Prisma.sql`c."id"`)} ORDER BY ${at}, c."id" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit), ids: string[] = [];
  await lockParents(tx, selected);
  for (const row of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT "id" FROM "PerformanceCapture" WHERE "id"=${row.id}::uuid FOR UPDATE`;
    const id = await appendPerformanceCapture(tx, row.id);
    if (id) ids.push(id);
  }
  return result(rows, page.limit, ids);
}

/** Rebind the original logical intent under the verified restored epoch.
 * This never resets budgets, deadlines, checkpoints or uncertain outcomes. */
export const planPublicationRestorePage: ExecutionRestorePhaseHandler = async (tx, page) => {
  await validate(tx, page);
  if (page.deploymentEpoch !== Math.max(page.snapshotEpoch, page.fenceAboveEpoch) + 1) throw Error("publication_maintenance_page_invalid");
  const rows = await tx.$queryRaw<Array<Position & Parents>>`SELECT "id", "createdAt" AS at, "id" AS "postId", "workspaceId", "projectId", "socialAccountId" FROM "SocialPost"
    WHERE "deploymentEpoch" <= ${page.snapshotEpoch} AND "createdAt" <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
    ${after(page, Prisma.sql`"createdAt"`, Prisma.sql`"id"`)} ORDER BY "createdAt", "id" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit), ids: string[] = [];
  await lockParents(tx, selected);
  for (const row of selected) ids.push(...await restorePublication(tx, row.id, page.deploymentEpoch,{deferDispatch:true}));
  return result(rows, page.limit, ids);
};

/** Reconstruct only the last accepted night in each source-epoch chain. Old
 * receipt expiry cannot turn completed historical nights into fresh work. */
export const planPublicationGuidanceRedispatchPage: ExecutionRestorePhaseHandler = async (tx, page) => {
  await validate(tx,page);
  if (!Number.isSafeInteger(page.snapshotEpoch) || page.snapshotEpoch < 1 || page.snapshotEpoch >= page.deploymentEpoch) throw Error("publication_maintenance_page_invalid");
  const rows = await tx.$queryRaw<Position[]>`SELECT "id", "createdAt" AS at FROM "ExecutionDispatch"
    WHERE "deploymentEpoch"=${page.snapshotEpoch} AND "kind"='maintenance' AND "subjectKind"='maintenance' AND "subjectId" LIKE 'po1.g.%'
      AND "createdAt" <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page,Prisma.sql`"createdAt"`,Prisma.sql`"id"`)}
    ORDER BY "createdAt", "id" LIMIT ${page.limit + 1}`;
  const selected: Array<Position & { workspaceId: string; subjectId: string; dueAt: Date }> = [];
  for (const row of rows.slice(0,page.limit)) {
    const original = await readExecutionDispatch(tx,row.id);
    if (!original || !isPublicationObservationReference(original.reference) || !original.reference.subject.id.startsWith("po1.g.") || original.reference.generation !== 1 || original.reference.deploymentEpoch !== page.snapshotEpoch || original.reference.inputHash !== publicationObservationInputHash(original.reference.subject.id)) throw Error("publication_guidance_restore_reference_invalid");
    const parts = original.reference.subject.id.split("."), workspaceId = parts[2]!, night = Number(parts[3]);
    if (original.dueAt.getTime() !== night) throw Error("publication_guidance_restore_reference_invalid");
    selected.push({ ...row, workspaceId, subjectId: original.reference.subject.id, dueAt: original.dueAt });
  }
  await lockParents(tx,selected);
  const ids: string[] = [];
  for (const row of selected) {
    const workspace = await tx.workspace.findUnique({ where: { id: row.workspaceId }, select: { status: true } });
    if (workspace?.status !== "active") continue;
    const [latest] = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ExecutionDispatch"
      WHERE "deploymentEpoch"=${page.snapshotEpoch} AND "kind"='maintenance' AND "subjectKind"='maintenance' AND "subjectId" LIKE 'po1.g.%'
        AND left("subjectId",42)=${`po1.g.${row.workspaceId}`} AND "createdAt" <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "dueAt" DESC,"id" DESC LIMIT 1`;
    if (latest?.id !== row.id) continue;
    ids.push(await appendPerformanceGuidance(tx,row.workspaceId,row.dueAt));
  }
  return result(rows,page.limit,ids);
};

/** Daily authority reconciliation is a bounded command page. It preserves
 * existing grants on upgrade and accepts one notice only on a system pause. */
export const planStandingGrantAuthorityPage:MaintenancePhaseHandler=async(tx,page)=>{
 await validate(tx,page);
 const rows=await tx.$queryRaw<Array<Position&Parents>>`SELECT "id","createdAt" AS at,"workspaceId" FROM "StandingGrant" WHERE status='active' AND "createdAt"<=(${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after(page,Prisma.sql`"createdAt"`,Prisma.sql`"id"`)} ORDER BY "createdAt",id LIMIT ${page.limit+1}`;
 await lockParents(tx,rows.slice(0,page.limit));
 for(const row of rows.slice(0,page.limit)){
  const grant=await tx.standingGrant.findUnique({where:{id:row.id},include:{workspace:{select:{pricingTier:true}}}});if(!grant||grant.status!=='active')continue;
  const member=grant.grantedByUserId?await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:grant.workspaceId,userId:grant.grantedByUserId}},include:{user:{select:{deletedAt:true}}}}):null;
  const reason=!planCoversGrant(grant.workspace.pricingTier,grant.kind)?'plan_lost':!member||member.user.deletedAt||!['owner','admin'].includes(member.role)?'granter_unavailable':null;
  if(reason)await pauseStandingGrantWithinTransaction(tx,{grantId:grant.id,revision:grant.revision,reason,actorUserId:null});
 }
 await flushWorkspaceEvents(tx);return result(rows,page.limit,takeExecutionDispatchIds(tx));
};
