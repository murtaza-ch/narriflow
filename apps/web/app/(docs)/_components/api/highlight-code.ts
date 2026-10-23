import { highlight } from "fumadocs-core/highlight";
import type { ReactNode } from "react";
import { highlightOptions } from "./code-theme";

/** Server-side Shiki for the example cards. */
export function highlightCode(code: string, lang: string): Promise<ReactNode> {
  return highlight(code, highlightOptions(lang));
}
