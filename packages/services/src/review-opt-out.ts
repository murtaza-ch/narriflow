import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** A reviewer's way out of automated review requests. Every review email a Standing
 * Grant sends carries a link whose token names the Workspace and the address and is
 * signed, so it needs no login. Following it records the address against the
 * Workspace, and grants skip recorded addresses from then on. A person can still
 * invite the reviewer by hand. */

const CONTRACT = "reviewer-opt-out-v1";

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`${CONTRACT}.${payload}`).digest("base64url");
}

const normalize = (email: string) => email.trim().toLowerCase();

export function signReviewOptOutToken(input: { workspaceId: string; email: string }, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ w: input.workspaceId, e: normalize(input.email) }), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The Workspace and address a token names, or null for anything not signed with `secret`. */
export function verifyReviewOptOutToken(token: string, secret: string): { workspaceId: string; email: string } | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { w?: unknown; e?: unknown };
    return typeof parsed.w === "string" && typeof parsed.e === "string" ? { workspaceId: parsed.w, email: parsed.e } : null;
  } catch {
    return null;
  }
}

/** Which of these addresses have opted out of automated review requests from the Workspace. */
export async function optedOutReviewers(db: Pick<PrismaClient, "reviewerOptOut">, workspaceId: string, emails: readonly string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await db.reviewerOptOut.findMany({ where: { workspaceId, email: { in: [...new Set(emails.map(normalize))] } }, select: { email: true } });
  return new Set(rows.map((row) => row.email));
}

export function createReviewerOptOut(dependencies: { prisma: PrismaClient; secret: () => string }) {
  const { prisma } = dependencies;
  return {
    /** What a link would opt out of, for the page that asks first. Null for a token that isn't ours. */
    async preview(token: string): Promise<{ workspaceName: string; email: string } | null> {
      const claims = verifyReviewOptOutToken(token, dependencies.secret());
      if (!claims) return null;
      const workspace = await prisma.workspace.findUnique({ where: { id: claims.workspaceId }, select: { name: true } });
      return workspace ? { workspaceName: workspace.name, email: claims.email } : null;
    },

    /** Records the opt-out. Doing it twice is the same as once. */
    async confirm(token: string): Promise<{ workspaceName: string } | null> {
      const claims = verifyReviewOptOutToken(token, dependencies.secret());
      if (!claims) return null;
      const workspace = await prisma.workspace.findUnique({ where: { id: claims.workspaceId }, select: { name: true } });
      if (!workspace) return null;
      await prisma.reviewerOptOut.upsert({
        where: { workspaceId_email: { workspaceId: claims.workspaceId, email: claims.email } },
        create: { workspaceId: claims.workspaceId, email: claims.email },
        update: {},
      });
      return { workspaceName: workspace.name };
    },
  };
}
