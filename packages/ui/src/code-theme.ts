/**
 * Narriflow's code colours, one palette per colour mode. Every code surface
 * reads from here: the kit's CodeBlock, and the docs' Shiki highlighting
 * (MDX code and the API reference). Hues follow the product's categorical
 * set (accent blue, pink, cyan, purple, amber) and avoid green; each light
 * colour keeps at least 4.5:1 on the soft code fill.
 */
export interface CodePalette {
  fg: string;
  comment: string;
  punctuation: string;
  keyword: string;
  function: string;
  type: string;
  string: string;
  constant: string;
  property: string;
}

export const CODE_PALETTE: Record<"light" | "dark", CodePalette> = {
  light: {
    fg: "#1F2328",
    comment: "#6E7781",
    punctuation: "#57606A",
    keyword: "#C8256B",
    function: "#2438E8",
    type: "#0B7570",
    string: "#9A5208",
    constant: "#7A3DC2",
    property: "#0F5A99",
  },
  dark: {
    fg: "#E6E6E9",
    comment: "#7D8590",
    punctuation: "#9A9BA3",
    keyword: "#FF7AB6",
    function: "#8AB4FF",
    type: "#5EDBD0",
    string: "#F2C48D",
    constant: "#C9A2FF",
    property: "#A8D1FF",
  },
};

type Rule = { scope: string[]; settings: { foreground?: string; fontStyle?: string } };

function rules(p: CodePalette): Rule[] {
  const rule = (foreground: string, ...scope: string[]): Rule => ({ scope, settings: { foreground } });
  return [
    { scope: ["comment", "punctuation.definition.comment", "string.quoted.docstring"], settings: { foreground: p.comment, fontStyle: "italic" } },
    rule(p.punctuation, "punctuation", "meta.brace", "keyword.operator", "punctuation.separator", "punctuation.terminator"),
    rule(p.keyword, "keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.operator.expression", "keyword.control", "punctuation.definition.template-expression"),
    rule(p.function, "entity.name.function", "support.function", "meta.function-call entity.name.function", "entity.name.command", "support.function.builtin"),
    rule(p.type, "entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.name.namespace", "storage.type.primitive", "support.type.primitive", "constant.other.option"),
    rule(p.string, "string", "string.quoted", "string.template", "string.regexp", "markup.inline.raw"),
    rule(p.constant, "constant.numeric", "constant.language", "constant.character", "variable.language", "support.constant", "variable.other.normal", "variable.other.positional", "variable.other.special", "variable.other.bracket", "punctuation.definition.variable"),
    rule(p.property, "support.type.property-name", "meta.object-literal.key", "variable.other.property", "variable.other.object.property", "entity.name.tag", "entity.other.attribute-name", "meta.mapping.key string", "punctuation.support.type.property-name"),
    // Bare shell words and the code inside `${}` are plain again.
    rule(p.fg, "string.unquoted", "meta.template.expression", "variable.parameter", "variable.other.readwrite", "variable.other.constant"),
  ];
}

/** Shiki themes (TextMate format) built from the palette; the code fill comes from the surrounding block. */
export const CODE_SHIKI_THEMES = {
  light: { name: "narriflow-light", type: "light", fg: CODE_PALETTE.light.fg, bg: "transparent", tokenColors: rules(CODE_PALETTE.light) },
  dark: { name: "narriflow-dark", type: "dark", fg: CODE_PALETTE.dark.fg, bg: "transparent", tokenColors: rules(CODE_PALETTE.dark) },
} as const;
