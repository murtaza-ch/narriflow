import type { HighlightOptions } from "fumadocs-core/highlight";
import type { SystemStyleObject } from "@chakra-ui/react";
import { CODE_SHIKI_THEMES } from "@narriflow/ui/code-theme";

/**
 * Example code uses the product's one code theme, so request and response
 * panels and the playground match the MDX code blocks. Both modes are written
 * as CSS variables on each token (`defaultColor: false`); see `SHIKI_STYLES`.
 */
export function highlightOptions(lang: string): HighlightOptions {
  return { lang, themes: CODE_SHIKI_THEMES, defaultColor: false } as unknown as HighlightOptions;
}

/** The colour mode picks which of the two variables a token shows. */
export const SHIKI_STYLES: SystemStyleObject = {
  "& pre": { m: "0", p: "0", bg: "transparent", font: "inherit", overflow: "visible", outline: "none" },
  "& code": { display: "block", font: "inherit", bg: "transparent", w: "fit-content", minW: "full" },
  "& span": {
    color: "var(--shiki-light)",
    fontStyle: "var(--shiki-light-font-style)",
    _dark: { color: "var(--shiki-dark)", fontStyle: "var(--shiki-dark-font-style)" },
  },
};
