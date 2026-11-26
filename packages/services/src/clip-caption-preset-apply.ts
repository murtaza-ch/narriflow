import type { CaptionEmojiRef, EditorDocument } from "@narriflow/validators";
import type { ClipEditorProjectSelectionIntent, ClipEditorProjectSelectionResult } from "./clip-editor-document-persistence";
import { clipEmojiSuggestionFailure, type ClipEmojiSuggestion } from "./clip-emoji-suggestion";

// Apply to all for a caption preset (spec D8): with emojis on, clips that have
// none get AI emojis in the same document update as the preset. The model
// calls run after the read and before the write, never inside a transaction.

/**
 * A 60 s clip is one tagging request of about 2 to 3 s (ticket 05; first
 * uncached request up to 6.8 s). Eight at a time tags 30 clips in four rounds,
 * about 12 s. The tagger sends nothing with under 5 s left, so the last round
 * starts by 15 s and everything settles by 20 s; a clip not tagged by then
 * keeps the preset without emojis. Measured 2026-11-26 (30 clips of 60 s,
 * English and Urdu): 6.6-9.4 s wall, p50 1.7 s per clip. A failed request is
 * sent once more by the tagger (`tagCaptionEmojis`) while the budget lasts.
 */
export const CAPTION_PRESET_APPLY_EMOJI_DEFAULTS = {
  concurrency: 8,
  budgetMs: 20_000,
} as const;

export type ApplyClipEmojiSuggester = (
  clip: { clipId: string; document: EditorDocument },
  options: { deadline: number; signal?: AbortSignal },
) => Promise<ClipEmojiSuggestion>;

export interface CaptionPresetApplyPersistence {
  readProjectSelection(request: CaptionPresetApplyRequest): Promise<Array<{ clipId: string; revision: number; document: EditorDocument }>>;
  mutateProjectSelection(request: CaptionPresetApplyRequest & { intent: ClipEditorProjectSelectionIntent }): Promise<ClipEditorProjectSelectionResult>;
}

export interface CaptionPresetApplyRequest {
  actorUserId: string;
  workspaceId: string;
  projectId: string;
  excludeClipId?: string;
}

export interface CaptionPresetApplyResult {
  updated: number;
  /** Clips that had no emojis: `added` got some; `failed` could not be tagged
   *  (provider failure, no key, or out of time) or changed while they were
   *  tagged. A clip where nothing fits is in neither. */
  captionEmojis: { added: number; failed: number };
}

export async function applyCaptionPresetToProject(
  request: CaptionPresetApplyRequest & { captionPreset: EditorDocument["captionPreset"]; signal?: AbortSignal },
  deps: {
    persistence: CaptionPresetApplyPersistence;
    /** Resolves the suggester for these clips; null (or a throw) means none can be tagged. */
    prepareSuggester(clipIds: string[]): Promise<ApplyClipEmojiSuggester | null>;
    now?: () => number;
    concurrency?: number;
    budgetMs?: number;
  },
): Promise<CaptionPresetApplyResult> {
  const { signal, captionPreset, ...scope } = request;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const emojis = new Map<string, { revision: number; emojis: Record<string, CaptionEmojiRef> }>();
  let failed = 0;
  if (captionPreset.emojis) {
    const targets = (await deps.persistence.readProjectSelection(scope))
      .filter((clip) => Object.keys(clip.document.studioEdits.captionEmojis ?? {}).length === 0);
    if (targets.length > 0) {
      const suggest = await deps.prepareSuggester(targets.map((clip) => clip.clipId)).catch((error: unknown) => {
        console.warn(JSON.stringify({ level: "warn", message: "caption_preset_apply_emojis_unavailable", projectId: scope.projectId,
          error: error instanceof Error ? error.name : "unknown" }));
        return null;
      });
      failed = suggest ? 0 : targets.length;
      if (suggest) {
        const deadline = startedAt + (deps.budgetMs ?? CAPTION_PRESET_APPLY_EMOJI_DEFAULTS.budgetMs);
        let next = 0;
        const fill = async (clip: (typeof targets)[number]) => {
          if (now() >= deadline || signal?.aborted) return false;
          const suggestion = await suggest(clip, { deadline, signal }).catch(() => null);
          if (!suggestion || clipEmojiSuggestionFailure(suggestion.outcome)) return false;
          if (Object.keys(suggestion.emojis).length > 0) emojis.set(clip.clipId, { revision: clip.revision, emojis: suggestion.emojis });
          return true;
        };
        const work = async () => {
          for (;;) {
            const index = next++;
            if (index >= targets.length) return;
            if (!(await fill(targets[index]!))) failed += 1;
          }
        };
        const workers = Math.min(deps.concurrency ?? CAPTION_PRESET_APPLY_EMOJI_DEFAULTS.concurrency, targets.length);
        await Promise.all(Array.from({ length: workers }, work));
      }
      console.warn(JSON.stringify({ level: "info", message: "caption_preset_apply_emojis", projectId: scope.projectId,
        targets: targets.length, suggested: emojis.size, failed, elapsedMs: now() - startedAt }));
    }
  }
  const result = await deps.persistence.mutateProjectSelection({
    ...scope,
    intent: { kind: "set_caption_preset", captionPreset, ...(emojis.size > 0 ? { captionEmojis: emojis } : {}) },
  });
  return { updated: result.updated, captionEmojis: { added: result.captionEmojisAdded, failed: failed + result.captionEmojisStale } };
}
