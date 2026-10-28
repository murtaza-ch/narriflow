import {
  acceptTikTokPublicationWebhook,
  assistedSocialCopyService,
  bulkSocialSchedulingService,
  performanceService,
  publishingQueue,
  refreshTikTokInbox,
  socialOAuthService,
  socialPublishingOptions,
  socialService,
  TikTokPublicationWebhookError,
  workspaceLibraryService,
  workspaceService,
} from "@narriflow/services";
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
      const clientKey = process.env.TIKTOK_CLIENT_KEY;
      const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
      return clientKey && clientSecret ? { clientKey, clientSecret } : null;
    },
  };
}
