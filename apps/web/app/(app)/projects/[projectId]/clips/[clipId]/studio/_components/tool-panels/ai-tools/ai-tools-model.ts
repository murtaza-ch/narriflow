import type { ReactNode } from "react";
import type { PricingTier } from "@narriflow/validators";
import { captionEmojiRunBusy, type CaptionEmojiRun } from "../../emoji/caption-emoji-runs";
import type { CleanupCuts } from "../../cleanup-cuts";

// Pure decisions behind the AI tools panel. Each row is a front door to a tool the Studio already
// has: these functions only say what the row shows; the tools' own functions do the work.

export type AiToolId = "emojis" | "silences" | "fillers" | "reframe" | "censor" | "emphasis" | "broll";

/** Row order, as in the panel. */
export const AI_TOOL_ORDER: readonly AiToolId[] = ["emojis", "silences", "fillers", "reframe", "censor", "emphasis", "broll"];

export type AiToolControl =
  /** A one-shot edit (one undo step). `busy` shows progress inside the button. */
  | { readonly kind: "apply"; readonly onApply: () => void; readonly busy?: boolean }
  /** Opens the tool's own panel; `status` is a quiet word beside the chevron ("On"). */
  | { readonly kind: "open"; readonly onOpen: () => void; readonly status?: string }
  /** Nothing to do (nothing found). */
  | { readonly kind: "none" };

export interface AiToolRowState {
  readonly id: AiToolId;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  /** A quiet second line (speaker analysis still running). */
  readonly note?: string | null;
  readonly control: AiToolControl;
  /** The plan gem when the tool's apply step needs a higher plan. */
  readonly gem?: PricingTier | null;
  readonly error?: { readonly message: string; readonly onRetry: (() => void) | null } | null;
}

/** "7 silences, 4.2 s shorter", or the row's empty line when there is nothing to cut. */
export function cleanupCutsDescription(cuts: Pick<CleanupCuts, "count" | "removedSec">, noun: { one: string; many: string }, empty: string): string {
  if (cuts.count === 0 || cuts.removedSec <= 0) return empty;
  return `${cuts.count} ${cuts.count === 1 ? noun.one : noun.many}, ${cuts.removedSec.toFixed(1)} s shorter`;
}

export const EMOJI_ROW_DESCRIPTION = "AI adds emojis that match what is said";

export type EmojiRowView =
  /** No caption word shows, so there is nothing to put an emoji on: the row is left out. */
  | { readonly kind: "hidden" }
  /** Apply runs the AI (busy while saving or running). */
  | { readonly kind: "apply"; readonly description: string; readonly busy: boolean }
  /** Emojis exist: the count, and the way to edit them. */
  | { readonly kind: "open"; readonly description: string };

/** What the emoji row shows for the clip's emojis and the shared per-clip run. */
export function emojiRowView(input: { readonly enabled: boolean; readonly shown: number; readonly hasWords: boolean; readonly run: CaptionEmojiRun }): EmojiRowView {
  const busy = captionEmojiRunBusy(input.run);
  if (busy) return { kind: "apply", description: input.run.status === "saving" ? "Saving your edits first" : EMOJI_ROW_DESCRIPTION, busy: true };
  if (!input.hasWords) return { kind: "hidden" };
  if (input.shown > 0) {
    const count = `${input.shown} emoji${input.shown === 1 ? "" : "s"}`;
    return { kind: "open", description: input.enabled ? count : `${count}, turned off` };
  }
  const empty = input.run.status === "done" && input.run.added === 0;
  return { kind: "apply", description: empty ? "No emojis fit this clip" : EMOJI_ROW_DESCRIPTION, busy: false };
}

/** "3 words found", with what is censored already; the Censor panel's own count line, shorter. */
export function censorRowDescription(found: number, censored: number): string {
  const censoredPart = censored > 0 ? `${censored} censored` : null;
  if (found === 0) return censoredPart ?? "No sensitive words found";
  const foundPart = `${found} ${found === 1 ? "word" : "words"} found`;
  return censoredPart ? `${foundPart}, ${censoredPart}` : foundPart;
}

/** The quiet line Auto reframe shows while speaker analysis cannot place the speaker yet. */
export function reframeNote(status: "available" | "pending" | "failed"): string | null {
  if (status === "pending") return "Speaker analysis is still running";
  if (status === "failed") return "Speaker analysis isn’t available for this clip";
  return null;
}

/** Shown rows in panel order; a row that cannot work for this clip is left out, never greyed. */
export function orderAiToolRows(rows: readonly (AiToolRowState | null)[]): AiToolRowState[] {
  const shown = rows.filter((row): row is AiToolRowState => row !== null);
  return AI_TOOL_ORDER.flatMap((id) => shown.filter((row) => row.id === id));
}

/** Read-only (another tab holds the write lease): Apply is not offered, chevrons still open panels. */
export function rowControl(control: AiToolControl, readOnly: boolean): AiToolControl {
  return readOnly && control.kind === "apply" ? { kind: "none" } : control;
}
