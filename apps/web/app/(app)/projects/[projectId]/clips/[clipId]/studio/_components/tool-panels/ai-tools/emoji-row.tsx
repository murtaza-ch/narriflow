"use client";

import { Smile } from "lucide-react";
import { useStudio } from "../../studio-shell";
import { captionEmojiWordShows } from "../../emoji/caption-emoji-words";
import { emojiRunFailure } from "../../emoji/emojis-section";
import type { CaptionEmojiEditor } from "../../emoji/use-caption-emojis";
import { emojiRowView, type AiToolRowState } from "./ai-tools-model";

/**
 * Add emojis: the same AI run the Emojis panel runs, through the shared per-clip run, so both
 * surfaces show the same state. Once emojis exist, or a run found none, the row opens that panel.
 */
export function useEmojiToolRow(editor: CaptionEmojiEditor): AiToolRowState | null {
  const { openTool } = useStudio("openTool");
  const view = emojiRowView({
    enabled: editor.enabled,
    shown: editor.placement.shown,
    hasWords: editor.model.words.some(captionEmojiWordShows),
    run: editor.run,
  });
  if (view.kind === "hidden") return null;
  const apply = () => {
    if (editor.readOnly) return;
    if (!editor.enabled) editor.setEnabled(true);
    editor.generate(editor.density);
  };
  const failure = editor.run.status === "failed" ? emojiRunFailure(editor.run.failure) : null;
  return {
    id: "emojis",
    icon: <Smile size={18} strokeWidth={1.75} />,
    title: "Add emojis",
    description: view.description,
    control:
      view.kind === "open"
        ? { kind: "open", onOpen: () => openTool("emojis") }
        : { kind: "apply", onApply: apply, busy: view.busy },
    // Retry here only while the clip has no emojis: replacing existing ones may need the panel's
    // Regenerate confirmation.
    error: failure ? { message: failure.message, onRetry: failure.retry && view.kind === "apply" ? apply : null } : null,
  };
}
