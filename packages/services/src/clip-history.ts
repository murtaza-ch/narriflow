import type { Prisma } from "@prisma/client";

/** Exports that review or publishing evidence still points at. Only deleting
 * the whole Project may cascade through them. */
export const exportWithHistoryWhere = {
  OR: [
    { frozenPublicationStates: { some: {} } },
    { reviewRoundItems: { some: {} } },
    { reviewApprovalOverrides: { some: {} } },
  ],
} satisfies Prisma.ClipExportWhereInput;
