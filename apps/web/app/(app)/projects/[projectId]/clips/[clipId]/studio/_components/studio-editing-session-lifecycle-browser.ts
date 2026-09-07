import type { StudioEditingSession } from "./studio-editing-session";

export interface StudioBrowserLifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface BrowserStudioSessionLifecycle {
  mount(): void;
  unmount(): void;
  suppressNavigationWarning(): void;
}

export function createBrowserStudioSessionLifecycle(
  session: Pick<StudioEditingSession, "getSnapshot" | "perform">,
  target: StudioBrowserLifecycleTarget = window,
): BrowserStudioSessionLifecycle {
  let closeTimer: number | null = null;
  let mounted = false;
  let navigationWarningSuppressed = false;

  const onPageHide = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) {
      void session.perform({ type: "close", reason: "pagehide" });
    }
  };
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) {
      void session.perform({ type: "resume" });
    }
  };
  const onBeforeUnload = (event: Event) => {
    if (
      navigationWarningSuppressed ||
      !session.getSnapshot().durability.protectsNavigation
    ) {
      return;
    }
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };

  return {
    mount: () => {
      if (closeTimer !== null) {
        target.clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (mounted) return;
      mounted = true;
      target.addEventListener("pagehide", onPageHide);
      target.addEventListener("pageshow", onPageShow);
      target.addEventListener("beforeunload", onBeforeUnload);
      void session.perform({ type: "start" });
    },
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      target.removeEventListener("pagehide", onPageHide);
      target.removeEventListener("pageshow", onPageShow);
      target.removeEventListener("beforeunload", onBeforeUnload);
      closeTimer = target.setTimeout(() => {
        closeTimer = null;
        void session.perform({ type: "close", reason: "unmount" });
      }, 0);
    },
    suppressNavigationWarning: () => {
      navigationWarningSuppressed = true;
    },
  };
}
