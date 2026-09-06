import { Hono, type Context } from "hono";
import {
  discardUploadSessionSchema,
  finalizeUploadSessionSchema,
  grantUploadPartsSchema,
  openUploadSessionSchema,
  readUploadSessionSchema,
  type DiscardUploadSessionInput,
  type FinalizeUploadSessionInput,
  type GrantUploadPartsInput,
  type OpenUploadSessionInput,
  type ReadUploadSessionInput,
} from "@narriflow/validators";
import {
  type DiscardUploadSessionOutcome,
  type FinalizeUploadSessionOutcome,
  type GrantUploadPartsOutcome,
  type OpenUploadSessionOutcome,
  type ReadUploadSessionOutcome,
} from "@narriflow/services";

interface UploadSessionHttpUser {
  actorUserId: string;
  workspaceId: string;
}

interface UploadSessionHttpService {
  open(
    actorUserId: string,
    input: OpenUploadSessionInput,
    workspaceId: string,
  ): Promise<OpenUploadSessionOutcome>;
  finalize(
    actorUserId: string,
    input: FinalizeUploadSessionInput,
    workspaceId: string,
  ): Promise<FinalizeUploadSessionOutcome>;
  grant(
    actorUserId: string,
    input: GrantUploadPartsInput,
    workspaceId: string,
  ): Promise<GrantUploadPartsOutcome>;
  status(
    actorUserId: string,
    input: ReadUploadSessionInput,
    workspaceId: string,
  ): Promise<ReadUploadSessionOutcome>;
  discard(
    actorUserId: string,
    input: DiscardUploadSessionInput,
    workspaceId: string,
  ): Promise<DiscardUploadSessionOutcome>;
}

export interface UploadSessionHttpDependencies {
  getActor(context: Context): Promise<UploadSessionHttpUser>;
  service: UploadSessionHttpService;
}

export function createUploadSessionHttpRoutes(
  dependencies: UploadSessionHttpDependencies,
) {
  const routes = new Hono();

  routes.post("/upload-sessions/open", async (c) => {
    const appUser = await dependencies.getActor(c);

    const payload = await c.req.json().catch(() => null);
    const parsed = openUploadSessionSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "validation_failed", issues: parsed.error.issues },
        400,
      );
    }

    const outcome = await dependencies.service.open(
        appUser.actorUserId,
        parsed.data,
        appUser.workspaceId,
    );
    if (outcome.outcome === "reconciling") {
      c.header("Retry-After", String(outcome.retryAfterSeconds));
      return c.json(outcome, 202);
    }
    return c.json(outcome, 200);
  });

  routes.post("/upload-sessions/finalize", async (c) => {
    const appUser = await dependencies.getActor(c);

    const payload = await c.req.json().catch(() => null);
    const parsed = finalizeUploadSessionSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "validation_failed", issues: parsed.error.issues },
        400,
      );
    }

    const outcome = await dependencies.service.finalize(
        appUser.actorUserId,
        parsed.data,
        appUser.workspaceId,
    );
    if (outcome.outcome === "reconciling") {
      c.header("Retry-After", String(outcome.retryAfterSeconds));
      return c.json(outcome, 202);
    }
    return c.json(outcome, 200);
  });

  routes.post("/upload-sessions/grants", async (c) => {
    const appUser = await dependencies.getActor(c);

    const payload = await c.req.json().catch(() => null);
    const parsed = grantUploadPartsSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "validation_failed", issues: parsed.error.issues },
        400,
      );
    }

    return c.json(
        await dependencies.service.grant(
          appUser.actorUserId,
          parsed.data,
          appUser.workspaceId,
        ),
      200,
    );
  });

  routes.post("/upload-sessions/status", async (c) => {
    const appUser = await dependencies.getActor(c);
    const payload = await c.req.json().catch(() => null);
    const parsed = readUploadSessionSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "validation_failed", issues: parsed.error.issues },
        400,
      );
    }
    const outcome = await dependencies.service.status(
        appUser.actorUserId,
        parsed.data,
        appUser.workspaceId,
    );
    if (outcome.outcome === "reconciling") {
      c.header("Retry-After", String(outcome.retryAfterSeconds));
      return c.json(outcome, 202);
    }
    return c.json(outcome, 200);
  });

  routes.post("/upload-sessions/discard", async (c) => {
    const appUser = await dependencies.getActor(c);
    const payload = await c.req.json().catch(() => null);
    const parsed = discardUploadSessionSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "validation_failed", issues: parsed.error.issues },
        400,
      );
    }
    const outcome = await dependencies.service.discard(
        appUser.actorUserId,
        parsed.data,
        appUser.workspaceId,
    );
    if (outcome.outcome === "compensating") {
      c.header("Retry-After", String(outcome.retryAfterSeconds));
      return c.json(outcome, 202);
    }
    return c.json(outcome, 200);
  });

  return routes;
}
