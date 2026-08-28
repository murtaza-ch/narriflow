import type Stripe from "stripe";
import { BillingService } from "./billing.service";

/** Package-private access to the production adapter for isolated Stripe contracts. */
export class WorkspaceBillingStripeContractHarness extends BillingService {
  provider() {
    this.validateConfiguration();
    return this.stripeProviderAdapter();
  }

  verifyDelivery(
    rawBody: string,
    signature: string,
    contract: { stripe: Stripe; webhookSecret: string },
  ) {
    return this.verifyStripeDelivery(rawBody, signature, contract);
  }
}
