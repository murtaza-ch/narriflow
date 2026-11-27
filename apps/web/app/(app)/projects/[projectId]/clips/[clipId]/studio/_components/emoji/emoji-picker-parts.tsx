"use client";

import { memo } from "react";
import { Box } from "@chakra-ui/react";
import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import type { CaptionEmojiPalette } from "@narriflow/validators";
import { captionEmojiSvgMarkup } from "./emoji-glyph";
import type { PickerLayout, PickerRow } from "./emoji-picker-model";

// The picker's virtual grid (lazy chunk, with the picker).

export const COLUMNS = 8;
export const ROW = 40;
export const HEADER = 30;
const GLYPH = 28;

// The grid draws up to ~90 cells per frame while scrolling or typing: plain elements under one
// stylesheet and memoised cells keep that cheap (Chakra style props per cell cost several times more).
const GRID_CSS = {
  "& [role=row]": { position: "absolute", left: 0, right: 0, display: "flex" },
  "& [data-header]": { alignItems: "flex-end", paddingBottom: "6px", paddingInline: "4px" },
  "& [role=rowheader]": { fontSize: "12px", fontWeight: 500, color: "var(--chakra-colors-studio-fg-subtle)" },
  "& [role=gridcell]": {
    position: "relative",
    width: `${100 / COLUMNS}%`,
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "8px",
    cursor: "pointer",
  },
  // A design drawn in the six skin tones: a quiet dot, so the tone choice's reach is visible.
  "& [role=gridcell][data-toned]::after": {
    content: '""',
    position: "absolute",
    right: "4px",
    bottom: "4px",
    width: "4px",
    height: "4px",
    borderRadius: "999px",
    background: "var(--chakra-colors-studio-fg-subtle)",
  },
  "& [role=gridcell][data-current]": { background: "var(--chakra-colors-studio-accent-subtle)" },
  "& [role=gridcell][aria-selected=true]": { background: "var(--chakra-colors-studio-raised)" },
  // A cell whose art is still loading stays empty (no placeholder disc); the cell keeps its size.
} as const;

function cellIndex(target: EventTarget): number | null {
  const cell = (target as Element).closest?.("[role=gridcell]");
  const index = cell ? Number(cell.getAttribute("data-index")) : Number.NaN;
  return Number.isInteger(index) ? index : null;
}

const GridCell = memo(function GridCell({ id, index, name, toned, active, current, art, palette, tone }: {
  id: string;
  index: number;
  name: string;
  toned: boolean;
  active: boolean;
  current: boolean;
  art: CaptionEmojiArt | null;
  palette: CaptionEmojiPalette;
  tone: number;
}) {
  // The grid is virtual (absolutely placed rows) and driven by aria-activedescendant from the search
  // field, so it cannot be a table; cells take focus only programmatically.
  return (
    // biome-ignore lint/a11y/useSemanticElements: a virtual grid's cell, see above
    <div
      id={id}
      tabIndex={-1}
      role="gridcell"
      data-index={index}
      data-toned={toned || undefined}
      data-current={current || undefined}
      aria-selected={active}
      aria-label={name}
      title={name}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: compiled art path data and checked hex colours only
      dangerouslySetInnerHTML={{ __html: art ? captionEmojiSvgMarkup(art, palette, tone, GLYPH) : "" }}
    />
  );
});

export function EmojiPickerGrid({
  gridId,
  cellId,
  layout,
  rows,
  first,
  active,
  currentId,
  art,
  palette,
  tone,
  onActive,
  onPick,
}: {
  gridId: string;
  cellId: (index: number) => string;
  layout: PickerLayout;
  /** The rows to draw (the window around the viewport) and the first one's index in `layout.rows`. */
  rows: readonly PickerRow[];
  first: number;
  active: number;
  currentId: string | null;
  art: ReadonlyMap<string, CaptionEmojiArt>;
  palette: CaptionEmojiPalette;
  tone: number;
  onActive: (index: number) => void;
  onPick: (index: number) => void;
}) {
  return (
          <Box
            id={gridId}
            role="grid"
            tabIndex={-1}
            aria-label="Emojis"
            aria-rowcount={layout.rows.length}
            position="relative"
            h={`${layout.height}px`}
            css={GRID_CSS}
            onMouseOver={(event: React.MouseEvent) => {
              const index = cellIndex(event.target);
              if (index !== null && index !== active) onActive(index);
            }}
            onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
            onClick={(event: React.MouseEvent) => {
              const index = cellIndex(event.target);
              if (index !== null) onPick(index);
            }}
          >
            {rows.map((row, at) =>
              row.kind === "header" ? (
                // biome-ignore lint/a11y/useSemanticElements: rows of a virtual grid
                <div key={`h-${row.section}`} role="row" tabIndex={-1} aria-rowindex={first + at + 1} data-header style={{ top: row.top, height: row.height }}>
                  {/* biome-ignore lint/a11y/useSemanticElements: rows of a virtual grid */}
                  <span role="rowheader" tabIndex={-1}>{row.label}</span>
                </div>
              ) : (
                // biome-ignore lint/a11y/useSemanticElements: rows of a virtual grid
                <div key={`r-${row.section}-${row.first}`} role="row" tabIndex={-1} aria-rowindex={first + at + 1} style={{ top: row.top, height: row.height }}>
                  {row.items.map((entry, column) => {
                    const index = row.first + column;
                    return (
                      <GridCell
                        key={entry.id}
                        id={cellId(index)}
                        index={index}
                        name={entry.name}
                        toned={entry.hasTones}
                        active={index === active}
                        current={entry.id === currentId}
                        art={art.get(entry.id) ?? null}
                        palette={palette}
                        tone={entry.hasTones ? tone : 0}
                      />
                    );
                  })}
                </div>
              ),
            )}
          </Box>
  );
}
