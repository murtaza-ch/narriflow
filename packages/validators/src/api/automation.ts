import { z } from "zod";
import {
  type AutopilotRuleInput,
  type AutopilotRuleSnapshot,
  type AutopilotRuleUpdate,
  type ZoomConnectionSnapshot,
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
} from "../autopilot";
import type { PricingTier } from "../pricing";
import type { RecipeSnapshot } from "../recipe";
import {
  type CreateStandingGrantInput,
  type StandingGrantKind,
  type StandingGrantStatus,
  type StandingGrantView,
  createStandingGrantSchema,
  renewStandingGrantSchema,
  standingGrantReferenceSchema,
} from "../standing-grant";
import type { WorkspaceAccessStatus } from "../workspace-access";

export {
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  createStandingGrantSchema,
  standingGrantReferenceSchema,
  type AutopilotRuleInput,
  type AutopilotRuleSnapshot,
  type AutopilotRuleUpdate,
  type CreateStandingGrantInput,
  type StandingGrantView,
  type ZoomConnectionSnapshot,
};

/**
 * `POST /api/automation/standing-grants/:grantId/renew`: the renewed terms. The grant is the
 * path, so the body carries the rest of `renewStandingGrantSchema` and the same cap check.
 */
const { grantId: _grantId, ...renewTerms } = renewStandingGrantSchema.shape;
export const renewStandingGrantRequestSchema = z
  .strictObject(renewTerms)
  .superRefine((value, context) => {
    if (value.weeklyCap < value.dailyCap) {
      context.addIssue({ code: "custom", path: ["weeklyCap"], message: "The weekly cap can't be lower than the daily cap" });
    }
  });
export type RenewStandingGrantRequest = z.infer<typeof renewStandingGrantRequestSchema>;

/** A live grant as the Autopilot page lists it beside its rule. */
export interface AutopilotGrantSummary {
  id: string;
  ruleId: string;
  kind: StandingGrantKind;
  status: Extract<StandingGrantStatus, "active" | "paused">;
  destination: string;
  expiresAt: string;
}

/** `GET /api/automation`: everything the Autopilot page renders, read in parallel on the server. */
export interface AutomationOverview {
  rules: AutopilotRuleSnapshot[];
  recipes: RecipeSnapshot[];
  grants: AutopilotGrantSummary[];
  /** Whether Zoom is configured on this deployment; never a secret or an environment name. */
  zoomEnabled: boolean;
  zoomConnections: ZoomConnectionSnapshot[];
  /** Why a new active rule is refused on this plan, or null when there is room. */
  newRuleRequirement: string | null;
  newRuleUpgradeTier: PricingTier | null;
  autopilotIncluded: boolean;
  finishingAvailable: boolean;
  workspaceStatus: WorkspaceAccessStatus;
  access: {
    canEdit: boolean;
    canRun: boolean;
    canTakeOver: boolean;
    canConnectZoom: boolean;
    canManageBilling: boolean;
  };
}

/** A connected account a publish grant may target. */
export interface GrantAccountOption {
  id: string;
  label: string;
  platform: string;
}

/** `GET /api/automation/standing-grants`: everything the grants page renders. */
export interface StandingGrantsOverview {
  grants: StandingGrantView[];
  rules: Array<{ id: string; name: string }>;
  accounts: GrantAccountOption[];
  canManage: boolean;
  reviewAvailable: boolean;
  autopilotIncluded: boolean;
  pricingTier: PricingTier;
}

/** `POST /api/zoom/oauth/start`: the Zoom authorization page to send the browser to. */
export interface ZoomAuthorization {
  authorizationUrl: string;
}
