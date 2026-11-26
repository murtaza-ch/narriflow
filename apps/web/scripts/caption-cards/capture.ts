export interface CaptureBrowser {
  evaluate<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export const PAINTED = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

export class Reloaded extends Error {
  constructor(id: string) {
    super(`${id}: the page reloaded while recording`);
  }
}

async function assertHealthy(browser: CaptureBrowser, id: string, take: string): Promise<void> {
  const state = await browser.evaluate<{ same: boolean; error: string | null }>(`(() => ({
    same: window.__card?.run === ${JSON.stringify(take)},
    error: [...document.querySelectorAll("nextjs-portal")].map((portal) => {
      const dialog = portal.shadowRoot?.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay]");
      return dialog ? dialog.textContent?.trim().slice(0, 1000) || "error dialog" : null;
    }).find(Boolean) ?? null
  }))()`);
  // The overlay leaves __card mounted, so the take check alone cannot detect it. Check even hidden dialogs:
  // hiding the portal is not evidence of a successful build, and its shadow styles can override that rule.
  if (state.error) throw new Error(`${id}: Next.js error overlay appeared while recording; no assets were replaced: ${state.error}`);
  if (!state.same) throw new Reloaded(id);
}

/** Reject the whole take if an error or remount appears before or during a screenshot. */
export async function captureCardFrame(
  browser: CaptureBrowser,
  id: string,
  take: string,
  seconds: number,
  box: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  await assertHealthy(browser, id, take);
  await browser.evaluate(`(window.__card.set(${seconds}), ${PAINTED})`);
  await assertHealthy(browser, id, take);
  const { data } = await browser.send<{ data: string }>("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { ...box, scale: 1 } });
  await assertHealthy(browser, id, take);
  return Buffer.from(data, "base64");
}
