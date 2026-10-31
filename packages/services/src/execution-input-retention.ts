import type { PrismaClient } from "@prisma/client";

/** Only producer-planned keys can enter this class. A referenced capsule stays
 * retained even after completion; deleting its Project/Clip removes the row.
 * A future check remains durable, so deletion cannot strand a forgotten key. */
export async function executionInputRetainUntil(database: Pick<PrismaClient, "clipPreparation" | "renderGroup" | "exportBundle" | "$queryRaw">, objectKey: string): Promise<Date | null> {
  const groupMatch = /^projects\/([a-f0-9-]{36})\/render-groups\/([a-f0-9-]{36})\/[a-f0-9-]{36}\.json$/.exec(objectKey);
  let deadlineAt: Date;
  if (groupMatch) {
    const row = await database.renderGroup.findUnique({ where: { id: groupMatch[2]! }, include: { workflowRun: { select: { projectId: true } } } });
    if (!row || row.workflowRun.projectId !== groupMatch[1] || row.inputStorageKey !== objectKey || !row.operationDeadlineAt) return null;
    deadlineAt = row.operationDeadlineAt;
  } else if (/^projects\/[a-f0-9-]{36}\/export-bundles\//.test(objectKey)) {
    const match=/^projects\/([a-f0-9-]{36})\/export-bundles\/([a-f0-9-]{36})\/[a-f0-9-]{36}\.json$/.exec(objectKey);
    if(!match)throw Error("Invalid execution input cleanup key");
    const row=await database.exportBundle.findUnique({where:{id:match[2]!},select:{inputStorageKey:true,operationDeadlineAt:true,operation:{select:{projectId:true}}}});
    if(!row || row.operation.projectId!==match[1] || row.inputStorageKey!==objectKey)return null;
    deadlineAt=row.operationDeadlineAt;
  } else {
    const match = /^projects\/([a-f0-9-]{36})\/preparations\/([a-f0-9-]{36})\/([a-f0-9-]{36})\.json$/.exec(objectKey);
    if (!match) throw new Error("Invalid execution input cleanup key");
    const row = await database.clipPreparation.findUnique({ where: { id: match[2]! }, select: { projectId: true, inputStorageKey: true, operationDeadlineAt: true } });
    if (!row || row.projectId !== match[1] || row.inputStorageKey !== objectKey) return null;
    deadlineAt = row.operationDeadlineAt;
  }
  const [clock] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!clock) throw new Error("Cleanup clock unavailable");
  return new Date(Math.max(clock.now.getTime() + 24 * 60 * 60_000, deadlineAt.getTime() + 120_000));
}
