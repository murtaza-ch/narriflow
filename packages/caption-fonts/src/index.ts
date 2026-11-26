export { CAPTION_FONTS_DIRECTORY, captionFontFilePath } from "./paths";
export {
  type CaptionDirection,
  type CaptionOrderWord,
  type CaptionVisualItem,
  type CaptionWordOrder,
  captionWordVisualOrder,
  reorderByLevels,
  resolveBidiLevels,
} from "./bidi-order";
export {
  type CaptionClusterOffset,
  captionClusterOffsets,
  type CaptionLineLayout,
  type CaptionLinePart,
  type CaptionLineWord,
  CaptionShapingError,
  layoutCaptionLine,
  type ShapedCluster,
  type ShapedRun,
  shapeCaptionRun,
} from "./shaping";
export {
  canonicalCaptionLanguage,
  captionShapingSensitivity,
  captionRunScript,
  type CaptionRunScript,
  isShapingSensitiveText,
  LOCALE_LEAD_SCRIPTS,
  orderCaptionFallbackFaces,
} from "./locale-precedence";
export {
  CAPTION_FALLBACK_FONTS,
  type CaptionFallbackFont,
  captionFallbackFontPath,
  fontFileCovers,
  fontFileLineHeightEm,
  fontFileMetricsEm,
} from "./fallback-fonts";
export { captionGraphemes, isCaptionEmojiCluster } from "./graphemes";
export { captionCodePointLabel, captionUndrawableCodePoints } from "./glyph-coverage";
