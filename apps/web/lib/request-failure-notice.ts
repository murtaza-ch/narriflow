/**
 * Pages that send a member without the needed access to Home name themselves
 * in `from`, so Home can say what they could not do. Home reads the pair and
 * `requestFailureNotice` words it; nothing else decides this copy.
 */
export type DeniedFrom = "upload" | "studio" | "project" | "brand-kit" | "api-settings" | "calendar";

const WHAT_NEEDS_EDITOR: Record<DeniedFrom, string> = {
  upload: "upload videos",
  studio: "edit clips in the Studio",
  project: "open that project page",
  "brand-kit": "create brand profiles and caption styles",
  "api-settings": "manage API keys and webhooks",
  calendar: "schedule posts",
};

const ASK_ADMIN = "Ask a workspace admin to change your role.";

function isDeniedFrom(value: string | null): value is DeniedFrom {
  return value !== null && Object.hasOwn(WHAT_NEEDS_EDITOR, value);
}

/** `from` as a query suffix, empty when the page cannot say where the member came from. */
export function deniedFromParam(from: DeniedFrom | undefined) {
  return from ? `&from=${from}` : "";
}

/** The Home URL for a member who lacks the capability a page needs. */
export function capabilityDeniedHref(from: DeniedFrom) {
  return `/home?requestFailure=capability_denied${deniedFromParam(from)}`;
}

/** The one sentence Home shows for the request-failure parameters, or null when there is none. */
export function requestFailureNotice(params: { get(name: string): string | null }): string | null {
  const failure = params.get("requestFailure");
  if (!failure) return null;
  const from = params.get("from");
  if (failure === "capability_denied" && isDeniedFrom(from)) {
    return `You need editor access to ${WHAT_NEEDS_EDITOR[from]}. ${ASK_ADMIN}`;
  }
  return `You don't have access to that page with your current role. ${ASK_ADMIN}`;
}
