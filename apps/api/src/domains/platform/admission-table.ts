import type {
  AdmissionDeclaration,
  IndependentTrust,
} from "../../http/admission";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `METHOD /path`, relative to the mount point (`/api` for first-party and webhook routes). */
export type RouteKey = `${RouteMethod} /${string}`;

/** Trust models that are not a Clerk session. `public_health` is the unauthenticated liveness/readiness pair. */
export type RouteTrust = IndependentTrust | "public_health";

export type AdmissionEntry = AdmissionDeclaration | { readonly trust: RouteTrust };

/**
 * One domain's admission declarations, keyed by the route they guard. The route
 * module registers `admit(table[key])`; `check-route-inventory` compares the
 * keys with the mounted routes in both directions, so a route without a
 * declaration and a declaration without a route both fail.
 */
export type AdmissionTable = Readonly<Record<RouteKey, AdmissionEntry>>;

/** Trust models whose adapters verify their own credential outside the first-party chain. */
export const UNGATED_TRUST: ReadonlySet<RouteTrust> = new Set<RouteTrust>([
  "public_health",
  "provider_signature",
]);
