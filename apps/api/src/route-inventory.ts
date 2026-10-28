import type { Hono } from "hono";
import { ADMISSION_TABLES } from "./domains";
import type { AdmissionEntry } from "./domains/platform/admission-table";
import { type RegistrationMark, registrationOf } from "./http/admission";
import type { ApiEnv } from "./http/env";

/** Apps with their own credential model and checks: public REST, MCP and its discovery documents. */
const PROTOCOL_PREFIXES = ["/api/v1", "/mcp", "/.well-known/"] as const;

export interface InventoryProblem {
  kind: "undeclared_route" | "phantom_declaration" | "missing_admission" | "duplicate_registration" | "shadowed_route" | "unexpected_path";
  route: string;
  detail?: string;
}

export interface InventoryReport {
  problems: InventoryProblem[];
  /** First-party and webhook endpoints compared against the admission tables. */
  checkedRoutes: number;
  /** Endpoints under protocol prefixes, left to their owners' tests. */
  protocolRoutes: number;
}

interface EndpointGroup {
  method: string;
  path: string;
  /** Registration marks of the group's entries in registration order; `undefined` for an unregistered handler. */
  marks: (RegistrationMark | undefined)[];
}

function isProtocol(path: string): boolean {
  return PROTOCOL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || (prefix.endsWith("/") && path.startsWith(prefix)));
}

function endpointGroups(app: Hono<ApiEnv>): Map<string, EndpointGroup> {
  const groups = new Map<string, EndpointGroup>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const key = `${route.method} ${route.path}`;
    const group = groups.get(key) ?? { method: route.method, path: route.path, marks: [] };
    group.marks.push(registrationOf(route.handler));
    groups.set(key, group);
  }
  return groups;
}

/** Declared keys (`METHOD /api/path`) with their entries, from every domain's admission table. */
export function declaredRoutes(): Map<string, AdmissionEntry> {
  const declared = new Map<string, AdmissionEntry>();
  for (const [domain, table] of Object.entries(ADMISSION_TABLES)) {
    if (domain === "rest") continue;
    for (const [key, entry] of Object.entries(table) as [string, AdmissionEntry][]) {
      const [method, path] = key.split(" ") as [string, string];
      declared.set(`${method} /api${path}`, entry);
    }
  }
  return declared;
}

function samplePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+/g, "sample");
}

/**
 * Every entry answering a route must come from one `createRouteApp` /
 * `registerRoute` registration whose first entry is the declared admission (or
 * trust). Entries of another registration, or registered any other way, are
 * duplicates of the route and are reported even when the other registration is
 * itself guarded.
 */
function registrationProblems(
  key: string,
  group: EndpointGroup,
  entry: AdmissionEntry,
): InventoryProblem[] {
  const problems: InventoryProblem[] = [];
  const first = group.marks[0];
  const expected = "trust" in entry ? "trust" : "admission";
  if (!first) {
    problems.push({ kind: "missing_admission", route: key, detail: "first handler is not registered with its declaration" });
  } else if (first.role !== expected) {
    problems.push({ kind: "missing_admission", route: key, detail: `first handler is ${first.role}, declared ${expected}` });
  }
  const registrations = new Set(group.marks.map((mark) => mark?.registration));
  if (registrations.size > 1) {
    problems.push({ kind: "duplicate_registration", route: key, detail: `${registrations.size} registrations` });
  } else if (first && group.marks.some((mark) => !mark)) {
    problems.push({ kind: "missing_admission", route: key, detail: "unregistered handler in the chain" });
  }
  return problems;
}

/**
 * Compares the mounted routes with the admission declarations in both
 * directions and checks the three ways composition can silently break
 * admission: a route without its guard, the same route registered twice, and a
 * parameter route registered before a literal path that it would swallow.
 */
export function checkRouteInventory(
  app: Hono<ApiEnv>,
  declared: ReadonlyMap<string, AdmissionEntry> = declaredRoutes(),
): InventoryReport {
  const problems: InventoryProblem[] = [];
  const groups = endpointGroups(app);
  let protocolRoutes = 0;
  let checkedRoutes = 0;

  for (const [key, group] of groups) {
    if (isProtocol(group.path)) {
      protocolRoutes += 1;
      continue;
    }
    checkedRoutes += 1;
    if (!group.path.startsWith("/api/")) {
      problems.push({ kind: "unexpected_path", route: key });
      continue;
    }
    const entry = declared.get(key);
    if (!entry) {
      problems.push({ kind: "undeclared_route", route: key });
      continue;
    }
    problems.push(...registrationProblems(key, group, entry));
    // Each match is `[[handler, route], params]`; registration order decides which answers.
    const matched = app.router.match(group.method, samplePath(group.path))[0] as unknown as Array<
      [[unknown, { method: string; path: string }], unknown]
    >;
    const winner = matched.map(([pair]) => pair[1]).find((route) => route.method !== "ALL");
    if (winner && `${winner.method} ${winner.path}` !== key) {
      problems.push({ kind: "shadowed_route", route: key, detail: `answered by ${winner.method} ${winner.path}` });
    }
  }

  for (const key of declared.keys()) {
    if (!groups.has(key)) problems.push({ kind: "phantom_declaration", route: key });
  }
  return { problems, checkedRoutes, protocolRoutes };
}
