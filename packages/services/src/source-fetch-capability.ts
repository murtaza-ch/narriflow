import { AsyncLocalStorage } from "node:async_hooks";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { requireLocalFetchDevelopment } from "./local-fetch-device";
import { readServiceEnvironment } from "./runtime-environment";

const presence = new AsyncLocalStorage<(workspaceId: string) => Promise<{ available: boolean }>>();
export function withLocalFetchPresence<T>(port: (workspaceId: string) => Promise<{ available: boolean }>, operation: () => T): T { return presence.run(port, operation); }
export async function youtubeImportCapability(workspaceId: string): Promise<{ available: boolean; reason: "local_fetch_offline" | "youtube_unavailable" | null; deviceSetupAvailable: boolean }> {
  const settings = readServiceEnvironment();
  if (settings.YOUTUBE_FETCH_MODE === "proxy" && settings.YOUTUBE_PROXY_ACCEPTED === "true") return { available: true, reason: null, deviceSetupAvailable: false };
  if (settings.YOUTUBE_FETCH_MODE === "local") {
    try {
      requireLocalFetchDevelopment(settings, workspaceId);
      if ((await presence.getStore()?.(workspaceId))?.available) return { available: true, reason: null, deviceSetupAvailable: true };
      return { available: false, reason: "local_fetch_offline", deviceSetupAvailable: true };
    } catch { return { available: false, reason: "youtube_unavailable", deviceSetupAvailable: false }; }
  }
  return { available: false, reason: "youtube_unavailable", deviceSetupAvailable: false };
}
export async function requireYouTubeImport(workspaceId: string) {
  const capability = await youtubeImportCapability(workspaceId);
  if (!capability.available) throw new ExpectedDomainFailureError({ code: capability.reason!, kind: "unavailable", message: capability.reason === "local_fetch_offline"
    ? "Your development fetch device is offline. Connect it or upload the video instead."
    : "YouTube import is unavailable. Upload the video instead." });
}
