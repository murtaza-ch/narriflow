import { workspaceService } from "@narriflow/services";
import { createRouteApp, getActor } from "../../http/admission";
import { workspaceAdmission as access } from "./admission";

/** Services the workspace routes call. `runtime.ts` supplies the production instance. */
export interface WorkspaceRouteDeps {
  workspaceService: typeof workspaceService;
}

/** Workspace avatar upload. Profile, members and invites are added by the Workspace owner. */
export function createWorkspaceRoutes(deps: WorkspaceRouteDeps) {
  const { workspaceService } = deps;

  return createRouteApp(access)
    .post("/workspace/avatar/presign", async (c) => {
      const appUser = getActor(c);
      const payload = await c.req.json().catch(() => ({}));
      const result = await workspaceService.presignAvatarUpload(
        appUser.actorUserId,
        appUser.workspaceId,
        {
          contentType: String(payload.contentType ?? ""),
          sizeBytes: Number(payload.sizeBytes),
        },
      );
      return c.json(result, 200);
    })

    .patch("/workspace/avatar", async (c) => {
      const appUser = getActor(c);
      const payload = await c.req.json().catch(() => ({}));
      const storageKey = payload.storageKey === null ? null : String(payload.storageKey ?? "");
      await workspaceService.setAvatar(appUser.actorUserId, appUser.workspaceId, storageKey || null);
      return c.json({ ok: true }, 200);
    });
}

export type WorkspaceRoutes = ReturnType<typeof createWorkspaceRoutes>;
