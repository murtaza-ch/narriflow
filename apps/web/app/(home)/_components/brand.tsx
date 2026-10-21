import type { CSSProperties, ReactNode } from "react";
import { StartLink } from "./actions";
import type { CaptionStyle } from "./caption-styles";
import { AUDIENCES } from "./landing-data";

const SWATCHES = ["#FFE11A", "#4A5AF0", "#FF6B3D", "#0B0B0C", "#5CF2A5", "#F4F3EF"];

type Tile = { key: string; tone: "dark" | "light" | "color"; color?: string; body: ReactNode };

function tilesFor(presets: CaptionStyle[]): Tile[][] {
  const fonts: Tile[] = presets.map((style) => ({
    key: `font-${style.id}`,
    tone: "dark",
    body: (
      <>
        <b style={{ fontFamily: `var(${style.fontVar})`, color: style.highlight, textTransform: style.transform }}>Aa</b>
        <small>{style.fontName}</small>
      </>
    ),
  }));
  const words: Tile[] = presets.slice(0, 6).map((style) => ({
    key: `word-${style.id}`,
    tone: "dark",
    body: (
      <span
        className="lx-brand__word"
        style={
          {
            fontFamily: `var(${style.fontVar})`,
            textTransform: style.transform,
            "--word-bg": style.box ?? style.highlight,
            color: style.box ? style.color : "#0B0B0C",
          } as CSSProperties
        }
      >
        {style.name.split(" ")[0]}
      </span>
    ),
  }));
  const swatches: Tile[] = SWATCHES.map((color) => ({
    key: `swatch-${color}`,
    tone: "color",
    color,
    body: <small>{color}</small>,
  }));
  const clips: Tile[] = AUDIENCES.map((clip) => ({
    key: `clip-${clip.id}`,
    tone: "dark",
    body: (
      <>
        <img src={clip.src} alt="" loading="lazy" />
        <i className="lx-brand__mark" />
      </>
    ),
  }));
  const marks: Tile[] = [
    { key: "mark-bars", tone: "light", body: <span className="lx-brand__bars"><i /><i /><i /></span> },
    { key: "mark-ring", tone: "color", color: "#4A5AF0", body: <span className="lx-brand__ring" /> },
    { key: "mark-dot", tone: "color", color: "#FFE11A", body: <span className="lx-brand__dot" /> },
  ];
  const all = [...fonts, ...words, ...swatches, ...clips, ...marks];
  // Deal the tiles into three columns so neighbours differ.
  const columns: Tile[][] = [[], [], []];
  all.forEach((tile, i) => {
    columns[i % 3]?.push(tile);
  });
  return columns;
}

/** Brand Profiles on a white field: columns of brand pieces drifting past. */
export function Brand({ presets }: { presets: CaptionStyle[] }) {
  const columns = tilesFor(presets);
  return (
    <section className="lx-brand" aria-labelledby="brand-title">
      <div className="lx-brand__grid lx-container">
        <div className="lx-brand__copy" data-reveal="">
          <h2 id="brand-title" className="lx-serif lx-h2">
            Every clip,
            <br />
            on brand.
          </h2>
          <p className="lx-lede">
            Save your fonts, colours, logo and caption style as a Brand Profile. Narriflow applies it to every clip you
            export, so the whole team posts in one voice.
          </p>
          <StartLink className="lx-mono-btn lx-mono-btn--ink">Set up your brand</StartLink>
        </div>
        <div className="lx-brand__tiles" aria-hidden="true">
          {columns.map((column, c) => (
            <div key={c} className="lx-brand__col" style={{ "--c": c } as CSSProperties}>
              <div className="lx-brand__track">
                {[...column, ...column].map((tile, i) => (
                  <span
                    key={`${tile.key}-${i}`}
                    className={`lx-brand__tile is-${tile.tone}`}
                    style={tile.color ? ({ "--tile": tile.color } as CSSProperties) : undefined}
                  >
                    {tile.body}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
