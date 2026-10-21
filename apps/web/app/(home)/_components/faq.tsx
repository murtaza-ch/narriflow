"use client";

import { useId, useState } from "react";
import { FAQS } from "./landing-data";

export function Faq() {
  const [open, setOpen] = useState(0);
  const baseId = useId();

  return (
    <section className="lx-faq lx-container" aria-labelledby="faq-title">
      <div className="lx-faq__head" data-reveal="">
        <h2 id="faq-title" className="lx-serif lx-h2">
          Frequently asked questions
        </h2>
      </div>
      <div className="lx-faq__list">
        {FAQS.map((item, i) => {
          const expanded = open === i;
          const panelId = `${baseId}-panel-${i}`;
          const buttonId = `${baseId}-button-${i}`;
          return (
            <div key={item.q} className={expanded ? "lx-qa is-open" : "lx-qa"} data-reveal="">
              <h3>
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => setOpen(expanded ? -1 : i)}
                >
                  {item.q}
                  <span className="lx-qa__icon" aria-hidden="true" />
                </button>
              </h3>
              <section id={panelId} aria-labelledby={buttonId} className="lx-qa__panel" inert={!expanded}>
                <div>
                  <p>{item.a}</p>
                </div>
              </section>
            </div>
          );
        })}
      </div>
    </section>
  );
}
