"use client";

import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import type { StudioApi } from "./studio-api";

/** `null` until a Workspace is selected; Studio pages gate on it before mounting anything. */
export function useStudioApi(): StudioApi | null {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  return useMemo(() => (scope ? { runtime, scope } : null), [runtime, scope]);
}
