import { Hono } from "hono";
import { handle } from "hono/vercel";
import {
  completeMultipartUploadSchema,
  generateProjectRequestSchema,
  presignUploadSchema,
} from "@clipforge/validators";
import { projectService } from "@clipforge/services";

export const runtime = "nodejs";

const app = new Hono().basePath("/api");

app.get("/health", (c) => c.json({ ok: true, service: "clipforge-web-api" }));

app.post("/projects/:id/generate", async (c) => {
  const projectId = c.req.param("id");
  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = generateProjectRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const result = await projectService.triggerGeneration(projectId, parsed.data, idempotencyKey);
  return c.json(result, 202);
});

app.get("/projects/:id", async (c) => {
  const projectId = c.req.param("id");
  const snapshot = await projectService.getProjectSnapshot(projectId);

  if (!snapshot.project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(snapshot, 200);
});

app.get("/projects/:id/runs/:workflowRunId", async (c) => {
  const projectId = c.req.param("id");
  const workflowRunId = c.req.param("workflowRunId");
  const snapshot = await projectService.getWorkflowRun(projectId, workflowRunId);

  if (!snapshot.run) {
    return c.json({ error: "Workflow run not found" }, 404);
  }

  return c.json(snapshot, 200);
});

app.post("/uploads/presign", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const parsed = presignUploadSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const response = await projectService.presignMultipartUpload(parsed.data.fileName, parsed.data.partCount);
  return c.json(response, 200);
});

app.post("/uploads/complete", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const parsed = completeMultipartUploadSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const response = await projectService.completeMultipartUpload(
    parsed.data.uploadId,
    parsed.data.key,
    parsed.data.etags.length,
  );
  return c.json(response, 200);
});

const honoHandler = handle(app);

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
