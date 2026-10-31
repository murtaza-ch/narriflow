import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { getWorkflowEventsSince } from "@narriflow/services/workflow.service";
import { optionalRedisUrl } from "@narriflow/services/optional-redis";
import type { ApiConfig } from "../../config";
import { createRedisSubscribeLive } from "./redis";
import type { ProgressRouteDeps } from "./routes";

/** Production wiring of the progress routes. Redis is optional; without it the stream serves from the durable log. */
export function createProgressRouteDeps(config: ApiConfig): ProgressRouteDeps {
  const redisUrl = optionalRedisUrl(readServiceEnvironment().UPSTASH_REDIS_URL);
  return {
    getEventsSince: getWorkflowEventsSince,
    subscribeLive: redisUrl ? createRedisSubscribeLive(redisUrl) : null,
    limits: config.streams,
  };
}
