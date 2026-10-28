import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import { createAutomationClient } from "./client";

export const automationKeys = {
  overview: (scope: WorkspaceScope) => scopedKey(scope, "automation", "overview"),
  grants: (scope: WorkspaceScope) => scopedKey(scope, "automation", "standing-grants"),
  rules: (scope: WorkspaceScope) => scopedKey(scope, "automation", "rules"),
  zoomConnections: (scope: WorkspaceScope) => scopedKey(scope, "automation", "zoom-connections"),
};

interface Input {
  transport: ApiTransport;
  scope: WorkspaceScope;
}

/**
 * The Autopilot page in one read: rules, Recipes, live grants, Zoom connections and the plan and
 * capability facts its controls depend on. Zoom availability is a safe flag, not an environment check.
 */
export function automationOverviewQueryOptions({ transport, scope }: Input) {
  return queryOptions({
    queryKey: automationKeys.overview(scope),
    queryFn: async ({ signal }) => {
      const client = createAutomationClient(transport.scoped(scope));
      return (await client.automation.$get(undefined, { init: { signal } })).json();
    },
    staleTime: STALE_TIME.default,
  });
}

/** The grants page in one read: grants with usage and history, rule and account choices, plan flags. */
export function standingGrantsQueryOptions({ transport, scope }: Input) {
  return queryOptions({
    queryKey: automationKeys.grants(scope),
    queryFn: async ({ signal }) => {
      const client = createAutomationClient(transport.scoped(scope));
      return (await client.automation["standing-grants"].$get(undefined, { init: { signal } })).json();
    },
    staleTime: STALE_TIME.default,
  });
}

/** The Workspace's Autopilot rules alone, for screens that only need the list. */
export function autopilotRulesQueryOptions({ transport, scope }: Input) {
  return queryOptions({
    queryKey: automationKeys.rules(scope),
    queryFn: async ({ signal }) => {
      const client = createAutomationClient(transport.scoped(scope));
      return (await (await client.autopilot.rules.$get(undefined, { init: { signal } })).json()).rules;
    },
    staleTime: STALE_TIME.default,
  });
}

/** The Workspace's Zoom connections, with whether the viewer may disconnect each. */
export function zoomConnectionsQueryOptions({ transport, scope }: Input) {
  return queryOptions({
    queryKey: automationKeys.zoomConnections(scope),
    queryFn: async ({ signal }) => {
      const client = createAutomationClient(transport.scoped(scope));
      return (await (await client.zoom.connections.$get(undefined, { init: { signal } })).json()).connections;
    },
    staleTime: STALE_TIME.default,
  });
}
