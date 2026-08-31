import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { SocialPostSnapshot } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const { SocialSchedulingPanel } = await import("./social-scheduling-panel");

const projectId = "50000000-0000-4000-8000-000000000001";

function post(
  id: string,
  overrides: Partial<SocialPostSnapshot>,
): SocialPostSnapshot {
  return {
    id,
    projectId,
    clipId: null,
    accountId: null,
    accountDisplayName: "Narriflow",
    accountHandle: "@narriflow",
    platform: "tiktok",
    status: "scheduled",
    caption: "Durable campaign copy",
    aspectRatio: "9:16",
    scheduledFor: "2026-09-01T09:00:00.000Z",
    postedAt: null,
    externalUrl: null,
    errorCode: null,
    errorDisposition: null,
    nextAttemptAt: null,
    providerProcessingStatus: null,
    providerProcessingFailureCode: null,
    providerVisibility: null,
    allowedActions: ["cancel"],
    latestMetrics: null,
    createdAt: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("SocialSchedulingPanel publishing capability", () => {
  test("keeps post history readable while hiding every publishing mutation", () => {
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <SocialSchedulingPanel
          projectId={projectId}
          clips={[]}
          posts={[
            post("50000000-0000-4000-8000-000000000002", {}),
            post("50000000-0000-4000-8000-000000000003", {
              status: "needs_attention",
              caption: "Outcome needs review",
              scheduledFor: null,
              errorCode: "publication_outcome_unknown",
              errorDisposition: "attention",
              allowedActions: [
                "recheck",
                "confirm_published",
                "publish_again",
              ],
            }),
          ]}
          accounts={[]}
          facebookPublishingEnabled
          canManagePublishing={false}
          canOverrideApproval={false}
          workspaceTimezone="UTC"
          assistedCopyEnabled
          thumbnailExtractionEnabled
          bulkSchedulingEnabled
        />
      </ChakraProvider>,
    );

    expect(markup).toContain("Durable campaign copy");
    expect(markup).toContain("Outcome needs review");
    expect(markup).toContain("Publishing is view-only");
    for (const mutation of [
      "Publish now",
      ">Schedule<",
      ">Cancel<",
      ">Recheck<",
      ">Confirm<",
      "Publish again",
    ]) {
      expect(markup).not.toContain(mutation);
    }
  });
});
