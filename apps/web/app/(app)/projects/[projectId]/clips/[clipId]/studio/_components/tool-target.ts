import type { ToolId } from "./studio-shell";

// Opening a tool at a place: the AI tools panel opens Captions on its Emphasis controls.
// The shell holds the target until the opened panel reads it once on mount.

export type CaptionsPanelSection = "emphasis";

export type ToolTarget = { readonly tool: "captions"; readonly section: CaptionsPanelSection };

/** What `openTool` is given: a tool, or a tool at a place. */
export type ToolOpening = ToolId | ToolTarget;

export function resolveToolOpening(opening: ToolOpening): { tool: ToolId; target: ToolTarget | null } {
  return typeof opening === "string" ? { tool: opening, target: null } : { tool: opening.tool, target: opening };
}

/** The section lives on the Customize tab. */
export function captionsPanelTab(target: ToolTarget | null): "presets" | "customize" {
  return target ? "customize" : "presets";
}

/** Marks a section a target can reach; `revealPanelSection` scrolls to it. */
export const panelSectionAttribute = (section: CaptionsPanelSection) => ({ "data-panel-section": section });

/** Marks the tool panel's scrolling body. */
export const PANEL_SCROLL_ATTRIBUTE = "data-tool-panel-scroll";

/** Marks a panel header that sticks while the body scrolls; a revealed section lands below it. */
export const PANEL_STICKY_ATTRIBUTE = "data-panel-sticky";

/** Scrolls the panel body so the section's top sits just below the panel's sticky header. */
export function revealPanelSection(root: HTMLElement | null, section: CaptionsPanelSection): void {
  const element = root?.querySelector<HTMLElement>(`[data-panel-section="${section}"]`);
  const container = element?.closest<HTMLElement>(`[${PANEL_SCROLL_ATTRIBUTE}]`);
  if (!element || !container) return;
  const sticky = root?.querySelector<HTMLElement>(`[${PANEL_STICKY_ATTRIBUTE}]`);
  const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - (sticky?.offsetHeight ?? 0) - 8;
  container.scrollTo({ top: Math.max(0, top) });
}
