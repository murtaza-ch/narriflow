"use client";

import { Clapperboard } from "lucide-react";
import { useStudio } from "../../studio-shell";
import type { AiToolRowState } from "./ai-tools-model";

/** B-roll: opens the B-roll panel (a clip holds one cutaway). */
export function useBrollToolRow(): AiToolRowState {
  const { brollUrl, openTool } = useStudio("brollUrl", "openTool");
  return {
    id: "broll",
    icon: <Clapperboard size={18} strokeWidth={1.75} />,
    title: "B-roll",
    description: brollUrl ? "Cutaway added" : "Add visuals over your clip",
    control: { kind: "open", onOpen: () => openTool("broll") },
  };
}
