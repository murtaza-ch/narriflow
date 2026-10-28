import type { VerifiedClerkIdentity } from "./clerk";

/**
 * Platform staff, distinct from signed-in users and Workspace Actor Scope.
 * Membership role `admin`, payload flags, headers and client metadata never
 * confer it; only the server-side Clerk user id allowlist does.
 */
export interface PlatformActor {
  readonly kind: "platform_staff";
  readonly clerkUserId: string;
}

export type StaffAllowlist = ReadonlySet<string>;

/** Parses `PLATFORM_STAFF_CLERK_USER_IDS`: comma-separated exact Clerk user ids, empty by default. */
export function parseStaffAllowlist(value: string | undefined): StaffAllowlist {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function resolvePlatformActor(
  identity: VerifiedClerkIdentity,
  allowlist: StaffAllowlist,
): PlatformActor | null {
  return allowlist.has(identity.clerkUserId)
    ? { kind: "platform_staff", clerkUserId: identity.clerkUserId }
    : null;
}
