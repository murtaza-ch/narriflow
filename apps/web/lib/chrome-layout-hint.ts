/**
 * The size of the chrome's variable slots from the last ready render, so the
 * pending chrome of the next hard load reserves the same space before the
 * first paint. Only layout numbers are kept: widths in CSS pixels and whether
 * "New project" is shown. No names, balances, plan or Workspace ids.
 *
 * Writing happens after a ready render (`rememberChromeLayout`). Reading
 * happens once, before the first paint, in `CHROME_LAYOUT_SCRIPT`, which sets
 * custom properties on `<html>`. The placeholders read those properties with
 * today's sizes as fallbacks, so nothing reads storage during render and the
 * server HTML equals the first client render. A stale hint costs at most the
 * one-time shift there is without one: the ready controls keep their own size.
 */

export const CHROME_LAYOUT_KEY = "narriflow-chrome-layout";

/** Custom properties the placeholders read; the fallbacks are the sizes without a hint. */
export const CHROME_LAYOUT_VARS = {
  /** The header balance box (at least "0,000" without a hint). */
  balance: "--nf-chrome-balance",
  /** The credits pill beyond its trigger: the gold Upgrade button and its gap (0 without a hint). */
  upgrade: "--nf-chrome-upgrade",
  /** The Invite slot's width (the button's own without a hint). */
  invite: "--nf-chrome-invite",
  /** `none` when the last ready render had no Invite. */
  inviteDisplay: "--nf-chrome-invite-display",
  /** `none` when the last ready render had no "New project". */
  newProjectDisplay: "--nf-chrome-new-project-display",
} as const;

export interface ChromeLayout {
  balance: number;
  upgrade: number;
  invite: number;
  newProject: boolean;
}

/** Upper bounds for a stored width; anything outside is ignored as corrupt. */
export const CHROME_LAYOUT_MAX = { balance: 200, upgrade: 240, invite: 240 } as const;

/**
 * Runs before the first paint: the app layout emits it as an inline script
 * ahead of the chrome. Tiny and dependency-free: it validates every field on
 * its own and ignores the rest.
 */
export const CHROME_LAYOUT_SCRIPT = `(() => {
  try {
    const hint = JSON.parse(localStorage.getItem(${JSON.stringify(CHROME_LAYOUT_KEY)}) || "null");
    if (!hint || typeof hint !== "object") return;
    const style = document.documentElement.style;
    const width = (value, max) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
    if (width(hint.balance, ${CHROME_LAYOUT_MAX.balance})) style.setProperty(${JSON.stringify(CHROME_LAYOUT_VARS.balance)}, hint.balance + "px");
    if (width(hint.upgrade, ${CHROME_LAYOUT_MAX.upgrade})) style.setProperty(${JSON.stringify(CHROME_LAYOUT_VARS.upgrade)}, hint.upgrade + "px");
    if (width(hint.invite, ${CHROME_LAYOUT_MAX.invite})) {
      style.setProperty(${JSON.stringify(CHROME_LAYOUT_VARS.invite)}, hint.invite + "px");
      if (hint.invite === 0) style.setProperty(${JSON.stringify(CHROME_LAYOUT_VARS.inviteDisplay)}, "none");
    }
    if (hint.newProject === false) style.setProperty(${JSON.stringify(CHROME_LAYOUT_VARS.newProjectDisplay)}, "none");
  } catch {}
})();`;

/** `var(--name, fallback)` for a placeholder style prop. */
export function chromeVar(name: keyof typeof CHROME_LAYOUT_VARS, fallback: string): string {
  return `var(${CHROME_LAYOUT_VARS[name]}, ${fallback})`;
}

/** Marks the real controls the measurement reads. */
export const CHROME_SLOT = "data-chrome-slot";
/** On the default shell's top bar only: the one that has an Invite slot. */
export const CHROME_TOP_BAR = "data-chrome-top-bar";

const round = (value: number) => Math.round(value * 100) / 100;

function width(element: Element): number {
  return element.getBoundingClientRect().width;
}

/**
 * Measures what the ready chrome under `root` shows. A slot that is not laid
 * out (the desktop bar on a phone, a page with no credits pill) is left out,
 * so the value from the last time it was seen is kept.
 */
export function measureChromeLayout(root: ParentNode): Partial<Omit<ChromeLayout, "newProject">> {
  const measured: Partial<Omit<ChromeLayout, "newProject">> = {};
  const pill = root.querySelector(`[${CHROME_SLOT}="credits"]`);
  const trigger = pill?.querySelector(`[${CHROME_SLOT}="credits-trigger"]`);
  const balance = pill?.querySelector(`[${CHROME_SLOT}="balance"]`);
  if (pill && trigger && balance && width(pill) > 0) {
    const view = pill.ownerDocument.defaultView;
    const style = view?.getComputedStyle(pill);
    const padding = (Number.parseFloat(style?.paddingLeft ?? "") || 0) + (Number.parseFloat(style?.paddingRight ?? "") || 0);
    measured.upgrade = round(Math.max(0, width(pill) - width(trigger) - padding));
    measured.balance = round(width(balance));
  }
  const bar = root.querySelector(`[${CHROME_TOP_BAR}]`);
  if (bar && width(bar) > 0) {
    const invite = bar.querySelector(`[${CHROME_SLOT}="invite"]`);
    measured.invite = invite ? round(width(invite)) : 0;
  }
  return measured;
}

/** The stored hint's valid fields; anything else is dropped. */
export function readChromeLayout(raw: string | null): Partial<ChromeLayout> {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const hint: Partial<ChromeLayout> = {};
  for (const name of ["balance", "upgrade", "invite"] as const) {
    const field = record[name];
    if (typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= CHROME_LAYOUT_MAX[name]) hint[name] = field;
  }
  if (typeof record.newProject === "boolean") hint.newProject = record.newProject;
  return hint;
}

type HintStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Merges what was measured into the stored hint and writes it only when a
 * value changed. Storage may be missing or refuse; the chrome works without it.
 */
export function writeChromeLayout(
  storage: HintStorage | null,
  next: Partial<Omit<ChromeLayout, "newProject">> & { newProject: boolean },
): void {
  if (!storage) return;
  try {
    const previous = storage.getItem(CHROME_LAYOUT_KEY);
    const current = readChromeLayout(previous);
    const merged: Partial<ChromeLayout> = {};
    for (const name of ["balance", "upgrade", "invite"] as const) {
      const value = next[name] ?? current[name];
      if (value !== undefined && value <= CHROME_LAYOUT_MAX[name]) merged[name] = value;
    }
    merged.newProject = next.newProject;
    const serialized = JSON.stringify(merged);
    if (serialized !== previous) storage.setItem(CHROME_LAYOUT_KEY, serialized);
  } catch {
    // Private mode, a full quota or blocked storage: the hint is only a convenience.
  }
}

function browserStorage(): HintStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Measures the ready chrome once fonts have loaded and the frame has been laid
 * out, then stores the hint. Returns a cancel for the effect that started it.
 */
export function rememberChromeLayout(newProject: boolean): () => void {
  let cancelled = false;
  let frame = 0;
  const measure = () => {
    frame = requestAnimationFrame(() => {
      if (!cancelled) writeChromeLayout(browserStorage(), { ...measureChromeLayout(document), newProject });
    });
  };
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready) void fonts.ready.then(measure, measure);
  else measure();
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
