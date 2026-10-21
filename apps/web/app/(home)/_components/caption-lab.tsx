"use client";

import { useState } from "react";
import type { CaptionStyle } from "./caption-styles";
import { ClipCard } from "./clip-card";
import { AUDIENCES } from "./landing-data";

const DEFAULT_LINE = "Type anything and watch it caption itself";

function Swatch({ color }: { color: string }) {
  return (
    <>
      <i className="lx-swatch" style={{ background: color }} />
      {color.toUpperCase()}
    </>
  );
}

/** A small caption studio: real presets on the left, the live clip, and the preset's actual values. */
export function CaptionLab({ presets, presetCount }: { presets: CaptionStyle[]; presetCount: number }) {
  const [selected, setSelected] = useState(0);
  const [line, setLine] = useState("");
  const style = presets[selected] ?? presets[0];
  const clip = AUDIENCES[selected % AUDIENCES.length]!;
  const text = line.trim() || DEFAULT_LINE;
  if (!style) return null;

  return (
    <section className="lx-lab" id="captions" aria-labelledby="lab-title">
      <div className="lx-container">
      <div className="lx-lab__head" data-reveal="">
        <div>
          <p className="lx-eyebrow">Captions</p>
          <h2 id="lab-title" className="lx-serif lx-h2">
            Captions that land
            <br />
            <span className="lx-dim">on every word.</span>
          </h2>
        </div>
        <p className="lx-lede">
          {presetCount} styles, each in the same fonts and timing your export uses. Pick one, then type your own line.
        </p>
      </div>

      <div className="lx-studio" data-reveal="">
        <div className="lx-studio__bar" aria-hidden="true">
          <span className="lx-studio__dots">
            <i />
            <i />
            <i />
          </span>
          <span>Caption styles</span>
          <span className="lx-studio__live">
            <i /> Live preview
          </span>
        </div>

        <div className="lx-studio__body">
          <fieldset className="lx-studio__presets">
            <legend className="lx-sr">Caption styles</legend>
            {presets.map((preset, i) => (
              <button
                key={preset.id}
                type="button"
                className={i === selected ? "lx-preset is-on" : "lx-preset"}
                aria-pressed={i === selected}
                onClick={() => setSelected(i)}
              >
                <span
                  className="lx-preset__sample"
                  style={{
                    fontFamily: `var(${preset.fontVar})`,
                    color: preset.highlight,
                    textTransform: preset.transform,
                  }}
                  aria-hidden="true"
                >
                  Aa
                </span>
                <span className="lx-preset__name">{preset.name}</span>
                <span className="lx-preset__font">{preset.fontName}</span>
              </button>
            ))}
          </fieldset>

          <div className="lx-studio__stage">
            <ClipCard
              key={clip.id}
              src={clip.src}
              alt={clip.alt}
              score={clip.score}
              duration={clip.duration}
              caption={text}
              style={style}
              className="lx-studio__card"
            />
          </div>

          <div className="lx-studio__inspect">
            <p className="lx-studio__title">{style.name}</p>
            <dl aria-label="Selected style">
              <div>
                <dt>Font</dt>
                <dd style={{ fontFamily: `var(${style.fontVar})` }}>{style.fontName}</dd>
              </div>
              <div>
                <dt>Animation</dt>
                <dd>{style.animation}</dd>
              </div>
              <div>
                <dt>Words per cue</dt>
                <dd>{style.wordsPerCue}</dd>
              </div>
              <div>
                <dt>Text</dt>
                <dd>
                  <Swatch color={style.color} />
                </dd>
              </div>
              <div>
                <dt>Highlight</dt>
                <dd>
                  <Swatch color={style.highlight} />
                </dd>
              </div>
              <div>
                <dt>Outline</dt>
                <dd>{style.outlineWidth > 0 ? `${style.outlineWidth}px` : "None"}</dd>
              </div>
            </dl>
            <form className="lx-studio__input" onSubmit={(event) => event.preventDefault()}>
              <label htmlFor="lx-lab-line">Your line</label>
              <input
                id="lx-lab-line"
                value={line}
                maxLength={80}
                placeholder="Type your own line…"
                onChange={(event) => setLine(event.target.value)}
                autoComplete="off"
              />
            </form>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}
