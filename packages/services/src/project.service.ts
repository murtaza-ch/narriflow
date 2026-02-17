import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@clipforge/db/client";
import {
  createProjectSchema,
  generateProjectRequestSchema,
  type CreateProjectInput,
  type GenerateProjectInput,
} from "@clipforge/validators";
import { publishWorkflowStageUpdated } from "./workflow.service";

function hasDatabase() {
  return Boolean(getPrismaClient());
}

export class ProjectService {
  async createProject(input: CreateProjectInput) {
    const parsed = createProjectSchema.parse(input);

    if (!hasDatabase()) {
      return {
        id: randomUUID(),
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
        persisted: false,
      };
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
    };
  }

  async triggerGeneration(projectId: string, input: GenerateProjectInput, idempotencyKey: string) {
    const parsed = generateProjectRequestSchema.parse(input);

    if (!idempotencyKey) {
      throw new Error("idempotency key is required");
    }

    const workflowRunId = randomUUID();

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

    await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      stage: "ingest",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return { workflowRunId };
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
