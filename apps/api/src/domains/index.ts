import { Hono } from "hono";
import type { ApiEnv } from "../http/env";
import { automationAdmission } from "./automation/admission";
import { billingAdmission } from "./billing/admission";
import { brandAdmission } from "./brand/admission";
import { clipsAdmission } from "./clips/admission";
import { developerAdmission } from "./developer/admission";
import { exportsAdmission } from "./exports/admission";
import { ingestAdmission } from "./ingest/admission";
import { integrationsAdmission } from "./integrations/admission";
import { libraryAdmission } from "./library/admission";
import type { AdmissionTable } from "./platform/admission-table";
import { platformAdmission } from "./platform/admission";
import { progressAdmission } from "./progress/admission";
import { projectsAdmission } from "./projects/admission";
import { publishingAdmission } from "./publishing/admission";
import { recipesAdmission } from "./recipes/admission";
import { restAdmission } from "./rest/admission";
import { reviewsAdmission } from "./reviews/admission";
import { sessionAdmission } from "./session/admission";
import { studioAdmission } from "./studio/admission";
import { workspaceAdmission } from "./workspace/admission";

/** A chained domain app of any shape. Concrete types are exported per domain from `src/types`. */
export type AnyRoutes = Hono<ApiEnv, any, any>;

/**
 * Mount order of the first-party domain apps. Overlapping patterns resolve in
 * this order, so a domain that owns a literal path (`/projects/explorer`) must
 * register it before its own parameter route, and no domain may declare a
 * parameter route that shadows another domain's literal.
 */
export const FIRST_PARTY_DOMAINS = [
  "session",
  "workspace",
  "billing",
  "projects",
  "library",
  "ingest",
  "recipes",
  "clips",
  "exports",
  "studio",
  "brand",
  "publishing",
  "automation",
  "reviews",
  "developer",
  "integrations",
  "progress",
] as const;
export type FirstPartyDomain = (typeof FIRST_PARTY_DOMAINS)[number];

export type ApiDomainRoutes = Record<FirstPartyDomain, AnyRoutes>;

/** Signature-authenticated webhook adapters of the domains that own one (Clerk is mounted by platform). */
export interface ApiWebhookRoutes {
  billing: AnyRoutes;
  publishing: AnyRoutes;
  automation: AnyRoutes;
  projects: AnyRoutes;
}

/**
 * Every domain's admission declarations. `check-route-inventory` compares their
 * keys with the mounted routes in both directions. `rest` is listed for
 * completeness: its operations are admitted by `nf_` keys inside the REST app
 * and checked by its own OpenAPI test.
 */
export const ADMISSION_TABLES = {
  platform: platformAdmission,
  session: sessionAdmission,
  workspace: workspaceAdmission,
  billing: billingAdmission,
  projects: projectsAdmission,
  library: libraryAdmission,
  ingest: ingestAdmission,
  recipes: recipesAdmission,
  clips: clipsAdmission,
  exports: exportsAdmission,
  studio: studioAdmission,
  brand: brandAdmission,
  publishing: publishingAdmission,
  automation: automationAdmission,
  reviews: reviewsAdmission,
  developer: developerAdmission,
  integrations: integrationsAdmission,
  progress: progressAdmission,
  rest: restAdmission,
} as const satisfies Record<string, AdmissionTable>;
