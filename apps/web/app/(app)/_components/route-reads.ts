"use client";

import type { ApiRuntime, WorkspaceScope } from "@narriflow/api-client";
import { automationOverviewQueryOptions } from "@narriflow/api-client/automation";
import { brandQueries } from "@narriflow/api-client/brand";
import { integrationsOverviewQuery } from "@narriflow/api-client/developer";
import { createProjectsClient, projectQueries } from "@narriflow/api-client/projects";
import { projectTabFromSearchParam } from "@narriflow/validators/api/projects";
import { type PointerEvent, useCallback, useEffect, useRef } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import type { RouteRead } from "@/app/_components/workspace-query-gate";
import { publishingQueries } from "@/lib/publishing-client";
import { explorerFiltersFromSearch, explorerQueryOptions } from "../projects/_lib/api";

/**
 * Each route's primary reads, built from the same factories and arguments its
 * screen passes to `useQuery`, so a prefetched entry is the screen's own cache
 * entry. A route is listed only when its screen reads it unconditionally and
 * the arguments come from the URL alone. Never the Workspace bootstrap: the
 * gate reads that itself. Routes without an entry load as before.
 */
const ROUTES: ReadonlyArray<{
  pattern: RegExp;
  reads(runtime: ApiRuntime, scope: WorkspaceScope, search: URLSearchParams, match: RegExpExecArray): RouteRead[];
}> = [
  {
    pattern: /^\/home$/,
    reads: (runtime, scope) => [projectQueries.home(createProjectsClient(runtime.transport.scoped(scope)), scope)],
  },
  {
    pattern: /^\/projects$/,
    reads: (runtime, scope, search) => [
      explorerQueryOptions(
        runtime.queryClient,
        { projects: createProjectsClient(runtime.transport.scoped(scope)), scope },
        explorerFiltersFromSearch(search),
      ),
    ],
  },
  {
    pattern: /^\/projects\/([^/]+)$/,
    reads: (runtime, scope, search, match) => [
      projectQueries.detail(
        createProjectsClient(runtime.transport.scoped(scope)),
        scope,
        decodeURIComponent(match[1] ?? ""),
        projectTabFromSearchParam(search.get("tab")),
      ),
    ],
  },
  {
    pattern: /^\/performance$/,
    reads: (runtime, scope) => [publishingQueries.whatWorked(runtime, scope), publishingQueries.guidance(runtime, scope)],
  },
  {
    pattern: /^\/autopilot$/,
    reads: (runtime, scope) => [automationOverviewQueryOptions({ transport: runtime.transport, scope })],
  },
  {
    pattern: /^\/integrations$/,
    reads: (runtime, scope) => [integrationsOverviewQuery(runtime.transport, scope)],
  },
  {
    pattern: /^\/brand-kit$/,
    reads: (runtime, scope) => [brandQueries({ transport: runtime.transport, scope }).kit()],
  },
];

/** The primary reads of the page at `href` (a path with an optional query), or none. */
export function routeReads(runtime: ApiRuntime, scope: WorkspaceScope, href: string): RouteRead[] {
  const url = new URL(href, "http://route.invalid");
  for (const route of ROUTES) {
    const match = route.pattern.exec(url.pathname);
    if (match) return route.reads(runtime, scope, url.searchParams, match);
  }
  return [];
}

/** How long a pointer rests on a link before its destination is read; a pass across it reads nothing. */
const HOVER_INTENT_MS = 120;

export interface LinkIntentHandlers {
  onFocus(): void;
  onPointerEnter(event: PointerEvent): void;
  onPointerLeave(): void;
}

/**
 * Handlers that start a nav link's destination reads on keyboard focus or a
 * resting pointer, under the admitted Workspace only. Touch is ignored: a
 * finger passing over links while scrolling is not intent, and a tap navigates
 * at once anyway. Fresh data is not read again (each read keeps its own
 * `staleTime`).
 */
export function useNavIntent(): (href: string) => LinkIntentHandlers {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const prefetch = useCallback(
    (href: string) => {
      if (!scope) return;
      for (const read of routeReads(runtime, scope, href)) void runtime.queryClient.prefetchQuery(read);
    },
    [runtime, scope],
  );
  return useCallback(
    (href: string) => ({
      onFocus: () => prefetch(href),
      onPointerEnter: (event: PointerEvent) => {
        if (event.pointerType === "touch") return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => prefetch(href), HOVER_INTENT_MS);
      },
      onPointerLeave: () => clearTimeout(timer.current),
    }),
    [prefetch],
  );
}
