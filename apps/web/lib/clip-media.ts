import {
  ApiError,
  type ApiRuntime,
  CLIENT_ERROR_CODES,
  createClipsClient,
  createExportsClient,
  createProjectsClient,
  createStudioClient,
  type Intent,
  type WorkspaceScope,
} from "@narriflow/api-client";
import { type BrandMutations, brandMutations } from "@narriflow/api-client/brand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";

/**
 * Typed clients for the clip and campaign UI, bound to one identity and
 * Workspace. Capture it where an action starts: a request and its cache
 * invalidation then stay in the Workspace the user clicked in.
 */
export interface ClipApi {
  runtime: ApiRuntime;
  scope: WorkspaceScope;
  queryClient: QueryClient;
  clips: ReturnType<typeof createClipsClient>;
  studio: ReturnType<typeof createStudioClient>;
  exports: ReturnType<typeof createExportsClient>;
  projects: ReturnType<typeof createProjectsClient>;
  /** Brand Kit commands the campaign bar issues (applying a scene to clips). */
  brand: BrandMutations;
}

/** `null` until the signed-in user has a selected Workspace. */
export function useClipApi(): ClipApi | null {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const queryClient = useQueryClient();
  return useMemo(() => {
    if (!scope) return null;
    const transport = runtime.transport.scoped(scope);
    return {
      runtime,
      scope,
      queryClient,
      clips: createClipsClient(transport),
      studio: createStudioClient(transport),
      exports: createExportsClient(transport),
      projects: createProjectsClient(transport),
      brand: brandMutations({ transport: runtime.transport, scope }),
    };
  }, [runtime, scope, queryClient]);
}

/** The intent held in `ref` for the current user action, created on first use. */
export function intentIn<TInput>(
  ref: { current: Intent<TInput> | null },
  runtime: ApiRuntime,
): Intent<TInput> {
  if (!ref.current) ref.current = runtime.createIntent<TInput>();
  return ref.current;
}

/** For an action handler: the bound clients, or the typed "no Workspace yet" failure. */
export function requireClipApi(api: ClipApi | null): ClipApi {
  if (api) return api;
  throw new ApiError({
    code: CLIENT_ERROR_CODES.workspaceSelectionRequired,
    message: "Choose a Workspace first.",
    status: 0,
  });
}

export interface ClipMediaDescriptor {
  downloadUrl: string;
  fileName: string;
  expiresInSeconds: number;
  isPreviewProxy: boolean;
  previewStartSec: number;
}

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function clipMediaPayloadForClip(
  payload: unknown,
  clipId: string,
): unknown | null {
  if (!payload || typeof payload !== "object") return null;
  const previews = (payload as Record<string, unknown>).previews;
  if (!previews || typeof previews !== "object") return null;
  return (previews as Record<string, unknown>)[clipId] ?? null;
}

/** A signed media URL the browser may open or play: plain http(s), nothing else. */
export function playableMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

export function clipMediaDescriptorFromPayload(
  payload: unknown,
): ClipMediaDescriptor | null {
  const downloadUrl = playableMediaUrl(readString(payload, "downloadUrl"));
  const fileName = readString(payload, "fileName");
  if (!downloadUrl || !fileName) return null;

  const value = payload as Record<string, unknown>;
  const rawExpiry = value.expiresInSeconds;
  const rawOffset = value.previewStartSec;
  return {
    downloadUrl,
    fileName,
    expiresInSeconds:
      typeof rawExpiry === "number" && Number.isFinite(rawExpiry)
        ? rawExpiry
        : 0,
    isPreviewProxy: value.isPreviewProxy === true,
    previewStartSec:
      typeof rawOffset === "number" && Number.isFinite(rawOffset)
        ? rawOffset
        : 0,
  };
}
