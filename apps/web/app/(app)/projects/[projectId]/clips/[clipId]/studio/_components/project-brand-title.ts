"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import { type BrandTitle, brandTitleOrDefault } from "@narriflow/validators";
import { studioQueries } from "./studio-api";
import { useStudioApi } from "./use-studio-api";

/**
 * The project's brand title settings (placement, timing and style for "Add a title"), read from the
 * project's frozen brand snapshot. The built-in default while the read is in flight, when it fails,
 * and for a project with no snapshot or no title settings: it never blocks the Text panel.
 */
export function useProjectBrandTitle(projectId: string): BrandTitle {
  const api = useStudioApi();
  const options = api ? studioQueries(api).brandSnapshot(projectId) : null;
  const { data } = useQuery({
    queryKey: options?.queryKey ?? ["studio", "brand-snapshot", "no-workspace"],
    queryFn: options?.queryFn ?? skipToken,
    staleTime: options?.staleTime,
  });
  return brandTitleOrDefault(data?.snapshot?.title);
}
