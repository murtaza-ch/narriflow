import { rehypeCodeDefaultOptions, type RehypeCodeOptions } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";
import { CODE_SHIKI_THEMES } from "../../packages/ui/src/code-theme";

type Transformer = NonNullable<RehypeCodeOptions["transformers"]>[number];
type Themes = Extract<RehypeCodeOptions, { themes: unknown }>["themes"];
const FLAGS = ["lines", "wrap", "expandable", "nocopy"] as const;
// Option names that are never part of a title when written bare.
const OPTION_WORDS = ["title", "icon", "highlight", "focus", "twoslash"];
// key={…} | key="…" | key='…' | key=bare | {1,3-4} | bare word
const TOKEN = /([A-Za-z]+)=(?:\{([^}]*)\}|"([^"]*)"|'([^']*)'|(\S+))|\{([\d,\s-]+)\}|\S+/g;

function parseRanges(spec: string | undefined): number[] {
  return (spec ?? "")
    .replace(/[[\]\s]/g, "")
    .split(",")
    .flatMap((part) => {
      const [first, last = first] = part.split("-").map(Number);
      if (first === undefined || last === undefined || !Number.isInteger(first) || !Number.isInteger(last)) return [];
      return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
    });
}

/**
 * Mintlify fence meta (`lang Title icon="x" lines wrap expandable nocopy highlight={1,3-4} focus={2}`)
 * as `data-*` strings. Shiki copies these onto the `<pre>`, where `CodeBlock` reads them.
 */
function parseMintlifyMeta(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  const words: string[] = [];
  for (const match of meta.matchAll(TOKEN)) {
    const [token, key, braced, dq, sq, bare, shorthand] = match;
    if (shorthand) {
      out["data-highlight"] = shorthand;
      continue;
    }
    if (!key) {
      if ((FLAGS as readonly string[]).includes(token)) out[`data-${token}`] = "true";
      else if (!OPTION_WORDS.includes(token)) words.push(token);
      continue;
    }
    const value = braced ?? dq ?? sq ?? bare ?? "";
    if (key === "title" || key === "icon" || key === "highlight" || key === "focus") out[`data-${key}`] = value;
    else if ((FLAGS as readonly string[]).includes(key)) {
      if (value !== "false") out[`data-${key}`] = "true";
    } else words.push(token);
  }
  if (!out["data-title"] && words.length) out["data-title"] = words.join(" ");
  return out;
}

const mintlifyMeta: Transformer = {
  name: "narriflow:mintlify-meta",
  line(node, line) {
    const meta = this.options.meta as Record<string, string> | undefined;
    if (parseRanges(meta?.["data-highlight"]).includes(line)) this.addClassToHast(node, "highlighted");
    if (parseRanges(meta?.["data-focus"]).includes(line)) this.addClassToHast(node, "focused");
  },
  pre(node) {
    const meta = this.options.meta as Record<string, string> | undefined;
    node.properties["data-lang"] = this.options.lang;
    if (meta?.["data-highlight"]) this.addClassToHast(node, "has-highlighted");
    if (meta?.["data-focus"]) this.addClassToHast(node, "has-focused");
  },
};

// MDX options for the docs in content/docs (lib/docs/source.ts).
export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      // Narriflow's one code theme, as a CSS variable per colour mode on each token (see CodeFrame);
      // the fill and base colour come from the surrounding block.
      themes: { light: CODE_SHIKI_THEMES.light, dark: CODE_SHIKI_THEMES.dark } as unknown as Themes,
      defaultColor: false,
      rootStyle: false,
      icon: false,
      tab: false,
      parseMetaString: parseMintlifyMeta,
      transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), mintlifyMeta],
    },
  },
});
