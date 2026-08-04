import { z } from "zod";

// Split out of brand-template.ts so studio-edits.ts (which needs it for the
// per-clip logo override schema) can import it without creating a cycle:
// clip.ts -> studio-edits.ts -> brand-template.ts -> clip.ts (brand-template
// imports captionPresetSchema from clip.ts) previously threw
// "Cannot access 'studioEditsSchema' before initialization" at module load.
// This module has zero local dependencies, so both brand-template.ts and
// studio-edits.ts can depend on it without looping back.
export const logoPositionSchema = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "mid-left",
  "center",
  "mid-right",
  "bot-left",
  "bot-center",
  "bot-right",
]);

export type LogoPosition = z.infer<typeof logoPositionSchema>;
