import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@clipforge/db/client";
import {
  createProjectSchema,
  generateProjectRequestSchema,
  type CreateProjectInput,
  type GenerateProjectInput,
} from "@clipforge/validators";
import {
  getActiveWorkflowRun,
  getLastWorkflowSeq,
  getWorkflowEventsSince,
  getWorkflowRunSnapshot,
  publishWorkflowStageUpdated,
} from "./workflow.service";

interface ProjectSnapshot {
  id: string;
  title: string;
  sourceMediaUrl: string;
  persisted: boolean;
  createdAt: string;
}

const projects = new Map<string, ProjectSnapshot>();
const idempotencyRuns = new Map<string, string>();

function getIdempotencyKey(projectId: string, idempotencyKey: string) {
  return `${projectId}:${idempotencyKey}`;
}

function hasDatabase() {
  return Boolean(getPrismaClient());
}

export class ProjectService {
  async listProjects() {
    const prisma = getPrismaClient();

    if (!prisma) {
      return Array.from(projects.values()).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
    }

    const rows = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceMediaUrl: row.sourceMediaUrl,
      persisted: true,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createProject(input: CreateProjectInput) {
    const parsed = createProjectSchema.parse(input);

    if (!hasDatabase()) {
      const project: ProjectSnapshot = {
        id: randomUUID(),
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
        persisted: false,
        createdAt: new Date().toISOString(),
      };

      projects.set(project.id, project);
      return project;
    }

    const prisma = getPrismaClient();
    if (!prisma) {
      throw new Error("Database client unavailable");
    }

    const project = await prisma.project.create({
      data: {
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
      },
    });

    return {
      id: project.id,
      title: project.title,
      sourceMediaUrl: project.sourceMediaUrl,
      persisted: true,
      createdAt: project.createdAt.toISOString(),
    };
  }

  async getProjectSnapshot(projectId: string) {
    const prisma = getPrismaClient();

    if (!prisma) {
      const project = projects.get(projectId) ?? null;
      return {
        project,
        activeRun: getActiveWorkflowRun(projectId),
        lastSeq: getLastWorkflowSeq(projectId),
      };
    }

    const row = await prisma.project.findUnique({ where: { id: projectId } });
    const project =
      row === null
        ? null
        : {
            id: row.id,
            title: row.title,
            sourceMediaUrl: row.sourceMediaUrl,
            persisted: true,
            createdAt: row.createdAt.toISOString(),
          };

    return {
      project,
      activeRun: getActiveWorkflowRun(projectId),
      lastSeq: getLastWorkflowSeq(projectId),
    };
  }

  async getWorkflowRun(projectId: string, workflowRunId: string) {
    const run = getWorkflowRunSnapshot(projectId, workflowRunId);
    const timeline = getWorkflowEventsSince(projectId, 0).filter(
      (event) => event.workflowRunId === workflowRunId,
    );

    return {
      run,
      timeline,
      lastSeq: getLastWorkflowSeq(projectId),
    };
  }

  async triggerGeneration(projectId: string, input: GenerateProjectInput, idempotencyKey: string) {
    const parsed = generateProjectRequestSchema.parse(input);

    if (!idempotencyKey) {
      throw new Error("idempotency key is required");
    }

    const existingRunId = idempotencyRuns.get(getIdempotencyKey(projectId, idempotencyKey));
    if (existingRunId) {
      return {
        workflowRunId: existingRunId,
        acceptedAt: new Date().toISOString(),
        initialSeq: getLastWorkflowSeq(projectId),
      };
    }

    const workflowRunId = randomUUID();
    idempotencyRuns.set(getIdempotencyKey(projectId, idempotencyKey), workflowRunId);

    if (hasDatabase()) {
      const prisma = getPrismaClient();
      if (!prisma) {
        throw new Error("Database client unavailable");
      }

      await prisma.workflowRun.create({
        data: {
          id: workflowRunId,
          projectId,
          idempotencyKey,
          stage: "ingest",
          status: "queued",
          progress: 0,
        },
      });

      await prisma.contentPack.create({
        data: {
          projectId,
          outputTypes: parsed.contentPack.outputTypes,
          clipCountTarget: parsed.contentPack.clipCountTarget,
          clipDurationSecTarget: parsed.contentPack.clipDurationSecTarget,
          toneConstraints: parsed.contentPack.toneConstraints,
          captionPreset: parsed.contentPack.captionPreset,
          platformPlaybookVersion: parsed.contentPack.platformPlaybookVersion,
        },
      });
    }

    const event = await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "ingest",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event.emittedAt,
      initialSeq: event.seq,
    };
  }

  async presignMultipartUpload(fileName: string, partCount: number) {
    const uploadId = randomUUID();

    return {
      uploadId,
      key: `projects/${randomUUID()}/${fileName}`,
      partCount,
      uploadUrls: Array.from({ length: partCount }, (_, index) => ({
        partNumber: index + 1,
        url: `https://example-r2-upload.local/${uploadId}/part/${index + 1}`,
      })),
    };
  }

  async completeMultipartUpload(uploadId: string, key: string, etagCount: number) {
    return {
      uploadId,
      key,
      partsCompleted: etagCount,
      completedAt: new Date().toISOString(),
    };
  }
}

export const projectService = new ProjectService();
