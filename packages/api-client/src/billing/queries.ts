import { queryOptions } from "@tanstack/react-query";
import {
  type BillingStateResponse,
  billingStateResponseSchema,
} from "@narriflow/validators/api/billing";
import {
  type ApiTransport,
  scopedKey,
  STALE_TIME,
  type WorkspaceScope,
} from "../core";
import { createBillingClient } from "./client";

export type { BillingStateResponse };

/** The billing state plus the pacing hint the API sent with it. */
export interface BillingStateData extends BillingStateResponse {
  /** From `Retry-After` while the state is still settling; `undefined` otherwise. */
  retryAfterSeconds?: number;
}

export const billingKeys = {
  state: (scope: WorkspaceScope) => scopedKey(scope, "billing", "state"),
};

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get("Retry-After") ?? 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Reads and validates `GET /api/billing/state` for exactly this identity and Workspace. */
export async function readBillingState(
  transport: ApiTransport,
  scope: WorkspaceScope,
  signal?: AbortSignal,
): Promise<BillingStateData> {
  const client = createBillingClient(transport.scoped(scope));
  const response = await client.billing.state.$get(undefined, {
    init: { cache: "no-store", ...(signal ? { signal } : {}) },
  });
  const state = billingStateResponseSchema.parse(await response.json());
  const pacing = retryAfterSeconds(response);
  return pacing === undefined ? state : { ...state, retryAfterSeconds: pacing };
}

/**
 * The Workspace's billing state. `staleTime: 0`: the screen re-reads it on
 * mount and while an activation is settling, which polls at the API's own
 * `Retry-After` pace (never faster than the shared floor).
 */
export function billingStateQueryOptions(input: {
  transport: ApiTransport;
  scope: WorkspaceScope;
}) {
  return queryOptions({
    queryKey: billingKeys.state(input.scope),
    queryFn: ({ signal }) => readBillingState(input.transport, input.scope, signal),
    staleTime: STALE_TIME.live,
  });
}
