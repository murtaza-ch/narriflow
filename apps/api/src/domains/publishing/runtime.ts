import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { acceptTikTokPublicationWebhook, TikTokPublicationWebhookError } from "@narriflow/services/social-publication-tiktok-webhook";
import { assistedSocialCopyService } from "@narriflow/services/assisted-social-copy-runtime";
import { bulkSocialSchedulingService } from "@narriflow/services/bulk-social-scheduling-runtime";
import { performanceService } from "@narriflow/services/performance.service";
import { publishingQueue } from "@narriflow/services/publishing-queue.service";
import { refreshTikTokInbox, socialPublishingOptions } from "@narriflow/services/social-publishing-options";
import { socialOAuthService } from "@narriflow/services/social-oauth.service";
import { socialService } from "@narriflow/services/social.service";
import { workspaceLibraryService } from "@narriflow/services/workspace-library.service";
import { workspaceService } from "@narriflow/services/workspace.service";
import type { ApiConfig } from "../../config";
import type { PublishingRouteDeps } from "./routes";
import type { PublishingWebhookDeps } from "./webhooks";

/** Production wiring of the publishing routes. */
export function createPublishingRouteDeps(config: ApiConfig): PublishingRouteDeps {
  return {
    socialOAuthService,
    assistedSocialCopyService,
    socialService,
    bulkSocialSchedulingService,
    publishingQueue,
    performanceService,
    workspaceLibraryService,
    workspaceService,
    socialPublishingOptions,
    refreshTikTokInbox,
    callbackOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
  };
}

/** Production wiring of the publishing webhook adapters. */
export function createPublishingWebhookDeps(): PublishingWebhookDeps {
  return {
    acceptTikTokPublicationWebhook,
    isTikTokWebhookError: (error): error is TikTokPublicationWebhookError =>
      error instanceof TikTokPublicationWebhookError,
    tiktokCredentials() {
      const clientKey = readServiceEnvironment().TIKTOK_CLIENT_KEY;
      const clientSecret = readServiceEnvironment().TIKTOK_CLIENT_SECRET;
      return clientKey && clientSecret ? { clientKey, clientSecret } : null;
    },
  };
}
