import { Hono, type Context } from "hono";
import type { ActorScope, ClipService } from "@narriflow/services";
import type { RegenerateClipsRequest } from "@narriflow/validators";

export function createClipGenerationHttpRoutes(dependencies: {
  getActor(context: Context): ActorScope;
  getInput<T>(context: Context): T;
  clip: Pick<ClipService, "regenerateClips">;
}) {
  const routes = new Hono();
  routes.post("/projects/:id/clips/regenerate", async (c) => {
    const actor = dependencies.getActor(c);
    const { id, body, idempotencyKey } = dependencies.getInput<{
      id: string; body: RegenerateClipsRequest; idempotencyKey: string;
    }>(c);
    return c.json(await dependencies.clip.regenerateClips(actor, id, idempotencyKey, body.contentPack), 202);
  });
  return routes;
}
