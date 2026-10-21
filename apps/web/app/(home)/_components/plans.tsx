"use client";

import { type CSSProperties, useState } from "react";
import { StartLink } from "./actions";

export type Plan = {
  tier: string;
  name: string;
  blurb: string;
  monthly: number;
  /** Annual price as a monthly figure; equals `monthly` for the free plan. */
  annualMonthly: number;
  annualTotal: number;
  features: string[];
  featured: boolean;
};

/** Plan cards with a Monthly / Annual switch. */
export function Plans({ plans, savePercent }: { plans: Plan[]; savePercent: number }) {
  const [annual, setAnnual] = useState(false);

  return (
    <>
      <div className="lx-pricing__bar" data-reveal="">
        <span>Prices in USD. One processing minute is one minute of source video.</span>
        <label className="lx-switch">
          <span>Monthly</span>
          <input type="checkbox" role="switch" aria-checked={annual} checked={annual} onChange={(event) => setAnnual(event.target.checked)} />
          <i aria-hidden="true" />
          <span>
            Annual <em>Save {savePercent}%</em>
          </span>
        </label>
      </div>

      <div className="lx-plans">
        {plans.map((plan, i) => {
          const paid = plan.monthly > 0;
          const price = annual ? plan.annualMonthly : plan.monthly;
          return (
            <article
              key={plan.tier}
              className={plan.featured ? "lx-plan is-featured" : "lx-plan"}
              data-reveal=""
              style={{ "--i": i } as CSSProperties}
            >
              <header>
                <h3>
                  {plan.name}
                  {plan.featured ? <span className="lx-tag">Most popular</span> : null}
                </h3>
                <p>{plan.blurb}</p>
              </header>
              <p className="lx-plan__price">
                <span key={`${plan.tier}-${price}`}>${price}</span>
                {annual && paid ? <s>${plan.monthly}</s> : null}
              </p>
              <p className="lx-plan__terms">
                <span>Per month</span>
                {!paid ? "Free forever" : annual ? `$${plan.annualTotal} billed yearly` : "Billed monthly"}
              </p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <StartLink className={plan.featured ? "lx-btn lx-btn--blue lx-plan__cta" : "lx-btn lx-btn--ink lx-plan__cta"}>
                {paid ? `Start with ${plan.name}` : "Start free"}
              </StartLink>
            </article>
          );
        })}
      </div>
    </>
  );
}
