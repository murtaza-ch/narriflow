import Redis from "ioredis";
import { workflowStageUpdatedEventSchema, type WorkflowStageUpdatedEvent } from "@clipforge/validators";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const MAX_EVENTS_PER_PROJECT = 250;

export interface WorkflowRunSnapshot {
  workflowRunId: string;
  projectId: string;
  stage: WorkflowStageUpdatedEvent["stage"];
  status: WorkflowStageUpdatedEvent["status"];
  progress: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
}

interface ProjectWorkflowState {
  lastSeq: number;
  events: WorkflowStageUpdatedEvent[];
  runs: Map<string, WorkflowRunSnapshot>;
}

const workflowState = new Map<string, ProjectWorkflowState>();

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

function getProjectWorkflowState(projectId: string) {
  let state = workflowState.get(projectId);

  if (!state) {
    state = {
      lastSeq: 0,
      events: [],
      runs: new Map(),
    };
    workflowState.set(projectId, state);
  }

  return state;
}

function upsertRunSnapshot(event: WorkflowStageUpdatedEvent) {
  const state = getProjectWorkflowState(event.projectId);
  const existing = state.runs.get(event.workflowRunId);
  const createdAt = existing?.createdAt ?? event.emittedAt;

  state.runs.set(event.workflowRunId, {
    workflowRunId: event.workflowRunId,
    projectId: event.projectId,
    stage: event.stage,
    status: event.status,
    progress: event.progress,
    errorCode: event.errorCode,
    createdAt,
    updatedAt: event.emittedAt,
    lastSeq: event.seq,
  });
}

export function getWorkflowChannel(projectId: string) {
  return `workflow:${projectId}`;
}

export function getLastWorkflowSeq(projectId: string) {
  return getProjectWorkflowState(projectId).lastSeq;
}

export function getWorkflowEventsSince(projectId: string, sinceSeq = 0) {
  const state = getProjectWorkflowState(projectId);
  return state.events.filter((event) => event.seq > sinceSeq);
}

export function getWorkflowRunSnapshot(projectId: string, workflowRunId: string) {
  const state = getProjectWorkflowState(projectId);
  return state.runs.get(workflowRunId) ?? null;
}

export function getActiveWorkflowRun(projectId: string) {
  const state = getProjectWorkflowState(projectId);
  const runs = Array.from(state.runs.values());

  if (runs.length === 0) {
    return null;
  }

  runs.sort((left, right) => {
    if (left.updatedAt === right.updatedAt) {
      return right.lastSeq - left.lastSeq;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });

  return runs[0] ?? null;
}

export async function publishWorkflowStageUpdated(
  event: Omit<WorkflowStageUpdatedEvent, "seq" | "emittedAt">,
) {
  const state = getProjectWorkflowState(event.projectId);
  const parsed = workflowStageUpdatedEventSchema.parse({
    ...event,
    seq: state.lastSeq + 1,
    emittedAt: new Date().toISOString(),
  });

  state.lastSeq = parsed.seq;
  state.events.push(parsed);

  if (state.events.length > MAX_EVENTS_PER_PROJECT) {
    state.events.splice(0, state.events.length - MAX_EVENTS_PER_PROJECT);
  }

  upsertRunSnapshot(parsed);

  const client = getPublisher();
  if (client) {
    await client.publish(getWorkflowChannel(parsed.projectId), JSON.stringify(parsed));
  }

  return parsed;
}
