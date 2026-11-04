import { CLOSE_CHECKPOINT_TIMEOUT_MS, type StudioEditingSession } from "./studio-editing-session";

/**
 * Leaving the Studio inside the app waits for the cloud to hold the latest
 * edits, so the next page never opens on a stale clip. A blocked or slow save
 * must not trap the user: after the timeout (or any non-current result) they
 * leave anyway and the Device Draft carries the edits. Offline there is nothing
 * to wait for, so they leave at once.
 */
export async function checkpointBeforeLeaving(
  session: Pick<StudioEditingSession, "perform">,
  timeoutMs: number = CLOSE_CHECKPOINT_TIMEOUT_MS,
  isOnline: () => boolean = () => navigator.onLine !== false,
): Promise<void> {
  if (!isOnline()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([session.perform({ type: "checkpoint-cloud" }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
