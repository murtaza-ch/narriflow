import Link from "next/link";
import { minimumAnnualSavingsPercent, PLAN_CATALOG, planHighlights, type PricingTier } from "@narriflow/validators";
import { type Plan, Plans } from "./plans";

const TIERS: Array<{ tier: PricingTier; blurb: string }> = [
  { tier: "free", blurb: "Try the whole workflow" },
  { tier: "creator", blurb: "For a weekly show" },
  { tier: "pro", blurb: "For daily posting" },
  { tier: "business", blurb: "For teams and agencies" },
];

/** Plan cards straight from the pricing constants, so the copy matches what billing enforces. */
export function Pricing() {
  const plans: Plan[] = TIERS.map(({ tier, blurb }) => {
    const plan = PLAN_CATALOG[tier];
    return {
      tier,
      blurb,
      name: plan.name,
      monthly: plan.monthlyPriceCents / 100,
      annualMonthly: plan.annualPriceCents / 1200,
      annualTotal: plan.annualPriceCents / 100,
      features: planHighlights(tier),
      featured: tier === "pro",
    };
  });
  // The smallest saving across paid plans, so the badge never overstates it.
  const savePercent = minimumAnnualSavingsPercent();

  return (
    <section className="lx-pricing" id="pricing" aria-labelledby="pricing-title">
      <div className="lx-container">
        <div className="lx-pricing__head" data-reveal="">
          <h2 id="pricing-title" className="lx-serif lx-h2">
            Pay for credits,
            <br />
            <span className="lx-dim">not guesswork.</span>
          </h2>
        </div>
        <Plans plans={plans} savePercent={savePercent} />
        <p className="lx-pricing__more">
          <Link href="/pricing" className="lx-underline">
            Compare every feature
          </Link>
        </p>
      </div>
    </section>
  );
}
