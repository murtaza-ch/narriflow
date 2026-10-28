import type {
  AutopilotRuleInput,
  AutopilotRuleUpdate,
  CreateStandingGrantInput,
  RenewStandingGrantRequest,
} from "@narriflow/validators/api/automation";
import { type ApiTransport, IDEMPOTENCY_KEY_HEADER, type WorkspaceScope } from "../core";
import { createAutomationClient } from "./client";

const keyed = (idempotencyKey: string, signal?: AbortSignal) => ({
  headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
  init: { signal },
});

/**
 * Automation commands, bound to one identity and Workspace. Creating a rule and running one now
 * are retryable acceptances: mint one key per intent (`runtime.createIntent()`) before the first
 * attempt and pass it on every retry so a lost response replays the first acceptance. Edits,
 * take-over and grant changes keep their native guards and take no key. A repeated grant create
 * answers 409 `standing_grant_duplicate`; refetch the grants rather than resubmitting.
 */
export function createAutomationActions(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createAutomationClient(transport.scoped(scope));
  const rule = client.autopilot.rules[":ruleId"];
  const grant = client.automation["standing-grants"][":grantId"];

  return {
    createRule: async (input: AutopilotRuleInput, idempotencyKey: string, signal?: AbortSignal) =>
      (await client.autopilot.rules.$post({ json: input }, keyed(idempotencyKey, signal))).json(),
    updateRule: async (ruleId: string, input: AutopilotRuleUpdate, signal?: AbortSignal) =>
      (await rule.$patch({ param: { ruleId }, json: input }, { init: { signal } })).json(),
    deleteRule: async (ruleId: string, signal?: AbortSignal) =>
      (await rule.$delete({ param: { ruleId } }, { init: { signal } })).json(),
    takeOverRule: async (ruleId: string, signal?: AbortSignal) =>
      (await rule["take-over"].$post({ param: { ruleId } }, { init: { signal } })).json(),
    runRuleNow: async (ruleId: string, idempotencyKey: string, signal?: AbortSignal) =>
      (await rule["run-now"].$post({ param: { ruleId } }, keyed(idempotencyKey, signal))).json(),

    createGrant: async (input: CreateStandingGrantInput, signal?: AbortSignal) =>
      (await client.automation["standing-grants"].$post({ json: input }, { init: { signal } })).json(),
    renewGrant: async (grantId: string, input: RenewStandingGrantRequest, signal?: AbortSignal) =>
      (await grant.renew.$post({ param: { grantId }, json: input }, { init: { signal } })).json(),
    pauseGrant: async (grantId: string, signal?: AbortSignal) =>
      (await grant.pause.$post({ param: { grantId } }, { init: { signal } })).json(),
    revokeGrant: async (grantId: string, signal?: AbortSignal) =>
      (await grant.revoke.$post({ param: { grantId } }, { init: { signal } })).json(),

    disconnectZoom: async (connectionId: string, signal?: AbortSignal) =>
      (await client.zoom.connections[":connectionId"].$delete({ param: { connectionId } }, { init: { signal } })).json(),
    /** Returns the Zoom authorization URL; a plain link cannot carry the Bearer token, so navigate to it. */
    startZoomOAuth: async (signal?: AbortSignal) =>
      (await client.zoom.oauth.start.$post(undefined, { init: { signal } })).json(),
  };
}

export type AutomationActions = ReturnType<typeof createAutomationActions>;
