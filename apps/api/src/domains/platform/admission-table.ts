import type {
  AdmissionDeclaration,
  IndependentTrust,
} from "../../http/admission";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `METHOD /path`, relative to the mount point (`/api` for first-party and webhook routes). */
export type RouteKey = `${RouteMethod} /${string}`;

/** Trust models that are not a Clerk session. `public_health` is the unauthenticated liveness/readiness pair. */
export type RouteTrust = IndependentTrust | "public_health" | "staff";

export type AdmissionEntry = AdmissionDeclaration | { readonly trust: RouteTrust };

/**
 * One domain's admission declarations, keyed by the route they guard. The route
 * module builds its app with `createRouteApp(table)`, which installs
 * `table[key]` ahead of the handlers of each route it registers;
 * `check-route-inventory` compares the keys with the mounted routes in both
 * directions, so a route without a declaration and a declaration without a
 * route both fail.
 */
export type AdmissionTable = Readonly<Record<RouteKey, AdmissionEntry>>;
