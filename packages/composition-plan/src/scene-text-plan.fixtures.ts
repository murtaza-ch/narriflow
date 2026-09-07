import type { CompositionSceneTextRender } from "./clip-composition-plan";

export interface SceneTextAdapterFixture {
  readonly id: string;
  readonly text: string;
  readonly render: CompositionSceneTextRender;
}

export const SCENE_TEXT_ADAPTER_FIXTURES: readonly SceneTextAdapterFixture[] = [
  {
    id: "wrapped-latin-title",
    text: "The quick brown",
    render: {
      lines: ["The quick", "brown"],
      fontSizePx: 108,
      lineHeightPx: 113,
      maxWidthPx: 886,
    },
  },
  {
    id: "escaped-multilingual-title",
    text: "مرحبا 新 🚀 It's 100%",
    render: {
      lines: ["مرحبا 新 🚀", "It's 100%"],
      fontSizePx: 44,
      lineHeightPx: 46,
      maxWidthPx: 886,
    },
  },
] as const;
