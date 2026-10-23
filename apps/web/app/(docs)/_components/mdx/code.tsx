import { Children, type ComponentPropsWithoutRef, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { Box } from "@chakra-ui/react";
import { type CodePane, CodeFrame } from "./code-frame";
import { Icon } from "./icon";
import { textOf } from "./utils";

/** What the meta transformer in `source.config.ts` leaves on a `<pre>`. */
type PreProps = ComponentPropsWithoutRef<"pre"> & {
  "data-lang"?: string;
  "data-title"?: string;
  "data-icon"?: string;
  "data-lines"?: string;
  "data-wrap"?: string;
  "data-expandable"?: string;
  "data-nocopy"?: string;
  "data-highlight"?: string;
  "data-focus"?: string;
};

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  javascript: "JavaScript",
  js: "JavaScript",
  typescript: "TypeScript",
  ts: "TypeScript",
  python: "Python",
  py: "Python",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  text: "Text",
};

// Line geometry follows the kit CodeBlock (12.5px at 1.7). Lines are grid rows so a highlight
// spans the block's full width and blank lines keep their height.
const PRE_CSS = {
  m: "0",
  overflowX: "auto",
  fontFamily: "mono",
  fontSize: "12.5px",
  lineHeight: "1.7",
  color: "fg",
  bg: "transparent",
  scrollbarWidth: "thin",
  "&:focus-visible": { outlineOffset: "-2px", borderRadius: "12px" },
  // Each token carries both modes' colours as variables (see source.config.ts); the mode picks one.
  "& .line span": {
    color: "var(--shiki-light)",
    fontStyle: "var(--shiki-light-font-style)",
    _dark: { color: "var(--shiki-dark)", fontStyle: "var(--shiki-dark-font-style)" },
  },
  "& code": { display: "grid", w: "max-content", minW: "full", counterReset: "line", fontFamily: "inherit" },
  "& .line": { px: "4", minH: "1lh" },
  "& .line.highlighted": { bg: "accent.subtle" },
  "&.has-focused .line": { opacity: 0.5, transition: "opacity 120ms ease" },
  "&.has-focused .line.focused": { opacity: 1 },
  "&[data-lines] .line::before": {
    content: "counter(line)",
    counterIncrement: "line",
    display: "inline-block",
    w: "calc(var(--digits) * 1ch)",
    me: "4",
    textAlign: "end",
    color: "fg.subtle",
    userSelect: "none",
  },
  "&[data-wrap] code": { w: "full", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
} as const;

function toPane(props: PreProps, groupTab: boolean): CodePane {
  const {
    children,
    "data-lang": lang = "text",
    "data-title": title,
    "data-icon": icon,
    "data-expandable": expandable,
    "data-nocopy": nocopy,
    "data-highlight": _highlight,
    "data-focus": _focus,
    style: _style,
    ...preProps
  } = props;
  const code = textOf(children).replace(/\n$/, "");
  const lineCount = code.split("\n").length;
  return {
    // A group tab with no title is named for its language.
    label: title ?? (groupTab ? (LANGUAGE_LABELS[lang] ?? lang) : undefined),
    icon: icon ? <Icon icon={icon} size={14} /> : null,
    code,
    lineCount,
    expandable: expandable === "true",
    nocopy: nocopy === "true",
    body: (
      <Box asChild css={{ ...PRE_CSS, "--digits": String(lineCount).length }}>
        <pre {...preProps}>{children}</pre>
      </Box>
    ),
  };
}

/** The `pre` mapping for fenced code. */
export function CodeBlock(props: PreProps) {
  return <CodeFrame panes={[toPane(props, false)]} />;
}

/** Fenced blocks arrive wrapped in fragments; peel them off to reach each one. */
function fences(children: ReactNode): Array<ReactElement<PreProps>> {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    if (child.type === Fragment) return fences(child.props.children);
    return child.type === CodeBlock ? [child as ReactElement<PreProps>] : [];
  });
}

/** `<CodeGroup>`: the fenced blocks inside become tabs in one block. */
export function CodeGroup({ children }: { children?: ReactNode }) {
  const panes = fences(children).map((fence) => toPane(fence.props, true));
  return panes.length ? <CodeFrame panes={panes} grouped /> : null;
}

/** `<RequestExample>` and `<ResponseExample>` render as code groups too. */
export const RequestExample = CodeGroup;
export const ResponseExample = CodeGroup;
