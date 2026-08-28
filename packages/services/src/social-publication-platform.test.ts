import { describe, expect, test } from "bun:test";
import {
  createDeterministicPublicationPlatform,
  createPublicationPlatformRegistry,
  PublicationPlatformConfigurationError,
  type PublicationPlatformResult,
} from "./social-publication-platform";

const results: PublicationPlatformResult[] = [
  {
    kind: "accepted",
    receipt: {
      receiptId: "receiver-operation-1",
      platformPostId: "post-1",
      externalUrl: "https://social.example/post-1",
      metrics: null,
    },
  },
  {
    kind: "pending",
    receiptId: "receiver-operation-2",
    operation: { kind: "receiver_operation", state: { id: "operation-2" } },
    nextCheckAt: new Date("2026-08-28T10:05:00.000Z"),
  },
  {
    kind: "failed",
    failure: {
      code: "receiver_rejected",
      phase: "submission",
      disposition: "permanent",
      retryAfterMs: null,
    },
  },
  {
    kind: "unknown",
    code: "receiver_response_lost",
    phase: "submission",
    operation: null,
  },
];

describe("publication platform contract", () => {
  test.each(results)("returns the normalized $kind result", async (result) => {
    const platform = createDeterministicPublicationPlatform([result]);

    await expect(
      platform.publish(
        {
          attemptId: "attempt-1",
          idempotencyKey: "publication-attempt-1",
          socialPostId: "post-1",
          projectId: "project-1",
          platform: "youtube_shorts",
          caption: "The approved caption",
          scheduledFor: new Date("2026-08-28T10:00:00.000Z"),
          providerSettings: {},
          account: null,
          media: {
            storageKey: "private/export.mp4",
            fileName: "export.mp4",
            contentType: "video/mp4",
            sizeBytes: 1024,
            aspectRatio: "9:16",
          },
        },
        {
          signal: new AbortController().signal,
          checkpoint: async () => undefined,
        },
      ),
    ).resolves.toEqual(result);
  });

  test("selects configured adapters and rejects unsupported or missing configuration", () => {
    const youtube = createDeterministicPublicationPlatform([results[0]!]);
    const registry = createPublicationPlatformRegistry({
      youtube_shorts: youtube,
    });

    expect(registry.get("youtube_shorts")).toBe(youtube);
    expect(() => registry.get("x")).toThrow(
      new PublicationPlatformConfigurationError(
        "publication_platform_not_configured",
        "Publication platform x is not configured",
      ),
    );
    expect(() => registry.get("facebook" as never)).toThrow(
      new PublicationPlatformConfigurationError(
        "publication_platform_unsupported",
        "Publication platform facebook is not supported",
      ),
    );
  });

  test("injects failures before and after the submission checkpoint", async () => {
    for (const failurePoint of ["before_submission", "after_submission"] as const) {
      let checkpoints = 0;
      const platform = createDeterministicPublicationPlatform([results[0]!], {
        failurePoint,
      });

      await expect(
        platform.publish(
          {
            attemptId: "attempt-1",
            idempotencyKey: "publication-attempt-1",
            socialPostId: "post-1",
            projectId: "project-1",
            platform: "youtube_shorts",
            caption: "The approved caption",
            scheduledFor: new Date("2026-08-28T10:00:00.000Z"),
            providerSettings: {},
            account: null,
            media: {
              storageKey: "private/export.mp4",
              fileName: "export.mp4",
              contentType: "video/mp4",
              sizeBytes: 1024,
              aspectRatio: "9:16",
            },
          },
          {
            signal: new AbortController().signal,
            checkpoint: async () => {
              checkpoints += 1;
            },
          },
        ),
      ).rejects.toMatchObject({ code: `deterministic_${failurePoint}` });
      expect(checkpoints).toBe(failurePoint === "before_submission" ? 0 : 1);
    }
  });
});
