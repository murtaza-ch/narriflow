import { Prisma } from "@prisma/client";

export function accessibleProjectWhere(now = new Date()) {
  return {
    purgeStartedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  } satisfies Prisma.ProjectWhereInput;
}

/** The same rule as `accessibleProjectWhere`, for raw SQL over a joined
 * "Project" row aliased `alias`. Keep the two together. */
export function accessibleProjectSql(alias: string, now = new Date()) {
  const project = Prisma.raw(`"${alias}"`);
  return Prisma.sql`${project}."purgeStartedAt" IS NULL AND (${project}."expiresAt" IS NULL OR ${project}."expiresAt" > ${now})`;
}
