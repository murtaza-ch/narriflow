import type { Prisma } from "@prisma/client";

/** Provider work whose outcome is unknown or half recorded. The retention purge
 * cannot delete such a Project's objects, and a user's delete must not accept
 * what the purge would then refuse forever, so both ask here. */
export async function hasUnresolvedProviderOutcome(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
  const [dub, generated] = await Promise.all([
    tx.clipDub.findFirst({
      where: {
        projectId,
        OR: [
          { status: "unknown" },
          { translationIntentArtifactId: { not: null }, translationResultArtifactId: null, outcomeArtifactId: null },
          { speechIntentArtifactId: { not: null }, audioArtifactId: null, outcomeArtifactId: null },
        ],
      },
      select: { id: true },
    }),
    tx.generatedMediaJob.findFirst({
      where: { projectId, OR: [{ outcomeUnknown: true }, { usageStatus: "reserved", chargedAttempts: { gt: 0 } }] },
      select: { id: true },
    }),
  ]);
  return dub !== null || generated !== null;
}
