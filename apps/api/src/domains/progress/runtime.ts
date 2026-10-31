import { getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createProgressTicketCodec, loadProgressTicketKeys } from "@narriflow/services/progress-ticket";
import { readProgressReplay } from "@narriflow/services/progress-feed";
import type { ApiConfig } from "../../config";
import type { ProgressRouteDeps } from "./routes";
import type { ProgressSocketDeps } from "./socket";

function codec() { return createProgressTicketCodec(loadProgressTicketKeys(readServiceEnvironment())); }
export function createProgressRouteDeps(config: ApiConfig): ProgressRouteDeps {
  return { allowedOrigins: config.corsAllowedOrigins, audience: new URL("/api/progress", config.apiOrigin).href, issue: (scope, authorizedAt) => codec().issue(scope, authorizedAt) };
}
export function createProgressSocketDeps(config: ApiConfig): ProgressSocketDeps {
  return { allowedOrigins: config.corsAllowedOrigins, audience: new URL("/api/progress", config.apiOrigin).href,
    verify: (ticket, input) => codec().verify(ticket, input),
    replay: (scope, cursor) => { const prisma = getPrismaClient(); if (!prisma) throw new Error("Progress database scope is unavailable"); return readProgressReplay(prisma, scope, cursor); },
  };
}
