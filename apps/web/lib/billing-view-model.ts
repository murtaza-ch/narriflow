import type { WorkspaceBillingView } from "@narriflow/validators";
import { formatDate, formatDateTime } from "./format";

export interface BillingStatusPresentation {
  headline: string;
  body: string;
  dateLabel: string | null;
  dateValue: string | null;
  primaryAction: "open_portal" | "retry" | "contact_support" | null;
  live: "polite" | "off";
  tone: "neutral" | "accent" | "warning" | "danger";
}

export function shouldShowSeatSyncStatus(
  view: WorkspaceBillingView,
  actorRole: "owner" | "admin" | "editor" | "viewer",
) {
  return (
    actorRole === "owner" &&
    view.plan === "business" &&
    (view.desiredAdditionalSeats !== view.synchronizedAdditionalSeats ||
      view.health === "retrying" ||
      view.health === "attention_required")
  );
}

export function billingStatusPresentation(
  view: WorkspaceBillingView,
): BillingStatusPresentation {
  if (view.workspaceAccessStatus === "restricted") {
    return {
      headline: "Workspace access is restricted",
      body: "Processing, publishing, API, MCP, and new paid members are paused. Viewing, downloads and billing repair remain available to the owner.",
      dateLabel: view.graceDeadlineAt ? "Restriction began after" : null,
      dateValue: view.graceDeadlineAt ? formatDateTime(view.graceDeadlineAt) : null,
      primaryAction: view.actions.includes("open_portal") ? "open_portal" : null,
      live: "polite",
      tone: "danger",
    };
  }
  if (view.health === "attention_required") {
    return {
      headline: "Billing needs attention",
      body: "Your verified access remains in place. Review the billing portal or contact support if the account does not recover.",
      dateLabel: "Last verified",
      dateValue: view.lastSuccessfulSyncAt
        ? formatDateTime(view.lastSuccessfulSyncAt)
        : null,
      primaryAction: view.actions.includes("open_portal")
        ? "open_portal"
        : "contact_support",
      live: "polite",
      tone: "warning",
    };
  }
  if (view.health === "activating") {
    return {
      headline: "Activating your plan",
      body: "Narriflow is verifying payment with Stripe. You can leave this page safely; activation continues in the background.",
      dateLabel: null,
      dateValue: null,
      primaryAction: null,
      live: "polite",
      tone: "accent",
    };
  }
  if (view.health === "retrying") {
    return {
      headline: "Billing sync delayed",
      body: "Your current verified access is unchanged while Narriflow retries. Do not repeat payment.",
      dateLabel: "Last verified",
      dateValue: view.lastSuccessfulSyncAt
        ? formatDateTime(view.lastSuccessfulSyncAt)
        : null,
      primaryAction: view.actions.includes("retry") ? "retry" : null,
      live: "polite",
      tone: "warning",
    };
  }
  if (view.health === "payment_action_required") {
    return {
      headline: "Payment action required",
      body: "Viewing, downloads and billing repair remain available during the recovery window. Update the payment method before the deadline to keep processing and publishing active.",
      dateLabel: "Recovery deadline",
      dateValue: view.graceDeadlineAt ? formatDateTime(view.graceDeadlineAt) : null,
      primaryAction: view.actions.includes("open_portal") ? "open_portal" : null,
      live: "polite",
      tone: "warning",
    };
  }
  if (view.cancelAtPeriodEnd) {
    return {
      headline: "Cancellation scheduled",
      body: "Paid access remains active through the current period. Open the billing portal to review or reverse the cancellation.",
      dateLabel: "Access ends",
      dateValue: view.renewalOrEndAt ? formatDate(view.renewalOrEndAt) : null,
      primaryAction: view.actions.includes("open_portal") ? "open_portal" : null,
      live: "off",
      tone: "warning",
    };
  }
  if (view.status === "payment_failed" || view.status === "payment_expired") {
    return {
      headline: "Checkout was not completed",
      body: "Your prior plan is unchanged. Start a new Checkout when you are ready.",
      dateLabel: null,
      dateValue: null,
      primaryAction: null,
      live: "polite",
      tone: "neutral",
    };
  }
  return {
    headline: view.status === "trial" ? "Trial is active" : "Billing is current",
    body:
      view.plan === "free"
        ? "This workspace is on the verified Free plan."
        : "The verified plan and workspace access are up to date.",
    dateLabel: view.renewalOrEndAt
      ? view.status === "trial"
        ? "Trial ends"
        : "Renews"
      : null,
    dateValue: view.renewalOrEndAt ? formatDate(view.renewalOrEndAt) : null,
    primaryAction:
      view.plan !== "free" && view.actions.includes("open_portal")
        ? "open_portal"
        : null,
    live: "off",
    tone: "neutral",
  };
}
