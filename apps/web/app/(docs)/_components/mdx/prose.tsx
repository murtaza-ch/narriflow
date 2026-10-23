import { Box } from "@chakra-ui/react";

// Prose rules sit at zero specificity (`:where`), so any component inside the
// page (cards, callouts, code frames) overrides them with a plain style prop.
const within = (selector: string) => `:where(&) :where(${selector})`;

const proseCss = {
  [within("p")]: { mt: "0", mb: "4" },
  [within("h2, h3, h4")]: { color: "fg", fontWeight: "600", letterSpacing: "-0.02em", lineHeight: "1.3", scrollMarginTop: "24", position: "relative" },
  [within("h2")]: { fontSize: "22px", mt: "10", mb: "3" },
  [within("h3")]: { fontSize: "17px", mt: "8", mb: "2" },
  [within("h4")]: { fontSize: "15px", mt: "6", mb: "2" },
  [within("h2, h3, h4") + " + :where(h3, h4)"]: { mt: "4" },
  "& [data-anchor]": {
    display: "none",
    color: "fg.subtle",
    ms: "2",
    verticalAlign: "middle",
    transition: "opacity 120ms ease, color 120ms ease",
    "@media (hover: hover)": { display: "inline-flex", opacity: 0 },
    "&:hover": { color: "fg" },
  },
  "& :is(h2, h3, h4):hover > [data-anchor], & [data-anchor]:focus-visible": { opacity: 1 },
  [within("a")]: { color: "accent.fg", textUnderlineOffset: "3px" },
  [within("a:hover")]: { textDecoration: "underline" },
  [within("strong")]: { fontWeight: "600", color: "fg" },
  [within("ul, ol")]: { mt: "0", mb: "4", ps: "22px" },
  [within("ul")]: { listStyleType: "disc" },
  [within("ol")]: { listStyleType: "decimal" },
  [within("li")]: { mb: "1.5", ps: "1" },
  ":where(&) :where(li)::marker": { color: "var(--chakra-colors-fg-subtle)" },
  [within("li > ul, li > ol")]: { mt: "1.5", mb: "0" },
  [within("li > :last-child")]: { mb: "0" },
  [within("code:not(pre code)")]: {
    fontFamily: "mono",
    fontSize: "0.86em",
    bg: "bg.soft",
    px: "1.5",
    py: "0.5",
    borderRadius: "6px",
    overflowWrap: "anywhere",
  },
  [within("a code")]: { color: "inherit" },
  // Identifiers in a table keep their width; the table scrolls instead of splitting them.
  [within("td code:not(pre code)")]: { overflowWrap: "normal" },
  [within("kbd")]: { fontFamily: "mono", fontSize: "12px", bg: "bg.soft", px: "1.5", py: "0.5", borderRadius: "6px" },
  [within("blockquote")]: { my: "5", px: "5", py: "3.5", bg: "bg.subtle", borderRadius: "12px", color: "fg.muted" },
  [within("blockquote > :first-child")]: { mt: "0" },
  [within("blockquote > :last-child")]: { mb: "0" },
  [within("hr")]: { my: "10", h: "1px", border: "0", bg: "bg.muted" },
  // Rows are soft slabs, not a grid: the fill separates them.
  [within("table")]: { w: "full", borderCollapse: "separate", borderSpacing: "0 2px", fontSize: "14px", lineHeight: "1.55" },
  [within("th")]: { textAlign: "start", color: "fg.muted", fontSize: "13px", fontWeight: "500", px: "3.5", py: "2" },
  [within("td")]: { bg: "bg.subtle", px: "3.5", py: "2.5", verticalAlign: "top" },
  [within("td:first-child")]: { borderStartRadius: "8px" },
  [within("td:last-child")]: { borderEndRadius: "8px" },
  "& > :first-child": { mt: "0" },
  "& > :last-child": { mb: "0" },
} as const;

/** Typography for everything an MDX page renders; the page frame wraps the output in it. */
export function DocsProse({ children }: { children: React.ReactNode }) {
  return (
    <Box minW="0" color="fg" fontSize="15px" lineHeight="1.7" overflowWrap="break-word" css={proseCss}>
      {children}
    </Box>
  );
}
