/** The harness's frames: one classic, one Dynamic and several Scene presets, LTR and Urdu. */
export interface EmojiFrameSpec {
  readonly presetId: string;
  readonly rtl: boolean;
}

export const EMOJI_FRAMES: readonly EmojiFrameSpec[] = [
  { presetId: "bold-pop", rtl: false },
  { presetId: "bold-pop", rtl: true },
  { presetId: "headline", rtl: false },
  { presetId: "headline", rtl: true },
  { presetId: "lyrics", rtl: false },
  { presetId: "lyrics", rtl: true },
  { presetId: "dialogue", rtl: false },
  { presetId: "horizon", rtl: false },
  { presetId: "index", rtl: false },
  { presetId: "bubble", rtl: true },
];

export const emojiFrameId = (frame: EmojiFrameSpec) => `${frame.presetId}${frame.rtl ? "-rtl" : ""}`;
