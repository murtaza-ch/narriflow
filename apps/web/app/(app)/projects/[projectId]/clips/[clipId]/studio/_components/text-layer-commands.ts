import {
  type BrandTitle,
  DEFAULT_BRAND_TITLE,
  STUDIO_EDIT_LIMITS,
  type StudioTextLayer,
  type TextLayerStyle,
  type TextLayerTitlePatch,
  findTitleLayer,
  textLayerStyleSchema,
  titleTextLayer,
} from "@narriflow/validators";

/**
 * Text Layer edits the Studio makes (title-text spec sections 2 and 6), as pure functions of the
 * layer list. One title per clip in the UI: adding a title selects the one there is, a preset card
 * restyles it, and a duplicated title is body text.
 */

/** `studioEditsSchema.textLayers`'s cap; past it the document cannot save. */
export const MAX_TEXT_LAYERS = STUDIO_EDIT_LIMITS.textLayers;

/** How long a new layer lasts. */
export const NEW_TEXT_LAYER_SEC = 5;
/** The shortest a layer can be retimed to (UI floor; the schema only needs end > start). */
export const MIN_TEXT_LAYER_DURATION_SEC = 0.5;

/** Where a new body layer goes on the timeline: from the playhead for 5 s, clamped to the clip. */
export function newTextLayerTiming(playheadSec: number, clipDurationSec: number): { startSec: number; endSec: number | null } {
  const duration = Math.max(0, clipDurationSec);
  // A clip shorter than the minimum: the footage wins, the layer covers it all.
  if (duration <= MIN_TEXT_LAYER_DURATION_SEC) return { startSec: 0, endSec: null };
  const startSec = Math.max(0, Math.min(playheadSec, duration - MIN_TEXT_LAYER_DURATION_SEC));
  const endSec = Math.min(duration, startSec + NEW_TEXT_LAYER_SEC);
  return { startSec, endSec };
}

/** The words a new title starts with: the clip's title, else its hook text, else a placeholder the user types over. */
export function titleWords(clipTitle: string | null | undefined, hookText: string | null | undefined): string {
  for (const candidate of [clipTitle, hookText]) {
    if (candidate && candidate.trim()) return candidate;
  }
  return "Your title";
}

/** A new title layer from the clip's words in the brand title settings (start 0, the settings' duration). */
export function newTitleLayer(input: { id: string; clipTitle: string | null; hookText: string | null; clipDurationSec: number; settings?: BrandTitle; style?: TextLayerStyle }): StudioTextLayer {
  const settings = { ...(input.settings ?? DEFAULT_BRAND_TITLE), ...(input.style ? { style: input.style } : {}) };
  const layer = titleTextLayer({ id: input.id, text: titleWords(input.clipTitle, input.hookText), settings, editedDurationSec: Math.max(input.clipDurationSec, 0.001) });
  // `titleTextLayer` is null only without words or duration, which `titleWords` and the floor rule out.
  return layer ?? { id: input.id, role: "title", text: "Your title", startSec: 0, endSec: null, positionX: settings.positionX, positionY: settings.positionY, widthPct: settings.widthPct, style: settings.style };
}

/** A new body layer at the playhead: white bold text with a black stroke (the body defaults), lower than a title. */
export function newBodyLayer(input: { id: string; playheadSec: number; clipDurationSec: number; style?: TextLayerStyle }): StudioTextLayer {
  return {
    id: input.id,
    role: "body",
    text: "Add body text",
    ...newTextLayerTiming(input.playheadSec, input.clipDurationSec),
    positionX: 50,
    positionY: 50,
    widthPct: 86,
    style: input.style ?? textLayerStyleSchema.parse({ fontSize: 40 }),
  };
}

/** A copy of a layer just below it; a copied title is body text (one title per clip). */
export function duplicateTextLayer(layer: StudioTextLayer, id: string): StudioTextLayer {
  return { ...layer, id, role: "body", positionY: Math.min(100, layer.positionY + 8) };
}

/** Every layer but `id`. */
export function removeTextLayer(layers: readonly StudioTextLayer[], id: string): StudioTextLayer[] {
  return layers.filter((layer) => layer.id !== id);
}

/** The layers with one changed. */
export function patchTextLayer(layers: readonly StudioTextLayer[], id: string, patch: Partial<StudioTextLayer>): StudioTextLayer[] {
  return layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer));
}

/** The layers with one's style changed. */
export function patchTextLayerStyle(layers: readonly StudioTextLayer[], id: string, patch: Partial<TextLayerStyle>): StudioTextLayer[] {
  return layers.map((layer) => (layer.id === id ? { ...layer, style: { ...layer.style, ...patch } } : layer));
}

/**
 * What a preset card does: restyle the selected layer, else the clip's title; with neither, it adds
 * a title in that style (`add`).
 */
export function presetTarget(layers: readonly StudioTextLayer[], selectedId: string | null): { kind: "restyle"; id: string } | { kind: "add" } {
  const selected = selectedId ? layers.find((layer) => layer.id === selectedId) : undefined;
  if (selected) return { kind: "restyle", id: selected.id };
  const title = findTitleLayer(layers);
  return title ? { kind: "restyle", id: title.id } : { kind: "add" };
}

/** A preset's look on a layer: its colours, faces and effects, keeping the layer's size. */
export function presetStyleFor(layer: Pick<StudioTextLayer, "style">, preset: TextLayerStyle): TextLayerStyle {
  return { ...preset, fontSize: layer.style.fontSize, fontAsset: layer.style.fontAsset };
}

/** The Apply-to-all patch of a title: everything but its words. */
export function titlePatchOf(layer: StudioTextLayer): TextLayerTitlePatch {
  return { style: layer.style, positionX: layer.positionX, positionY: layer.positionY, widthPct: layer.widthPct, startSec: layer.startSec, endSec: layer.endSec ?? null };
}

/** The response of an Apply-to-all title patch (ticket 05). */
export interface ApplyTitleResult {
  readonly updated: number;
  readonly field: "title";
  readonly title: { readonly restyled: number; readonly created: number; readonly skipped: number };
}

/** The result in words: what changed, with every count (zeros too); "already matches" only when nothing changed or was skipped. */
export function applyTitleResultMessage(result: ApplyTitleResult): { title: string; description: string } {
  const { restyled, created, skipped } = result.title;
  const title = restyled + created > 0 ? "Title applied to the other clips" : skipped > 0 ? "No other clip changed" : "Every other clip already matches";
  const counts = `Updated ${restyled} · Added ${created} · Skipped ${skipped}`;
  return { title, description: skipped > 0 ? `${counts}. Skipped clips have no title text or no room for another text layer.` : counts };
}

/**
 * Why Apply to all failed. `refused`: the server answered with a refusal, so nothing changed.
 * `unknown`: no answer came back (network, timeout, a 5xx, a reply the client could not read), so
 * some clips may have changed.
 */
export function applyFailureKind(error: unknown): "refused" | "unknown" {
  const failure = error as { name?: unknown; status?: unknown; code?: unknown } | null;
  if (failure?.name !== "ApiError" || typeof failure.status !== "number") return "unknown";
  return failure.status >= 400 && failure.status < 500 && failure.code !== "scope_changed" ? "refused" : "unknown";
}

/** A composite-time range a layer is on screen. */
export interface VisibleRange {
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * Where to seek to show a layer: nowhere when the playhead is inside one of its visible ranges
 * (composite seconds, with inserted scenes cut out), else its first visible frame.
 */
export function textLayerSeekTarget(visible: readonly VisibleRange[], playheadSec: number): number | null {
  if (visible.some((range) => playheadSec >= range.startSec && playheadSec < range.endSec)) return null;
  return visible[0]?.startSec ?? null;
}

/**
 * Rows of the timeline's text lane: each layer takes the first row where it overlaps no other
 * (intervals start inclusive, end exclusive; an open end runs to the clip's end), in start order,
 * ties in document order. `count` is at least 1.
 */
export function textChipRows(layers: readonly Pick<StudioTextLayer, "id" | "startSec" | "endSec">[], clipDurationSec: number): { rows: Map<string, number>; count: number } {
  const ordered = layers.map((layer, index) => ({ layer, index })).sort((a, b) => a.layer.startSec - b.layer.startSec || a.index - b.index);
  const rowEnds: number[] = [];
  const rows = new Map<string, number>();
  for (const { layer } of ordered) {
    const end = Math.max(layer.startSec, layer.endSec ?? clipDurationSec);
    let row = rowEnds.findIndex((rowEnd) => rowEnd <= layer.startSec);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = end;
    rows.set(layer.id, row);
  }
  return { rows, count: Math.max(1, rowEnds.length) };
}
