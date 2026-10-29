import { describe, expect, test } from "bun:test";
import { ADMISSION_TABLES } from "./domains";
import type { AdmissionEntry } from "./domains/platform/admission-table";

/**
 * The preserved per-operation limits of the spec (scope, key prefix, limit,
 * window seconds, capability).
 */
const PRESERVED_LIMITS: ReadonlyArray<readonly [string, "actor" | "workspace", string, number, number, string]> = [
  ["POST /autopilot/rules", "workspace", "autopilot-create", 5, 3600, "content.edit"],
  ["POST /autopilot/rules/:ruleId/run-now", "workspace", "autopilot-run", 10, 3600, "processing.consume"],
  ["POST /recipes", "workspace", "recipe-create", 30, 3600, "content.edit"],
  ["POST /recipes/:recipeId/duplicate", "workspace", "recipe-create", 30, 3600, "content.edit"],
  ["GET /library/search", "actor", "library-search", 30, 60, "content.view"],
  ["POST /projects/:id/generate", "actor", "gen", 20, 60, "processing.consume"],
  ["POST /ingest/rss/preview", "workspace", "rss-preview", 20, 60, "processing.consume"],
  ["POST /ingest/rss/import", "workspace", "rss-import", 5, 60, "processing.consume"],
  ["POST /projects/:id/clips/:clipId/title-suggestions", "actor", "clip-title-suggest", 30, 60, "processing.consume"],
  ["POST /projects/:id/clips/:clipId/duplicate", "actor", "clip-duplicate", 30, 60, "content.edit"],
  ["POST /projects/:id/clips/render", "actor", "render", 20, 60, "processing.consume"],
  ["POST /projects/:id/export-bundles", "actor", "export-bundle", 10, 3600, "content.download"],
  ["POST /projects/:id/export-bundles/preview", "actor", "export-bundle-preview", 60, 60, "content.download"],
  ["POST /projects/:id/assisted-copy/generations", "actor", "assisted-copy", 30, 60, "publishing.manage"],
  ["POST /projects/:id/thumbnail-frames", "actor", "thumbnail-frame", 30, 60, "publishing.manage"],
  ["POST /projects/:id/thumbnail-frames/:operationId/retry", "actor", "thumbnail-frame-retry", 20, 60, "publishing.manage"],
  ["POST /projects/:id/campaign-operations/preview-editor-action", "actor", "preview-campaign-editor-action", 60, 60, "content.view"],
  ["POST /projects/:id/campaign-operations/apply-brand-profile", "actor", "apply-brand-profile-selected", 20, 3600, "content.edit"],
  ["POST /projects/:id/campaign-operations/apply-style", "actor", "apply-style-selected", 20, 3600, "content.edit"],
  ["POST /projects/:id/campaign-operations/apply-motion", "actor", "apply-motion-selected", 20, 3600, "content.edit"],
  ["POST /projects/:id/export-bundles/:bundleId/retry", "actor", "export-bundle-retry", 10, 3600, "content.download"],
  ["POST /projects/:id/campaign-operations/:operationId/retry-export-bundle", "actor", "export-operation-retry", 10, 3600, "content.download"],
  ["POST /projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply", "actor", "apply-scene-template", 20, 3600, "content.edit"],
  ["POST /projects/:id/review-rounds", "actor", "review-round", 20, 3600, "review.manage"],
  ["POST /projects/:id/review-rounds/:roundId/invite", "actor", "review-invite", 20, 3600, "review.manage"],
  ["POST /projects/:id/review-rounds/:roundId/comments", "actor", "review-comment-internal", 60, 60, "review.manage"],
  ["POST /projects/:id/review-rounds/:roundId/notifications/retry", "actor", "review-notification-retry", 20, 3600, "review.manage"],
  ["POST /projects/:id/clips/:clipId/exports", "actor", "clip-export", 20, 60, "processing.consume"],
  ["POST /projects/:id/clips/:clipId/exports/:exportId/retry", "actor", "clip-export-retry", 12, 60, "processing.consume"],
  ["POST /projects/:id/clips/:clipId/exports/:exportId/share-links", "actor", "clip-share", 10, 60, "content.edit"],
  ["GET /broll/search", "actor", "broll-search", 60, 60, "content.edit"],
  ["POST /projects/:id/content-suite", "actor", "content-suite", 30, 60, "processing.consume"],
  ["POST /social/oauth/facebook-selection/:token", "actor", "facebook-page-selection", 10, 900, "social.manage"],
  ["POST /projects/:id/dubs", "actor", "dubs", 20, 60, "processing.consume"],
  ["POST /brand-templates/logo/presign", "actor", "logo-presign", 30, 60, "brand.manage"],
  ["POST /audio-assets/presign-upload", "actor", "audio-asset-presign", 30, 60, "brand.manage"],
  ["POST /upload-sessions/open", "actor", "upload-session-open", 60, 60, "processing.consume"],
  ["POST /upload-sessions/finalize", "actor", "upload-session-finalize", 60, 60, "processing.consume"],
  ["POST /upload-sessions/grants", "actor", "upload-session-grants", 120, 60, "processing.consume"],
  ["POST /upload-sessions/status", "actor", "upload-session-status", 120, 60, "processing.consume"],
  ["POST /upload-sessions/discard", "actor", "upload-session-discard", 30, 60, "processing.consume"],
  ["POST /visual-assets/presign-upload", "actor", "visual-asset-presign", 30, 60, "brand.manage"],
  ["POST /projects/:projectId/generated-media/jobs", "actor", "generated-image-create", 10, 60, "content.edit"],
  ["POST /brand-fonts/presign-upload", "actor", "brand-font-presign", 30, 60, "brand.manage"],
  ["POST /projects/:id/clips/regenerate", "actor", "regenerate", 20, 60, "processing.consume"],
  ["POST /projects/:id/campaign-operations/schedule/preview", "actor", "publishing-preview", 60, 60, "publishing.manage"],
  ["POST /projects/:id/campaign-operations/schedule", "actor", "campaign-schedule", 20, 3600, "publishing.manage"],
  ["GET /projects/:id/social-accounts/:accountId/publishing-options", "actor", "publishing-options", 30, 60, "content.view"],
  ["POST /projects/:id/social-posts/:postId/refresh-inbox", "actor", "refresh-inbox", 20, 60, "publishing.manage"],
  ["POST /zoom/oauth/start", "actor", "zoom-connect", 10, 3600, "content.edit"],
];

function declaration(key: string): AdmissionEntry | undefined {
  for (const table of Object.values(ADMISSION_TABLES)) {
    const entry = (table as Record<string, AdmissionEntry>)[key];
    if (entry) return entry;
  }
  return undefined;
}

describe("preserved admission declarations", () => {
  const present = PRESERVED_LIMITS;

  test("every preserved limit still names a declared route (a renamed key must not be skipped)", () => {
    const missing = PRESERVED_LIMITS.filter(([key]) => !declaration(key)).map(([key]) => key);
    expect(missing).toEqual([]);
  });

  test.each(present)("%s keeps its scope, bucket, window and capability", (key, scope, prefix, limit, windowSeconds, capability) => {
    const entry = declaration(key);
    expect(entry).toBeDefined();
    if (!entry || !("kind" in entry)) throw new Error(`${key} must be a session route`);
    expect(entry.capability).toBe(capability as never);
    expect(entry.rate).toEqual({
      scope,
      prefix,
      limit,
      ...(windowSeconds === 60 ? {} : { windowSeconds }),
    });
  });

  test("capability comes from the declaration, not the HTTP method", () => {
    const capabilityOf = (key: string) => {
      const entry = declaration(key);
      return entry && "capability" in entry ? entry.capability : undefined;
    };
    // Reads that are not content.view.
    expect(capabilityOf("GET /broll/search")).toBe("content.edit");
    expect(capabilityOf("GET /projects/:id/clips/:clipId/download")).toBe("content.download");
    expect(capabilityOf("GET /social/accounts")).toBe("content.view");
    expect(capabilityOf("DELETE /social/accounts/:accountId")).toBe("social.manage");
    // Writes that are not content.edit.
    expect(capabilityOf("POST /brand-templates/:id/set-default")).toBe("workspace.manage");
    expect(capabilityOf("POST /autopilot/rules/:ruleId/take-over")).toBe("workspace.manage");
    expect(capabilityOf("POST /projects/:id/campaign-operations/preview-editor-action")).toBe("content.view");
  });

  test("Project routes name the parameter that holds the Project ID", () => {
    const entry = declaration("GET /ingest/:projectId");
    expect(entry).toMatchObject({ kind: "project", projectParam: "projectId" });
    expect(declaration("GET /projects/:id")).toMatchObject({ kind: "project", projectParam: "id" });
    expect(declaration("GET /projects")).toMatchObject({ kind: "workspace" });
  });

  test("provider callbacks and webhooks declare their independent trust", () => {
    expect(declaration("GET /social/oauth/callback")).toEqual({ trust: "oauth_state" });
    expect(declaration("POST /webhooks/tiktok/publication")).toEqual({ trust: "provider_signature" });
    expect(declaration("POST /webhooks/clerk")).toEqual({ trust: "provider_signature" });
    expect(declaration("GET /health")).toEqual({ trust: "public_health" });
  });
});
