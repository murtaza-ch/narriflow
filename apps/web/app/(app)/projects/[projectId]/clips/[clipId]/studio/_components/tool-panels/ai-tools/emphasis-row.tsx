"use client";

import { Highlighter } from "lucide-react";
import { useStudio } from "../../studio-shell";
import { captionPresetHasEmphasis } from "../captions-panel-model";
import type { AiToolRowState } from "./ai-tools-model";

/** Emphasize keywords: opens Captions at its Emphasis controls; left out for a style without a hero word. */
export function useEmphasisToolRow(): AiToolRowState | null {
  const { captionPreset, openTool } = useStudio("captionPreset", "openTool");
  if (!captionPresetHasEmphasis(captionPreset)) return null;
  return {
    id: "emphasis",
    icon: <Highlighter size={18} strokeWidth={1.75} />,
    title: "Emphasize keywords",
    description: "Highlight the words that matter",
    control: { kind: "open", onOpen: () => openTool({ tool: "captions", section: "emphasis" }) },
  };
}
