import type { PlatformActor } from "@narriflow/auth";
import type { ActiveProjectScope, RecordedRateLimit } from "./request-policy";
import type {
  BrowserActorScope,
  RequestActors,
  RequestPolicyRuntime,
  SignedInActorScope,
} from "./request-policy-runtime";

/** Hono bindings shared by every first-party route. */
export interface ApiEnv {
  Variables: {
    /** Set by Hono's `requestId` middleware; the only ID a request ever has. */
    requestId: string;
    /** Original Bun request, retained when a body limiter rebuilds the readable request. */
    ingressRequest?: Request;
    /** Set once a response was built by the envelope helpers, so normalization skips it. */
    errorEnvelope?: boolean;
    /** Process-wide policy; installed by `installRequestPolicy`. */
    policyRuntime?: RequestPolicyRuntime;
    /** Request-local actor promises, created lazily and discarded with the request. */
    requestActors?: RequestActors;
    /** Admitted Workspace actor (workspace and project admissions). */
    actor?: BrowserActorScope;
    /** Admitted identity-only actor (signed-in admissions). */
    signedInActor?: SignedInActorScope;
    /** Admitted Project (project admissions). */
    project?: ActiveProjectScope;
    /** Verified platform staff, set by `requireStaff`. */
    platformActor?: PlatformActor;
    /** Validated `Idempotency-Key` header, set by `requireIdempotencyKey`. */
    idempotencyKey?: string;
    /** Validated `Campaign-Retry-Of` header, set by `readCampaignRetryOf`. */
    campaignRetryOf?: string;
    /** Limiter outcome, present when the declaration set `deferRateRefusal`. */
    recordedRateLimit?: RecordedRateLimit;
  };
}
