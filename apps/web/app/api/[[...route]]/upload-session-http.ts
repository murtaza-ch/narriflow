import { Hono, type Context } from "hono";
import {
  discardUploadSessionSchema,
  finalizeUploadSessionSchema,
  grantUploadPartsSchema,
  openUploadSessionSchema,
  readUploadSessionSchema,
} from "@narriflow/validators";
import {
  type ActorScope,
  type UploadSessionService,
} from "@narriflow/services";

export interface UploadSessionHttpDependencies {
  getActor(context: Context): Promise<ActorScope>;
  service: Pick<UploadSessionService, "open" | "finalize" | "grant" | "status" | "discard">;
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
        appUser,
        parsed.data,
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
        appUser,
        parsed.data,
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
          appUser,
          parsed.data,
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
        appUser,
        parsed.data,
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
        appUser,
        parsed.data,
    );
    if (outcome.outcome === "compensating") {
      c.header("Retry-After", String(outcome.retryAfterSeconds));
      return c.json(outcome, 202);
    }
    return c.json(outcome, 200);
  });

  return routes;
}
