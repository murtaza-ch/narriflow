import {
  authorizeBusinessAutomation,
  checkRateLimit,
  createProductionBusinessAutomation,
  workspaceService,
} from "@narriflow/services";

import { createBusinessApiHttpHandler } from "./business-api-http";

export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createBusinessApiHttpHandler({
  authenticateApiKey: (secret) => workspaceService.authenticateApiKey(secret),
  authorize: (principal, input) => authorizeBusinessAutomation(principal, input),
  automation: createProductionBusinessAutomation(),
  rateLimit: ({ key, limit, windowSeconds }) =>
    checkRateLimit(key, limit, windowSeconds),
  log(event) {
    console.warn(JSON.stringify(event));
  },
});

export const GET = handler;
export const POST = handler;
