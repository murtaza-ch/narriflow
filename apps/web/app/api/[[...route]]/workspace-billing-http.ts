import { BillingError, type BillingErrorCode } from "@narriflow/services";

type BillingHttpStatus = 400 | 403 | 404 | 409 | 503;

const PRODUCT_FAILURES: Partial<Record<
  BillingErrorCode,
  { status: BillingHttpStatus; message: string }
>> = {
  billing_forbidden: {
    status: 403,
    message: "Only the workspace owner can manage billing.",
  },
  workspace_not_found: {
    status: 404,
    message: "The workspace could not be found.",
  },
  billing_portal_required: {
    status: 409,
    message: "Manage the current plan in the billing portal.",
  },
  checkout_attempt_conflict: {
    status: 409,
    message: "This Checkout request was already used with different details.",
  },
  checkout_attempt_terminal: {
    status: 409,
    message: "The previous Checkout is no longer available. Start a new one safely.",
  },
  checkout_session_conflict: {
    status: 409,
    message: "Checkout ownership could not be verified. Contact support.",
  },
  customer_identity_conflict: {
    status: 409,
    message: "The billing account needs support before it can be changed.",
  },
  billing_customer_missing: {
    status: 409,
    message: "No billing customer is available for this workspace.",
  },
  price_not_configured: {
    status: 503,
    message: "This plan is temporarily unavailable.",
  },
  stripe_not_configured: {
    status: 503,
    message: "Billing is temporarily unavailable.",
  },
  portal_not_configured: {
    status: 503,
    message: "The billing portal is temporarily unavailable.",
  },
  billing_catalog_invalid: {
    status: 503,
    message: "Billing is temporarily unavailable.",
  },
};

export function workspaceBillingHttpFailure(
  error: unknown,
  fallbackCode: string,
): {
  status: BillingHttpStatus;
  body: { error: string; message: string };
} {
  if (error instanceof BillingError) {
    const failure = PRODUCT_FAILURES[error.code];
    if (failure) {
      return { status: failure.status, body: { error: error.code, message: failure.message } };
    }
  }
  return {
    status: 503,
    body: {
      error: fallbackCode,
      message: "Billing is temporarily unavailable. Try again.",
    },
  };
}
