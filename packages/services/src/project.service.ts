import { randomUUID } from "node:crypto";
import type {
  IngestJobType,
  IngestStatus as PrismaIngestStatus,
  Project,
  Prisma,
  Transcript as PrismaTranscript,
  TranscriptStatus as PrismaTranscriptStatus,
  WorkflowRun as PrismaWorkflowRun,
} from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  completeMultipartUploadSchema,
  createProjectSchema,
  generateProjectRequestSchema,
  presignUploadSchema,
  rssImportSchema,
  rssPreviewSchema,
  type CreateProjectInput,
  type GenerateProjectInput,
  type PresignUploadInput,
  type CompleteMultipartUploadInput,
  type RssImportInput,
  type TranscriptExportFormat,
  type TranscriptSnapshot,
  type YoutubeIngestInput,
  youtubeIngestSchema,
} from "@narriflow/validators";
import {
  completeMultipartUpload as completeR2MultipartUpload,
  createMultipartUpload,
  headObject,
  isR2Configured,
  listUploadedParts,
  presignMultipartPartUrls,
} from "./r2-storage";
import { fetchRssEpisodes } from "./rss";
import {
  buildTranscriptSnapshot,
  exportTranscript,
} from "./transcript.service";
import {
  getLastWorkflowSeq,
  publishWorkflowStageUpdated,
} from "./workflow.service";

interface ProjectSnapshot {
  id: string;
  userId: string;
  title: string;
  sourceMediaUrl: string;
  sourceType: "upload" | "youtube" | "rss";
  sourceInput: string | null;
  sourceStorageKey: string | null;
  sourceMimeType: string | null;
  sourceSizeBytes: number | null;
  sourceDurationSeconds: number | null;
  ingestStatus: PrismaIngestStatus;
  ingestErrorCode: string | null;
  ingestCompletedAt: string | null;
  persisted: boolean;
  createdAt: string;
}

type ProjectAccessResult = "owned" | "forbidden" | "missing";

type IngestLifecycleStatus =
  | "queued"
  | "downloading"
  | "normalizing"
  | "ready"
  | "failed";

interface ClaimedIngestJob {
  id: string;
  projectId: string;
  jobType: IngestJobType;
  payload: Prisma.JsonValue;
  attemptCount: number;
}

interface ClaimedWorkflowRun {
  id: string;
  projectId: string;
  stage: string;
  status: string;
  progress: number;
  project: Pick<
    Project,
    | "id"
    | "title"
    | "sourceMediaUrl"
    | "sourceType"
    | "sourceInput"
    | "sourceStorageKey"
    | "sourceMimeType"
    | "sourceDurationSeconds"
  >;
}

const projects = new Map<string, ProjectSnapshot>();
const idempotencyRuns = new Map<string, string>();

const UPLOAD_SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const STT_PROVIDER = "assemblyai";
const STT_PROVIDER_MODEL = "universal-3-pro,universal-2";

function getIdempotencyKey(projectId: string, idempotencyKey: string) {
  return `${projectId}:${idempotencyKey}`;
}

function hasDatabase() {
  return Boolean(getPrismaClient());
}

function sanitizeStorageFileName(fileName: string) {
  return fileName
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function bigintToNumber(value: bigint | number | null) {
  if (value === null) {
    return null;
  }

  return Number(value);
}

function buildR2Uri(key: string) {
  const bucket = process.env.R2_BUCKET ?? "unknown-bucket";
  return `r2://${bucket}/${key}`;
}

function toProjectSnapshot(row: Project): ProjectSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    sourceMediaUrl: row.sourceMediaUrl,
    sourceType: row.sourceType,
    sourceInput: row.sourceInput,
    sourceStorageKey: row.sourceStorageKey,
    sourceMimeType: row.sourceMimeType,
    sourceSizeBytes: bigintToNumber(row.sourceSizeBytes),
    sourceDurationSeconds: row.sourceDurationSeconds,
    ingestStatus: row.ingestStatus,
    ingestErrorCode: row.ingestErrorCode,
    ingestCompletedAt: row.ingestCompletedAt
      ? row.ingestCompletedAt.toISOString()
      : null,
    persisted: true,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWorkflowRunSnapshot(row: PrismaWorkflowRun) {
  return {
    workflowRunId: row.id,
    projectId: row.projectId,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSeq: 0,
  };
}

function toTranscriptSnapshot(row: PrismaTranscript): TranscriptSnapshot {
  return buildTranscriptSnapshot({
    projectId: row.projectId,
    status: row.status,
    provider: row.provider,
    providerModel: row.providerModel,
    providerJobId: row.providerJobId,
    languageCode: row.languageCode,
    text: row.text,
    utterancesJson: row.utterancesJson,
    speakerCount: row.speakerCount,
    durationSeconds: row.durationSeconds,
    errorCode: row.errorCode,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function ingestToWorkflowStage(status: IngestLifecycleStatus) {
  if (status === "queued") {
    return "ingest_queued" as const;
  }

  if (status === "downloading") {
    return "ingest_downloading" as const;
  }

  if (status === "normalizing") {
    return "ingest_normalizing" as const;
  }

  if (status === "ready") {
    return "ingest_ready" as const;
  }

  return "ingest" as const;
}

function ingestProgress(status: IngestLifecycleStatus) {
  if (status === "queued") {
    return 5;
  }

  if (status === "downloading") {
    return 40;
  }

  if (status === "normalizing") {
    return 75;
  }

  return 100;
}

export class ProjectService {
  private requirePrisma() {
    const prisma = getPrismaClient();

    if (!prisma) {
      throw new Error("Database client unavailable");
    }

    return prisma;
  }

  async getProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccessResult> {
    const prisma = getPrismaClient();

    if (!prisma) {
      const project = projects.get(projectId);

      if (!project) {
        return "missing";
      }

      return project.userId === userId ? "owned" : "forbidden";
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    });

    if (!project) {
      return "missing";
    }

    return project.userId === userId ? "owned" : "forbidden";
  }

  async listProjects(userId: string) {
    const prisma = getPrismaClient();

    if (!prisma) {
      return Array.from(projects.values())
        .filter((project) => project.userId === userId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    const rows = await prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return rows.map((row) => toProjectSnapshot(row));
  }

  async createProject(userId: string, input: CreateProjectInput) {
    const parsed = createProjectSchema.parse(input);

    if (!hasDatabase()) {
      const project: ProjectSnapshot = {
        id: randomUUID(),
        userId,
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
        sourceType: "upload",
        sourceInput: parsed.sourceMediaUrl,
        sourceStorageKey: null,
        sourceMimeType: null,
        sourceSizeBytes: null,
        sourceDurationSeconds: null,
        ingestStatus: "ready",
        ingestErrorCode: null,
        ingestCompletedAt: new Date().toISOString(),
        persisted: false,
        createdAt: new Date().toISOString(),
      };

      projects.set(project.id, project);
      return project;
    }

    const prisma = this.requirePrisma();
    const project = await prisma.project.create({
      data: {
        userId,
        title: parsed.title,
        sourceMediaUrl: parsed.sourceMediaUrl,
        sourceType: "upload",
        sourceInput: parsed.sourceMediaUrl,
        ingestStatus: "ready",
        ingestCompletedAt: new Date(),
      },
    });

    return toProjectSnapshot(project);
  }

  async getProjectSnapshot(userId: string, projectId: string) {
    const prisma = getPrismaClient();

    if (!prisma) {
      const inMemory = projects.get(projectId) ?? null;
      const project = inMemory?.userId === userId ? inMemory : null;
      return {
        project,
        activeRun: null,
        lastSeq: 0,
      };
    }

    const [row, latestRun, lastSeq] = await Promise.all([
      prisma.project.findFirst({ where: { id: projectId, userId } }),
      prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      }),
      getLastWorkflowSeq(projectId),
    ]);
    const project = row ? toProjectSnapshot(row) : null;

    return {
      project,
      activeRun: latestRun ? toWorkflowRunSnapshot(latestRun) : null,
      lastSeq,
    };
  }

  async getIngestSnapshot(userId: string, projectId: string) {
    const prisma = this.requirePrisma();
    const [row, latestRun, lastSeq] = await Promise.all([
      prisma.project.findFirst({ where: { id: projectId, userId } }),
      prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      }),
      getLastWorkflowSeq(projectId),
    ]);

    if (!row) {
      return null;
    }

    return {
      project: toProjectSnapshot(row),
      activeRun: latestRun ? toWorkflowRunSnapshot(latestRun) : null,
      lastSeq,
    };
  }

  async getWorkflowRun(projectId: string, workflowRunId: string) {
    const prisma = this.requirePrisma();
    const [dbRun, lastSeq] = await Promise.all([
      prisma.workflowRun.findUnique({ where: { id: workflowRunId } }),
      getLastWorkflowSeq(projectId),
    ]);

    return {
      run: dbRun ? toWorkflowRunSnapshot(dbRun) : null,
      lastSeq,
    };
  }

  async getTranscriptSnapshot(userId: string, projectId: string) {
    const prisma = this.requirePrisma();
    const row = await prisma.transcript.findFirst({
      where: {
        projectId,
        project: { userId },
      },
    });

    return row ? toTranscriptSnapshot(row) : null;
  }

  async getTranscriptExport(
    userId: string,
    projectId: string,
    format: TranscriptExportFormat,
  ) {
    const transcript = await this.getTranscriptSnapshot(userId, projectId);

    if (!transcript) {
      throw new Error("transcript not found");
    }

    if (transcript.status !== "completed") {
      throw new Error("transcript is not ready");
    }

    const slug = (transcript.languageCode ?? "transcript").replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );

    return {
      fileName: `${projectId}-${slug}.${format}`,
      body: exportTranscript(transcript, format),
      contentType:
        format === "txt"
          ? "text/plain; charset=utf-8"
          : format === "srt"
            ? "application/x-subrip; charset=utf-8"
            : "text/vtt; charset=utf-8",
    };
  }

  async triggerGeneration(
    userId: string,
    projectId: string,
    input: GenerateProjectInput,
    idempotencyKey: string,
  ) {
    const parsed = generateProjectRequestSchema.parse(input);

    if (!idempotencyKey) {
      throw new Error("idempotency key is required");
    }

    if (!hasDatabase()) {
      const project = projects.get(projectId);
      if (!project || project.userId !== userId) {
        throw new Error("project not found");
      }

      if (project.ingestStatus !== "ready") {
        throw new Error("project ingest is not ready");
      }
    } else {
      const prisma = this.requirePrisma();

      const project = await prisma.project.findFirst({
        where: { id: projectId, userId },
        select: {
          id: true,
          ingestStatus: true,
          transcript: {
            select: {
              status: true,
            },
          },
        },
      });

      if (!project) {
        throw new Error("project not found");
      }

      if (project.ingestStatus !== "ready") {
        throw new Error("project ingest is not ready");
      }

      const latestRun = await prisma.workflowRun.findFirst({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
      });

      if (
        !parsed.forceRegenerate &&
        latestRun &&
        (latestRun.status === "queued" || latestRun.status === "running")
      ) {
        return {
          workflowRunId: latestRun.id,
          acceptedAt: latestRun.updatedAt.toISOString(),
          initialSeq: await getLastWorkflowSeq(projectId),
        };
      }

      if (
        !parsed.forceRegenerate &&
        project.transcript?.status === "completed" &&
        latestRun
      ) {
        return {
          workflowRunId: latestRun.id,
          acceptedAt: latestRun.updatedAt.toISOString(),
          initialSeq: await getLastWorkflowSeq(projectId),
        };
      }
    }

    const existingRunId = idempotencyRuns.get(
      getIdempotencyKey(projectId, idempotencyKey),
    );
    if (existingRunId) {
      return {
        workflowRunId: existingRunId,
        acceptedAt: new Date().toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
      };
    }

    const workflowRunId = randomUUID();
    idempotencyRuns.set(
      getIdempotencyKey(projectId, idempotencyKey),
      workflowRunId,
    );

    if (hasDatabase()) {
      const prisma = this.requirePrisma();

      await prisma.$transaction(async (tx) => {
        await tx.workflowRun.create({
          data: {
            id: workflowRunId,
            projectId,
            idempotencyKey,
            stage: "stt",
            status: "queued",
            progress: 0,
          },
        });

        await tx.contentPack.create({
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

        await tx.transcript.upsert({
          where: { projectId },
          create: {
            projectId,
            status: "queued",
            provider: STT_PROVIDER,
            providerModel: STT_PROVIDER_MODEL,
            providerJobId: null,
            errorCode: null,
          },
          update: {
            status: "queued",
            provider: STT_PROVIDER,
            providerModel: STT_PROVIDER_MODEL,
            providerJobId: null,
            errorCode: null,
            completedAt: null,
          },
        });
      });
    }

    const event = await this.publishWorkflowRunEvent({
      projectId,
      workflowRunId,
      stage: "stt",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event?.emittedAt ?? new Date().toISOString(),
      initialSeq: event?.seq ?? 0,
    };
  }

  async presignMultipartUpload(userId: string, input: PresignUploadInput) {
    const parsed = presignUploadSchema.parse(input);

    if (!isR2Configured()) {
      throw new Error("R2 configuration is missing");
    }

    const prisma = this.requirePrisma();

    if (parsed.projectId && parsed.uploadId) {
      const session = await prisma.uploadSession.findFirst({
        where: {
          projectId: parsed.projectId,
          providerUploadId: parsed.uploadId,
          project: { userId },
        },
      });

      if (!session) {
        throw new Error("upload session not found");
      }

      if (session.expiresAt.getTime() < Date.now()) {
        await prisma.uploadSession.update({
          where: { id: session.id },
          data: { status: "expired" },
        });
        throw new Error("upload session expired");
      }

      const uploadedParts = await listUploadedParts({
        key: session.storageKey,
        uploadId: session.providerUploadId,
      });

      const uploadedNumbers = new Set(
        uploadedParts.map((part) => part.partNumber),
      );
      const partNumbers = Array.from(
        { length: session.partCount },
        (_, index) => index + 1,
      );
      const remaining = partNumbers.filter(
        (partNumber) => !uploadedNumbers.has(partNumber),
      );
      const uploadUrls =
        remaining.length > 0
          ? await presignMultipartPartUrls({
              key: session.storageKey,
              uploadId: session.providerUploadId,
              partNumbers: remaining,
            })
          : [];

      return {
        projectId: session.projectId,
        uploadId: session.providerUploadId,
        key: session.storageKey,
        partCount: session.partCount,
        uploadUrls,
        alreadyUploadedPartNumbers: Array.from(uploadedNumbers.values()).sort(
          (a, b) => a - b,
        ),
        alreadyUploadedParts: uploadedParts,
        expiresAt: session.expiresAt.toISOString(),
      };
    }

    const project = await prisma.project.create({
      data: {
        userId,
        title: parsed.title,
        sourceMediaUrl: "upload://pending",
        sourceType: "upload",
        sourceInput: parsed.fileName,
        ingestStatus: "uploading",
      },
    });

    const safeName = sanitizeStorageFileName(parsed.fileName);
    const key = `projects/${project.id}/${Date.now()}-${safeName || "source.bin"}`;
    const multipart = await createMultipartUpload({
      key,
      contentType: parsed.mimeType,
      metadata: {
        project_id: project.id,
        file_name: parsed.fileName,
      },
    });

    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_EXPIRY_MS);
    await prisma.uploadSession.create({
      data: {
        projectId: project.id,
        providerUploadId: multipart.uploadId,
        storageKey: key,
        partCount: parsed.partCount,
        expiresAt,
        status: "initiated",
      },
    });

    const partNumbers = Array.from(
      { length: parsed.partCount },
      (_, index) => index + 1,
    );
    const uploadUrls = await presignMultipartPartUrls({
      key,
      uploadId: multipart.uploadId,
      partNumbers,
    });

    return {
      projectId: project.id,
      uploadId: multipart.uploadId,
      key,
      partCount: parsed.partCount,
      uploadUrls,
      alreadyUploadedPartNumbers: [] as number[],
      alreadyUploadedParts: [] as Array<{ partNumber: number; etag: string }>,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async completeMultipartUpload(
    userId: string,
    input: CompleteMultipartUploadInput,
  ) {
    const parsed = completeMultipartUploadSchema.parse(input);
    const prisma = this.requirePrisma();

    const session = await prisma.uploadSession.findFirst({
      where: {
        projectId: parsed.projectId,
        providerUploadId: parsed.uploadId,
        storageKey: parsed.key,
        project: { userId },
      },
      include: {
        project: true,
      },
    });

    if (!session) {
      throw new Error("upload session not found");
    }

    if (session.status !== "initiated") {
      throw new Error("upload session cannot be completed");
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: "expired" },
      });
      throw new Error("upload session expired");
    }

    if (parsed.etags.length === 0) {
      throw new Error("at least one uploaded part is required");
    }

    await completeR2MultipartUpload({
      key: parsed.key,
      uploadId: parsed.uploadId,
      etags: parsed.etags,
    });

    const objectMeta = await headObject(parsed.key);

    const job = await prisma.$transaction(async (tx) => {
      await tx.uploadSession.update({
        where: { id: session.id },
        data: { status: "completed" },
      });

      await tx.project.update({
        where: { id: session.projectId },
        data: {
          sourceMediaUrl: buildR2Uri(parsed.key),
          sourceStorageKey: parsed.key,
          sourceInput: session.project.sourceInput ?? parsed.key,
          sourceMimeType: objectMeta.contentType,
          sourceSizeBytes: objectMeta.sizeBytes
            ? BigInt(objectMeta.sizeBytes)
            : undefined,
          ingestStatus: "queued",
          ingestErrorCode: null,
          ingestCompletedAt: null,
        },
      });

      return tx.ingestJob.create({
        data: {
          projectId: session.projectId,
          jobType: "upload_finalize",
          payload: {
            storageKey: parsed.key,
            uploadId: parsed.uploadId,
          },
        },
      });
    });

    await this.publishIngestLifecycleEvent({
      projectId: session.projectId,
      workflowRunId: job.id,
      ingestStatus: "queued",
      eventStatus: "queued",
      errorCode: null,
    });

    return {
      projectId: session.projectId,
      uploadId: parsed.uploadId,
      key: parsed.key,
      partsCompleted: parsed.etags.length,
      queuedJobId: job.id,
      completedAt: new Date().toISOString(),
    };
  }

  async queueYoutubeIngest(userId: string, input: YoutubeIngestInput) {
    const parsed = youtubeIngestSchema.parse(input);
    const prisma = this.requirePrisma();

    const project = await prisma.project.create({
      data: {
        userId,
        title: parsed.title ?? "YouTube Import",
        sourceMediaUrl: parsed.youtubeUrl,
        sourceType: "youtube",
        sourceInput: parsed.youtubeUrl,
        ingestStatus: "queued",
      },
    });

    const job = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        jobType: "youtube_import",
        payload: {
          youtubeUrl: parsed.youtubeUrl,
          requestedTitle: parsed.title ?? null,
        },
      },
    });

    await this.publishIngestLifecycleEvent({
      projectId: project.id,
      workflowRunId: job.id,
      ingestStatus: "queued",
      eventStatus: "queued",
      errorCode: null,
    });

    return {
      project: toProjectSnapshot(project),
      queuedJobId: job.id,
    };
  }

  async previewRssFeed(rssUrl: string) {
    const parsed = rssPreviewSchema.parse({ rssUrl });
    const episodes = await fetchRssEpisodes(parsed.rssUrl);

    return {
      rssUrl: parsed.rssUrl,
      episodes,
    };
  }

  async importFromRss(userId: string, input: RssImportInput) {
    const parsed = rssImportSchema.parse(input);
    const prisma = this.requirePrisma();

    const createdProjects: Array<{
      project: ProjectSnapshot;
      queuedJobId: string;
    }> = [];

    for (const episode of parsed.episodes) {
      const project = await prisma.project.create({
        data: {
          userId,
          title: parsed.titlePrefix
            ? `${parsed.titlePrefix} - ${episode.title}`
            : episode.title,
          sourceMediaUrl: episode.enclosureUrl,
          sourceType: "rss",
          sourceInput: parsed.rssUrl,
          ingestStatus: "queued",
          sourceMimeType: episode.mimeType ?? null,
          sourceDurationSeconds: episode.durationSeconds ?? null,
        },
      });

      const job = await prisma.ingestJob.create({
        data: {
          projectId: project.id,
          jobType: "rss_import",
          payload: {
            rssUrl: parsed.rssUrl,
            episode,
          },
        },
      });

      createdProjects.push({
        project: toProjectSnapshot(project),
        queuedJobId: job.id,
      });

      await this.publishIngestLifecycleEvent({
        projectId: project.id,
        workflowRunId: job.id,
        ingestStatus: "queued",
        eventStatus: "queued",
        errorCode: null,
      });
    }

    return {
      count: createdProjects.length,
      projects: createdProjects,
    };
  }

  async claimNextWorkflowRun(
    stage:
      | "stt"
      | "moment_detection"
      | "clip_rendering"
      | "output_pack_generation"
      | "export_bundle" = "stt",
  ): Promise<ClaimedWorkflowRun | null> {
    const prisma = this.requirePrisma();

    const queued = await prisma.workflowRun.findFirst({
      where: {
        stage,
        status: "queued",
      },
      orderBy: { createdAt: "asc" },
      include: {
        project: {
          select: {
            id: true,
            title: true,
            sourceMediaUrl: true,
            sourceType: true,
            sourceInput: true,
            sourceStorageKey: true,
            sourceMimeType: true,
            sourceDurationSeconds: true,
          },
        },
      },
    });

    if (!queued) {
      return null;
    }

    const update = await prisma.workflowRun.updateMany({
      where: {
        id: queued.id,
        status: "queued",
      },
      data: {
        status: "running",
        progress: 10,
      },
    });

    if (update.count === 0) {
      return this.claimNextWorkflowRun(stage);
    }

    if (stage === "stt") {
      await prisma.transcript.upsert({
        where: { projectId: queued.projectId },
        create: {
          projectId: queued.projectId,
          status: "processing",
          provider: STT_PROVIDER,
          providerModel: STT_PROVIDER_MODEL,
          providerJobId: null,
        },
        update: {
          status: "processing",
          provider: STT_PROVIDER,
          providerModel: STT_PROVIDER_MODEL,
          providerJobId: null,
          errorCode: null,
        },
      });
    }

    await this.publishWorkflowRunEvent({
      projectId: queued.projectId,
      workflowRunId: queued.id,
      stage,
      status: "running",
      progress: 10,
      errorCode: null,
    });

    return {
      id: queued.id,
      projectId: queued.projectId,
      stage,
      status: "running",
      progress: 10,
      project: queued.project,
    };
  }

  async claimNextIngestJob(): Promise<ClaimedIngestJob | null> {
    const prisma = this.requirePrisma();

    const queued = await prisma.ingestJob.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
    });

    if (!queued) {
      return null;
    }

    const update = await prisma.ingestJob.updateMany({
      where: {
        id: queued.id,
        status: "queued",
      },
      data: {
        status: "running",
        startedAt: new Date(),
        attemptCount: {
          increment: 1,
        },
      },
    });

    if (update.count === 0) {
      return this.claimNextIngestJob();
    }

    const claimed = await prisma.ingestJob.findUnique({
      where: { id: queued.id },
    });

    if (!claimed) {
      return null;
    }

    return {
      id: claimed.id,
      projectId: claimed.projectId,
      jobType: claimed.jobType,
      payload: claimed.payload,
      attemptCount: claimed.attemptCount,
    };
  }

  async completeTranscriptWorkflowRun(
    workflowRunId: string,
    input: {
      provider: string;
      providerModel: string;
      providerJobId: string | null;
      languageCode: string | null;
      text: string;
      utterances: unknown;
      speakerCount: number;
      durationSeconds: number | null;
      rawStorageKey: string | null;
    },
  ) {
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }

    const completedAt = new Date();

    await prisma.transcript.upsert({
      where: { projectId: run.projectId },
      create: {
        projectId: run.projectId,
        status: "completed",
        provider: input.provider,
        providerModel: input.providerModel,
        providerJobId: input.providerJobId,
        languageCode: input.languageCode,
        text: input.text,
        utterancesJson: input.utterances as Prisma.InputJsonValue,
        speakerCount: input.speakerCount,
        durationSeconds: input.durationSeconds,
        rawStorageKey: input.rawStorageKey,
        errorCode: null,
        completedAt,
      },
      update: {
        status: "completed",
        provider: input.provider,
        providerModel: input.providerModel,
        providerJobId: input.providerJobId,
        languageCode: input.languageCode,
        text: input.text,
        utterancesJson: input.utterances as Prisma.InputJsonValue,
        speakerCount: input.speakerCount,
        durationSeconds: input.durationSeconds,
        rawStorageKey: input.rawStorageKey,
        errorCode: null,
        completedAt,
      },
    });

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "stt",
        status: "completed",
        progress: 100,
        errorCode: null,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "stt",
      status: "completed",
      progress: 100,
      errorCode: null,
    });

    // Auto-advance: queue moment_detection stage
    const mdIdempotencyKey = `${run.idempotencyKey}__moment_detection`;
    const mdRun = await prisma.workflowRun.create({
      data: {
        projectId: run.projectId,
        idempotencyKey: mdIdempotencyKey,
        stage: "moment_detection",
        status: "queued",
        progress: 0,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: mdRun.id,
      stage: "moment_detection",
      status: "queued",
      progress: 0,
      errorCode: null,
    });
  }

  async completeClipDetectionWorkflowRun(workflowRunId: string) {
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "moment_detection",
        status: "completed",
        progress: 100,
        errorCode: null,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "moment_detection",
      status: "completed",
      progress: 100,
      errorCode: null,
    });
  }

  async failClipDetectionWorkflowRun(
    workflowRunId: string,
    errorCode: string,
  ) {
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "moment_detection",
        status: "failed",
        progress: 100,
        errorCode,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "moment_detection",
      status: "failed",
      progress: 100,
      errorCode,
    });
  }

  async completeClipRenderingWorkflowRun(workflowRunId: string) {
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "clip_rendering",
        status: "completed",
        progress: 100,
        errorCode: null,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "clip_rendering",
      status: "completed",
      progress: 100,
      errorCode: null,
    });
  }

  async failClipRenderingWorkflowRun(
    workflowRunId: string,
    errorCode: string,
  ) {
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        stage: "clip_rendering",
        status: "failed",
        progress: 100,
        errorCode,
      },
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "clip_rendering",
      status: "failed",
      progress: 100,
      errorCode,
    });
  }

  async failTranscriptWorkflowRun(workflowRunId: string, errorCode: string) {
    const prisma = this.requirePrisma();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!run) {
      throw new Error("workflow run not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.transcript.upsert({
        where: { projectId: run.projectId },
        create: {
          projectId: run.projectId,
          status: "failed",
          provider: STT_PROVIDER,
          providerModel: STT_PROVIDER_MODEL,
          errorCode,
        },
        update: {
          status: "failed",
          provider: STT_PROVIDER,
          providerModel: STT_PROVIDER_MODEL,
          errorCode,
          completedAt: null,
        },
      });

      await tx.workflowRun.update({
        where: { id: run.id },
        data: {
          stage: "stt",
          status: "failed",
          progress: 100,
          errorCode,
        },
      });
    });

    await this.publishWorkflowRunEvent({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "stt",
      status: "failed",
      progress: 100,
      errorCode,
    });
  }

  async markIngestJobDownloading(jobId: string) {
    return this.updateJobIngestLifecycle(jobId, "downloading");
  }

  async markIngestJobNormalizing(jobId: string) {
    return this.updateJobIngestLifecycle(jobId, "normalizing");
  }

  async completeIngestJob(
    jobId: string,
    input: {
      sourceStorageKey: string;
      sourceMediaUrl?: string;
      sourceInput?: string | null;
      sourceMimeType?: string | null;
      sourceSizeBytes?: number | null;
      sourceDurationSeconds?: number | null;
    },
  ) {
    const prisma = this.requirePrisma();

    const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new Error("ingest job not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: job.projectId },
        data: {
          sourceStorageKey: input.sourceStorageKey,
          sourceMediaUrl:
            input.sourceMediaUrl ?? buildR2Uri(input.sourceStorageKey),
          sourceInput: input.sourceInput ?? undefined,
          sourceMimeType: input.sourceMimeType ?? undefined,
          sourceSizeBytes:
            typeof input.sourceSizeBytes === "number"
              ? BigInt(input.sourceSizeBytes)
              : undefined,
          sourceDurationSeconds: input.sourceDurationSeconds ?? undefined,
          ingestStatus: "ready",
          ingestErrorCode: null,
          ingestCompletedAt: new Date(),
        },
      });

      await tx.ingestJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          lastError: null,
          completedAt: new Date(),
        },
      });
    });

    await this.publishIngestLifecycleEvent({
      projectId: job.projectId,
      workflowRunId: job.id,
      ingestStatus: "ready",
      eventStatus: "completed",
      errorCode: null,
    });
  }

  async failIngestJob(jobId: string, errorCode: string, errorMessage: string) {
    const prisma = this.requirePrisma();

    const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new Error("ingest job not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: job.projectId },
        data: {
          ingestStatus: "failed",
          ingestErrorCode: errorCode,
        },
      });

      await tx.ingestJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          lastError: `${errorCode}: ${errorMessage}`,
          completedAt: new Date(),
        },
      });
    });

    await this.publishIngestLifecycleEvent({
      projectId: job.projectId,
      workflowRunId: job.id,
      ingestStatus: "failed",
      eventStatus: "failed",
      errorCode,
    });
  }

  private async updateJobIngestLifecycle(
    jobId: string,
    ingestStatus: Exclude<IngestLifecycleStatus, "ready" | "failed">,
  ) {
    const prisma = this.requirePrisma();

    const job = await prisma.ingestJob.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new Error("ingest job not found");
    }

    await prisma.project.update({
      where: { id: job.projectId },
      data: {
        ingestStatus,
        ingestErrorCode: null,
      },
    });

    await this.publishIngestLifecycleEvent({
      projectId: job.projectId,
      workflowRunId: job.id,
      ingestStatus,
      eventStatus: "running",
      errorCode: null,
    });
  }

  async getTranscriptForWorker(projectId: string) {
    const prisma = this.requirePrisma();
    return prisma.transcript.findUnique({
      where: { projectId },
    });
  }

  async getLatestContentPack(projectId: string) {
    const prisma = this.requirePrisma();
    return prisma.contentPack.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async publishWorkflowProgress(input: {
    projectId: string;
    workflowRunId: string;
    stage:
      | "stt"
      | "moment_detection"
      | "clip_rendering"
      | "output_pack_generation"
      | "export_bundle";
    status: "queued" | "running" | "completed" | "failed";
    progress: number;
    errorCode: string | null;
  }) {
    return this.publishWorkflowRunEvent(input);
  }

  private async publishWorkflowRunEvent(input: {
    projectId: string;
    workflowRunId: string;
    stage:
      | "stt"
      | "moment_detection"
      | "clip_rendering"
      | "output_pack_generation"
      | "export_bundle";
    status: "queued" | "running" | "completed" | "failed";
    progress: number;
    errorCode: string | null;
  }) {
    return publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      stage: input.stage,
      status: input.status,
      progress: input.progress,
      errorCode: input.errorCode,
    });
  }

  private async publishIngestLifecycleEvent(input: {
    projectId: string;
    workflowRunId: string;
    ingestStatus: IngestLifecycleStatus;
    eventStatus: "queued" | "running" | "completed" | "failed";
    errorCode: string | null;
  }) {
    await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      stage: ingestToWorkflowStage(input.ingestStatus),
      status: input.eventStatus,
      progress: ingestProgress(input.ingestStatus),
      errorCode: input.errorCode,
    });
  }
}

export const projectService = new ProjectService();
