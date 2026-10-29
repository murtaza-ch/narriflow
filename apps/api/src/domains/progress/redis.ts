import {
  boundedRedisRetryDelay,
  getWorkflowChannel,
  installOptionalRedisErrorHandler,
  OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
  OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
} from "@narriflow/services";
import { workflowStageUpdatedEventSchema } from "@narriflow/validators/api/progress";
import Redis from "ioredis";
import type { SubscribeLive } from "./stream";

/**
 * Live delivery over the Project's Redis channel: one short-lived subscriber
 * connection per stream (a Redis connection, never a Prisma pool slot). Retries
 * are bounded so a lost Redis hands the stream back to log polling.
 */
export function createRedisSubscribeLive(redisUrl: string): SubscribeLive {
  return async (projectId, handlers) => {
    const channel = getWorkflowChannel(projectId);
    const subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
      commandTimeout: OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
      retryStrategy: (attempt) => boundedRedisRetryDelay(attempt, 3),
    });
    installOptionalRedisErrorHandler(subscriber);
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      subscriber.removeAllListeners("message");
      subscriber.removeAllListeners("end");
      subscriber.disconnect();
    };

    subscriber.on("end", () => {
      if (closed) return;
      close();
      handlers.onEnd();
    });
    subscriber.on("message", (incomingChannel: string, message: string) => {
      if (closed || incomingChannel !== channel) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }
      const parsed = workflowStageUpdatedEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.projectId !== projectId) return;
      handlers.onEvent(parsed.data);
    });

    try {
      await subscriber.connect();
      await subscriber.subscribe(channel);
    } catch (error) {
      close();
      throw error;
    }
    return { close };
  };
}
