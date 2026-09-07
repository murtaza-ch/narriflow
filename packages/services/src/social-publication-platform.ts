import type { Prisma } from "@prisma/client";
import {
  socialPlatformSchema,
  type ClipAspectRatio,
  type SocialPlatform,
  type SocialPostMetricsInput,
} from "@narriflow/validators";
import type { PublishSocialAccount } from "./social-oauth.service";

export type PublicationOperationPhase =
  | "preparation"
  | "upload"
  | "submission"
  | "reconciliation"
  | "cleanup";

export type PublicationFailureDisposition =
  | "safe_retry"
  | "permanent"
  | "attention";

export type PublicationPlatformFailure = {
  code: string;
  phase: PublicationOperationPhase;
  disposition: PublicationFailureDisposition;
  retryAfterMs: number | null;
  /** The provider returned definitive evidence that no public post was created. */
  safeToRepublishAfterSubmission?: boolean;
  /** Bounded provider evidence retained separately from the stable failure code. */
  evidence?: Prisma.JsonObject;
};

export type PublicationProviderOperation = {
  kind: string;
  state: Prisma.JsonObject;
  /** Stable provider operation identity used only through a one-way lookup hash. */
  lookupKey?: string;
};

export type PublicationPlatformResult =
  | {
      kind: "accepted";
      receipt: {
        receiptId: string;
        platformPostId: string | null;
        externalUrl: string | null;
        metrics: SocialPostMetricsInput | null;
        providerProcessingStatus?: "processing" | "succeeded" | "failed" | null;
        providerProcessingFailureCode?: string | null;
        providerVisibility?: string | null;
      };
    }
  | {
      kind: "pending";
      receiptId: string;
      operation: PublicationProviderOperation;
      nextCheckAt: Date;
      /** False while provider media is still being prepared before public submission. */
      submissionStarted?: boolean;
    }
  | {
      kind: "failed";
      failure: PublicationPlatformFailure;
    }
  | {
      kind: "unknown";
      code: string;
      phase: PublicationOperationPhase;
      operation: PublicationProviderOperation | null;
      retryAfterMs?: number | null;
    };

export type PublicationPlatformInput = {
  attemptId: string;
  idempotencyKey: string;
  socialPostId: string;
  projectId: string;
  platform: SocialPlatform;
  caption: string;
  scheduledFor: Date;
  providerSettings: Prisma.JsonObject;
  account: PublishSocialAccount | null;
  media: {
    storageKey: string;
    fileName: string;
    contentType: "video/mp4";
    sizeBytes: number;
    durationSec: number;
    aspectRatio: ClipAspectRatio;
  };
};

export type PublicationPlatformContext = {
  signal: AbortSignal;
  checkpoint(operation: PublicationProviderOperation): Promise<void>;
  providerCall?(): Promise<void>;
};

export type PublicationPlatformCapabilities = {
  recovery: "exact" | "bounded" | "none";
  asynchronous: boolean;
  idempotency: "provider" | "narriflow" | "none";
  requiredScopes: readonly string[];
  capabilityVersion: string;
  apiVersion: string;
  maxProviderCalls: number;
};

export interface PublicationPlatform {
  readonly capabilities: PublicationPlatformCapabilities;
  publish(
    input: PublicationPlatformInput,
    context: PublicationPlatformContext,
  ): Promise<PublicationPlatformResult>;
  /** Resume a durable provider preparation or upload without starting over. */
  resume?(
    input: PublicationPlatformInput,
    operation: PublicationProviderOperation,
    context: PublicationPlatformContext,
  ): Promise<PublicationPlatformResult>;
  reconcile?(
    input: PublicationPlatformInput,
    operation: PublicationProviderOperation,
    context: PublicationPlatformContext,
  ): Promise<PublicationPlatformResult>;
  cleanup?(
    input: PublicationPlatformInput,
    operation: PublicationProviderOperation | null,
    context: Pick<PublicationPlatformContext, "signal">,
  ): Promise<void>;
}

export class PublicationPlatformConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicationPlatformConfigurationError";
  }
}

export class PublicationPlatformExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly phase: PublicationOperationPhase,
    message: string,
  ) {
    super(message);
    this.name = "PublicationPlatformExecutionError";
  }
}

export function createPublicationPlatformRegistry(
  configured: Partial<Record<SocialPlatform, PublicationPlatform>>,
) {
  return {
    get(platform: SocialPlatform): PublicationPlatform {
      const parsed = socialPlatformSchema.safeParse(platform);
      if (!parsed.success) {
        throw new PublicationPlatformConfigurationError(
          "publication_platform_unsupported",
          `Publication platform ${String(platform)} is not supported`,
        );
      }
      const adapter = configured[parsed.data];
      if (!adapter) {
        throw new PublicationPlatformConfigurationError(
          "publication_platform_not_configured",
          `Publication platform ${parsed.data} is not configured`,
        );
      }
      return adapter;
    },
  };
}

export function createDeterministicPublicationPlatform(
  results: readonly PublicationPlatformResult[],
  options: {
    failurePoint?: "before_submission" | "after_submission";
  } = {},
): PublicationPlatform {
  let index = 0;
  return {
    capabilities: {
      recovery: "exact",
      asynchronous: true,
      idempotency: "provider",
      requiredScopes: [],
      capabilityVersion: "deterministic-v1",
      apiVersion: "deterministic-v1",
      maxProviderCalls: 10,
    },
    async publish(_input, context) {
      if (options.failurePoint === "before_submission") {
        throw new PublicationPlatformExecutionError(
          "deterministic_before_submission",
          "submission",
          "Injected failure before submission",
        );
      }
      await context.checkpoint({
        kind: "submission_started",
        state: { deterministic: true },
      });
      if (options.failurePoint === "after_submission") {
        throw new PublicationPlatformExecutionError(
          "deterministic_after_submission",
          "submission",
          "Injected failure after submission",
        );
      }
      const result = results[Math.min(index, results.length - 1)];
      if (!result) {
        throw new PublicationPlatformExecutionError(
          "deterministic_result_missing",
          "submission",
          "No deterministic result is configured",
        );
      }
      index += 1;
      return result;
    },
    async reconcile(_input, _operation, context) {
      return this.publish(_input, context);
    },
  };
}
