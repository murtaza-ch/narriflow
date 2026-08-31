import { createBrowserIntentKeyStore } from "@/lib/browser-intent-key";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createReviewBrowserIntents(dependencies: {
  storage: BrowserStorage;
  createId(): string;
}) {
  const keys = createBrowserIntentKeyStore(dependencies);

  function handle(namespace: string, intent: unknown) {
    return {
      idempotencyKey: keys.forIntent(namespace, intent),
      confirm: () => keys.confirm(namespace, intent),
    };
  }

  return {
    createRound(projectId: string, request: unknown) {
      return handle(`review:create:${projectId}`, request);
    },

    resendRound(projectId: string, roundId: string) {
      return handle(`review:resend:${projectId}:${roundId}`, {
        action: "resend",
        projectId,
        roundId,
      });
    },

    retryNotification(
      projectId: string,
      roundId: string,
      notificationId: string,
    ) {
      return handle(
        `review:notification-retry:${projectId}:${roundId}:${notificationId}`,
        { action: "retry", projectId, roundId, notificationId },
      );
    },
  };
}
