import { Hono, type Context } from "hono";
import type {
  ActorScope,
  bulkSocialSchedulingService,
  refreshTikTokInbox,
  socialPublishingOptions,
  SocialService,
} from "@narriflow/services";
import type {
  BulkSocialScheduleRequest,
  ConfirmSocialPublicationInput,
  PublishingPreviewRequest,
  RecheckSocialPublicationInput,
  RepublishSocialPublicationInput,
} from "@narriflow/validators";

export interface SocialPublicationHttpDependencies {
  getActor(context: Context): ActorScope;
  getInput<T>(context: Context): T;
  social: Pick<SocialService,
    "listProjectPosts" | "cancelPost" | "inspectPublication" |
    "recheckPublication" | "confirmPublication" | "republishPublication">;
  bulk: Pick<typeof bulkSocialSchedulingService, "preview" | "schedule">;
  publishingOptions: typeof socialPublishingOptions;
  refreshInbox: typeof refreshTikTokInbox;
}

export function createSocialPublicationHttpRoutes(dependencies: SocialPublicationHttpDependencies) {
  const routes = new Hono();

  routes.post("/projects/:id/campaign-operations/schedule/preview", async (c) => {
    const actor = dependencies.getActor(c);
    const { body } = dependencies.getInput<{ id: string; body: PublishingPreviewRequest }>(c);
    return c.json(await dependencies.bulk.preview(actor.actorUserId, actor.workspaceId, body));
  });

  routes.post("/projects/:id/campaign-operations/schedule", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, body } = dependencies.getInput<{ id: string; body: BulkSocialScheduleRequest }>(c);
    return c.json(await dependencies.bulk.schedule({
      actorUserId: actor.actorUserId,
      workspaceId: actor.workspaceId,
      projectId,
      value: body,
    }), 201);
  });

  routes.get("/projects/:id/social-accounts/:accountId/publishing-options", async (c) => {
    const actor = dependencies.getActor(c);
    const { accountId } = dependencies.getInput<{ id: string; accountId: string }>(c);
    return c.json(await dependencies.publishingOptions(actor, accountId));
  });

  routes.post("/projects/:id/social-posts/:postId/refresh-inbox", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, postId } = dependencies.getInput<{ id: string; postId: string }>(c);
    return c.json(await dependencies.refreshInbox(actor, projectId, postId));
  });

  routes.get("/projects/:id/social-posts", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId } = dependencies.getInput<{ id: string }>(c);
    const page = await dependencies.social.listProjectPosts(actor, projectId, {
      activeOnly: c.req.query("active") === "1",
      trackedIds: (c.req.query("tracked") ?? "").split(",").filter(Boolean),
      cursor: c.req.query("cursor") ?? undefined,
    });
    return c.json({ posts: page.items, nextCursor: page.nextCursor });
  });

  routes.delete("/projects/:id/social-posts/:postId", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, postId } = dependencies.getInput<{ id: string; postId: string }>(c);
    return c.json(await dependencies.social.cancelPost(actor, projectId, postId));
  });

  routes.get("/projects/:id/social-posts/:postId/publication", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, postId } = dependencies.getInput<{ id: string; postId: string }>(c);
    return c.json(await dependencies.social.inspectPublication(actor, postId, projectId));
  });

  routes.post("/projects/:id/social-posts/:postId/recheck", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, postId, body } = dependencies.getInput<{
      id: string; postId: string; body: RecheckSocialPublicationInput;
    }>(c);
    return c.json(await dependencies.social.recheckPublication(actor, postId, body, projectId));
  });

  routes.post("/projects/:id/social-posts/:postId/confirm", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, postId, body } = dependencies.getInput<{
      id: string; postId: string; body: ConfirmSocialPublicationInput;
    }>(c);
    return c.json(await dependencies.social.confirmPublication(actor, postId, body, projectId));
  });

  routes.post("/projects/:id/social-posts/:postId/publish-again", async (c) => {
    const actor = dependencies.getActor(c);
    const { id: projectId, postId, body } = dependencies.getInput<{
      id: string; postId: string; body: RepublishSocialPublicationInput;
    }>(c);
    return c.json(await dependencies.social.republishPublication(actor, postId, body, projectId), 201);
  });

  return routes;
}
