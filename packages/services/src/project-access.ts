import type { Prisma } from "@prisma/client";

export function accessibleProjectWhere(now = new Date()) {
  return {
    purgeStartedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  } satisfies Prisma.ProjectWhereInput;
}
