import { Hono } from "hono";
import {
  finalizeUploadSessionSchema,
  grantUploadPartsSchema,
  openUploadSessionSchema,
  userErrorMessage,
  type FinalizeUploadSessionInput,
  type GrantUploadPartsInput,
  type OpenUploadSessionInput,
} from "@narriflow/validators";
import {
  UploadSessionIdempotencyConflictError,
  UploadSessionIntegrityError,
  UploadSessionInvalidStateError,
  UploadSessionNotFoundError,
  UploadSessionQuotaRefusedError,
  type FinalizeUploadSessionOutcome,
  type GrantUploadPartsOutcome,
  type OpenUploadSessionOutcome,
} from "@narriflow/services";

interface UploadSessionHttpUser {
  id: string;
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
}

export interface UploadSessionHttpDependencies {
  getCurrentUser(): Promise<UploadSessionHttpUser | null>;
  checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean }>;
  service: UploadSessionHttpService;
}

export function createUploadSessionHttpRoutes(
  dependencies: UploadSessionHttpDependencies,
) {
  const routes = new Hono();

  routes.post("/upload-sessions/open", async (c) => {
    const appUser = await dependencies.getCurrentUser();
    if (!appUser) return c.json({ error: "Unauthorized" }, 401);

    const rateLimit = await dependencies.checkRateLimit(
      `upload-session-open:${appUser.id}`,
      60,
      60,
    );
    if (!rateLimit.allowed) {
      c.header("Retry-After", "60");
      return c.json(
        { error: "rate_limited", message: userErrorMessage("rate_limited") },
        429,
      );
    }

    const payload = await c.req.json().catch(() => null);
    const parsed = openUploadSessionSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid payload", issues: parsed.error.issues },
        400,
      );
    }

    try {
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
    } catch (error) {
      if (error instanceof UploadSessionIdempotencyConflictError) {
        return c.json(
          {
            error: error.code,
            message: userErrorMessage(error.code) ?? error.message,
          },
          409,
        );
      }
      if (error instanceof UploadSessionInvalidStateError) {
        return c.json({ error: error.code, message: error.message }, 409);
      }
      if (error instanceof UploadSessionNotFoundError) {
        return c.json({ error: error.code, message: error.message }, 404);
      }
      if (error instanceof UploadSessionIntegrityError) {
        return c.json({ error: error.code, message: error.message }, 422);
      }
      if (error instanceof UploadSessionQuotaRefusedError) {
        return c.json(
          { error: error.code, message: error.message, details: error.details },
          402,
        );
      }
      return c.json(
        {
          error: "upload_session_unavailable",
          message: "Upload storage is temporarily unavailable.",
        },
        503,
      );
    }
  });

  routes.post("/upload-sessions/finalize", async (c) => {
    const appUser = await dependencies.getCurrentUser();
    if (!appUser) return c.json({ error: "Unauthorized" }, 401);

    const rateLimit = await dependencies.checkRateLimit(
      `upload-session-finalize:${appUser.id}`,
      60,
      60,
    );
    if (!rateLimit.allowed) {
      c.header("Retry-After", "60");
      return c.json(
        { error: "rate_limited", message: userErrorMessage("rate_limited") },
        429,
      );
    }

    const payload = await c.req.json().catch(() => null);
    const parsed = finalizeUploadSessionSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid payload", issues: parsed.error.issues },
        400,
      );
    }

    try {
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
    } catch (error) {
      if (error instanceof UploadSessionNotFoundError) {
        return c.json({ error: error.code, message: error.message }, 404);
      }
      if (error instanceof UploadSessionInvalidStateError) {
        return c.json({ error: error.code, message: error.message }, 409);
      }
      if (error instanceof UploadSessionIntegrityError) {
        return c.json({ error: error.code, message: error.message }, 422);
      }
      return c.json(
        {
          error: "upload_session_unavailable",
          message: "Upload verification is temporarily unavailable.",
        },
        503,
      );
    }
  });

  routes.post("/upload-sessions/grants", async (c) => {
    const appUser = await dependencies.getCurrentUser();
    if (!appUser) return c.json({ error: "Unauthorized" }, 401);

    const rateLimit = await dependencies.checkRateLimit(
      `upload-session-grants:${appUser.id}`,
      120,
      60,
    );
    if (!rateLimit.allowed) {
      c.header("Retry-After", "60");
      return c.json(
        { error: "rate_limited", message: userErrorMessage("rate_limited") },
        429,
      );
    }

    const payload = await c.req.json().catch(() => null);
    const parsed = grantUploadPartsSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid payload", issues: parsed.error.issues },
        400,
      );
    }

    try {
      return c.json(
        await dependencies.service.grant(
          appUser.actorUserId,
          parsed.data,
          appUser.workspaceId,
        ),
        200,
      );
    } catch (error) {
      if (error instanceof UploadSessionNotFoundError) {
        return c.json({ error: error.code, message: error.message }, 404);
      }
      if (error instanceof UploadSessionInvalidStateError) {
        return c.json({ error: error.code, message: error.message }, 409);
      }
      return c.json(
        {
          error: "upload_session_unavailable",
          message: "Upload grants are temporarily unavailable.",
        },
        503,
      );
    }
  });

  return routes;
}
