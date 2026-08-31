import { createBrowserIntentKeyStore } from "@/lib/browser-intent-key";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function assistedCopyIntentIsSettled(status: string) {
  return status !== "generating";
}

export function createPublishingPreparationBrowserIntents(dependencies: {
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
    assistedCopy(projectId: string, clipId: string, request: unknown) {
      return handle(`assisted-copy:${projectId}:${clipId}`, request);
    },

    thumbnail(projectId: string, exportVariantId: string, request: unknown) {
      return handle(
        `thumbnail:${projectId}:${exportVariantId}`,
        request,
      );
    },
  };
}
