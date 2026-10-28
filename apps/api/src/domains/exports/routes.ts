import {
  campaignOperationService,
  clipExportService,
  clipTimelineService,
} from "@narriflow/services";
import {
  createClipExportSchema,
  createClipShareLinkSchema,
  createExportBundleSchema,
  resolvePricingTier,
  timelineFormatSchema,
} from "@narriflow/validators";
import { createRouteApp, getActor } from "../../http/admission";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { exportsAdmission as access } from "./admission";

/** Services the exports routes call. `runtime.ts` supplies the production instances. */
export interface ExportsRouteDeps {
  campaignOperationService: typeof campaignOperationService;
  clipExportService: typeof clipExportService;
  clipTimelineService: typeof clipTimelineService;
}

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Export bundles, versioned clip exports, subtitles, timelines and share links. */
export function createExportsRoutes(deps: ExportsRouteDeps) {
  const { campaignOperationService, clipExportService, clipTimelineService } = deps;

  return createRouteApp(access)
    .get(
      "/workspace/exports/:exportId/download",
      async (c) => {
        const exported = await clipExportService.getWorkspaceOwned(
          getActor(c),
          c.req.param("exportId"),
        );
        if (!exported) return c.json({ error: "export_not_found" }, 404);
        const requestedVariantId = c.req.query("variant");
        const variant = requestedVariantId
          ? exported.variants.find(
              (candidate) => candidate.id === requestedVariantId && candidate.downloadUrl,
            )
          : exported.variants.find((candidate) => candidate.downloadUrl);
        if (!variant?.downloadUrl) {
          return c.json(
            { error: "export_file_not_ready", message: "Export file is not ready" },
            409,
          );
        }
        return c.redirect(variant.downloadUrl, 302);
      },
    )

    .post(
      "/projects/:id/export-bundles",
      uuidParams("id"),
      requireIdempotencyKey(),
      validate("json", createExportBundleSchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await campaignOperationService.createExportBundle(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: c.req.valid("param").id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
              role: appUser.role,
              status: appUser.status,
              idempotencyKey: getIdempotencyKey(c),
            },
            c.req.valid("json"),
          ),
          202,
        );
      },
    )

    .post(
      "/projects/:id/export-bundles/preview",
      uuidParams("id"),
      validate("json", createExportBundleSchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await campaignOperationService.previewExportBundle(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: c.req.valid("param").id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
              role: appUser.role,
              status: appUser.status,
            },
            c.req.valid("json"),
          ),
          200,
        );
      },
    )

    .get(
      "/projects/:id/export-bundles",
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          {
            bundles: await campaignOperationService.listExportBundles({
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: c.req.param("id"),
            }),
          },
          200,
        );
      },
    )

    .get(
      "/projects/:id/export-bundles/:bundleId",
      uuidParams("id", "bundleId"),
      async (c) => {
        const appUser = getActor(c);
        const { id, bundleId } = c.req.valid("param");
        return c.json(
          await campaignOperationService.getExportBundle(
            { actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id },
            bundleId,
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/export-bundles/:bundleId/retry",
      uuidParams("id", "bundleId"),
      requireIdempotencyKey(),
      async (c) => {
        const appUser = getActor(c);
        const { id, bundleId } = c.req.valid("param");
        return c.json(
          await campaignOperationService.retryExportBundle(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
              role: appUser.role,
              status: appUser.status,
              idempotencyKey: getIdempotencyKey(c),
            },
            bundleId,
          ),
          202,
        );
      },
    )

    .post(
      "/projects/:id/campaign-operations/:operationId/retry-export-bundle",
      uuidParams("id", "operationId"),
      requireIdempotencyKey(),
      async (c) => {
        const appUser = getActor(c);
        const { id, operationId } = c.req.valid("param");
        return c.json(
          await campaignOperationService.retryExportBundleOperation(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
              role: appUser.role,
              status: appUser.status,
              idempotencyKey: getIdempotencyKey(c),
            },
            operationId,
          ),
          202,
        );
      },
    )

    .get(
      "/projects/:id/export-bundles/:bundleId/download",
      uuidParams("id", "bundleId"),
      async (c) => {
        const appUser = getActor(c);
        const { id, bundleId } = c.req.valid("param");
        const url = await campaignOperationService.getExportBundleDownload(
          {
            actorUserId: appUser.actorUserId,
            workspaceId: appUser.workspaceId,
            projectId: id,
            role: appUser.role,
            status: appUser.status,
          },
          bundleId,
        );
        return c.redirect(url, 307);
      },
    )

    .post(
      "/projects/:id/clips/:clipId/exports",
      requireIdempotencyKey(),
      validate("json", createClipExportSchema),
      async (c) => {
        const result = await clipExportService.create(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.valid("json"),
          getIdempotencyKey(c),
        );
        return c.json(result, result.reused && result.export.status === "ready" ? 200 : 202);
      },
    )

    .get(
      "/projects/:id/exports/current",
      uuidParams("id"),
      async (c) => {
        return c.json(
          {
            exports: await clipExportService.listCurrentProjectExports(
              getActor(c),
              c.req.valid("param").id,
            ),
          },
          200,
          NO_STORE,
        );
      },
    )

    .get(
      "/projects/:id/clips/:clipId/exports/:exportId",
      async (c) => {
        const result = await clipExportService.getOwned(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.param("exportId"),
        );
        if (!result) return c.json({ error: "export_not_found" }, 404);
        return c.json(result, 200, NO_STORE);
      },
    )

    // SRT and VTT for one export, derived on demand from its frozen snapshot.
    .get(
      "/projects/:id/clips/:clipId/exports/:exportId/subtitles/:format",
      async (c) => {
        const format = c.req.param("format");
        if (format !== "srt" && format !== "vtt") {
          return c.json({ error: "subtitle_format_invalid" }, 400);
        }
        const files = await clipExportService.getSubtitles(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.param("exportId"),
        );
        const file = files.find((entry) => entry.format === format)!;
        return c.body(file.content, 200, {
          "Content-Type":
            format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
          "Content-Disposition": `attachment; filename="${file.fileName}"`,
          ...NO_STORE,
        });
      },
    )

    // The clip's current edit as an editor timeline plus its SRT, in one ZIP.
    // The editor revision travels in a header so the page can show what it fetched.
    .get(
      "/projects/:id/clips/:clipId/timeline/:format",
      async (c) => {
        const format = timelineFormatSchema.safeParse(c.req.param("format"));
        if (!format.success) return c.json({ error: "timeline_format_invalid" }, 400);
        const archive = await clipTimelineService.archive(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          format.data,
        );
        return c.body(archive.bytes, 200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${archive.fileName}"`,
          "X-Editor-Revision": String(archive.editorRevision),
          ...NO_STORE,
        });
      },
    )

    // A Download Grant for the original source, under the file name its
    // timelines refer to. JSON, so the page can show a refusal.
    .get(
      "/projects/:id/clips/:clipId/timeline-source",
      async (c) => {
        const source = await clipTimelineService.issueSourceGrant(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          { credentialKind: "session" },
        );
        return c.json(source, 200, NO_STORE);
      },
    )

    .post(
      "/projects/:id/clips/:clipId/exports/:exportId/retry",
      async (c) => {
        const result = await clipExportService.retryFailed(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.param("exportId"),
        );
        return c.json(result, 202);
      },
    )

    .post(
      "/projects/:id/clips/:clipId/exports/:exportId/share-links",
      validate("json", createClipShareLinkSchema),
      async (c) => {
        const result = await clipExportService.createShareLink(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.param("exportId"),
          c.req.valid("json").expiresInDays,
        );
        return c.json(result, 201, NO_STORE);
      },
    )

    .delete(
      "/projects/:id/clips/:clipId/exports/:exportId/share-links",
      async (c) => {
        const result = await clipExportService.revokeShareLinks(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.param("exportId"),
        );
        return c.json(result, 200);
      },
    );
}

export type ExportsRoutes = ReturnType<typeof createExportsRoutes>;
