import { getWorkflowEventsSince, optionalRedisUrl } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import { createRedisSubscribeLive } from "./redis";
import type { ProgressRouteDeps } from "./routes";

/** Production wiring of the progress routes. Redis is optional; without it the stream serves from the durable log. */
export function createProgressRouteDeps(config: ApiConfig): ProgressRouteDeps {
  const redisUrl = optionalRedisUrl(process.env.UPSTASH_REDIS_URL);
  return {
    getEventsSince: getWorkflowEventsSince,
    subscribeLive: redisUrl ? createRedisSubscribeLive(redisUrl) : null,
    limits: config.streams,
  };
}
