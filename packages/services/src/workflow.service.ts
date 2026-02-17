import Redis from "ioredis";
import { workflowStageUpdatedEventSchema, type WorkflowStageUpdatedEvent } from "@clipforge/validators";

const redisUrl = process.env.UPSTASH_REDIS_URL;

let publisher: Redis | null = null;

function getPublisher() {
  if (!redisUrl) {
    return null;
  }

  if (!publisher) {
    publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
  }

  return publisher;
}

export function getWorkflowChannel(projectId: string) {
  return `workflow:${projectId}`;
}

export async function publishWorkflowStageUpdated(event: WorkflowStageUpdatedEvent) {
  const parsed = workflowStageUpdatedEventSchema.parse(event);
  const client = getPublisher();

  if (!client) {
    return;
  }

  await client.publish(getWorkflowChannel(parsed.projectId), JSON.stringify(parsed));
}
