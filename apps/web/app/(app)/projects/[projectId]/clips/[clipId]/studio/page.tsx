"use client";

import { replaceCensorWordsMutation, resetCensorWordsMutation } from "@narriflow/api-client/workspace";
import { toaster } from "@narriflow/ui/components/toaster";
import { useMutation, useQuery } from "@tanstack/react-query";
import { notFound, useRouter } from "next/navigation";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandFontsProvider } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { buildSegmentsFromUtterances } from "./_components/edited-timeline";
import { resolveCompositionPlanQaFixture } from "./_components/composition-plan-qa-fixture";
import { StudioShell } from "./_components/studio-shell";
import {
  apiFailureBody,
  apiFailureStatus,
  recordCensorEvent,
  replaceProjectCensorTerms,
  type StudioApi,
  studioPollers,
  studioQueries,
} from "./_components/studio-api";
import { studioUpgradePrompts } from "./_components/studio-upgrade";
import { useStudioApi } from "./_components/use-studio-api";
import StudioLoading from "./loading";

/**
 * The Studio's data view. One bootstrap read seeds the Editing Session once;
 * the session itself keeps drafts, history, revision barriers, write ownership
 * and cloud convergence. Query refetches never reach it: the seed is frozen
 * until a completed reset asks for a fresh one.
 */
export default function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
  searchParams: Promise<{ qaCompositionPlan?: string | string[] }>;
}) {
  const { projectId, clipId } = use(params);
  const query = use(searchParams);
  const api = useStudioApi();
  if (!api) return <StudioLoading />;
  return (
    <StudioData
      key={`${api.scope.workspaceId}:${projectId}:${clipId}`}
      api={api}
      projectId={projectId}
      clipId={clipId}
      qaCompositionPlan={query.qaCompositionPlan}
    />
  );
}

const MISSING_CODES: ReadonlySet<string> = new Set(["project_not_found", "clip_not_found"]);

/** The page-level recovery the old server admission performed, driven by the stable error code. */
function recoveryDestination(error: unknown, projectId: string): string | null {
  const body = apiFailureBody(error);
  if (body.error === "active_workspace_mismatch") {
    const workspaceId = String(body.details?.workspaceId ?? "");
    const workspaceName = String(body.details?.workspaceName ?? "Workspace");
    const returnTo = `/projects/${projectId}`;
    return `/projects?requestFailure=active_workspace_mismatch&workspaceId=${encodeURIComponent(workspaceId)}&workspaceName=${encodeURIComponent(workspaceName)}&returnTo=${encodeURIComponent(returnTo)}`;
  }
  if (body.error === "workspace_restricted") {
    // A paused workspace: the owner goes to billing; other members go to a page
    // outside the app shell, because /home would refuse them again.
    const destination = body.details?.ownerCanResolve === true ? "/settings/billing" : "/workspace-unavailable";
    return `${destination}?requestFailure=workspace_restricted&requestId=${encodeURIComponent(body.requestId ?? "")}`;
  }
  return null;
}

function StudioData({
  api,
  projectId,
  clipId,
  qaCompositionPlan,
}: {
  api: StudioApi;
  projectId: string;
  clipId: string;
  qaCompositionPlan: string | string[] | undefined;
}) {
  const router = useRouter();
  const target = useMemo(() => ({ projectId, clipId }), [projectId, clipId]);
  const queries = useMemo(() => studioQueries(api), [api]);
  const bootstrap = useQuery(queries.bootstrap(target));

  // Frozen on first arrival; replaced only by a completed reset.
  const seedRef = useRef(bootstrap.data);
  const [generation, setGeneration] = useState(0);
  if (seedRef.current === undefined && bootstrap.data !== undefined) seedRef.current = bootstrap.data;

  const pollers = useMemo(() => studioPollers(api, target), [api, target]);
  const replaceWorkspaceWords = useMutation(replaceCensorWordsMutation(api.runtime, api.scope));
  const resetWorkspaceWords = useMutation(resetCensorWordsMutation(api.runtime, api.scope));

  const onResetComplete = useCallback(() => {
    void api.runtime.queryClient
      .fetchQuery({ ...queries.bootstrap(target), staleTime: 0 })
      .then((fresh) => {
        seedRef.current = fresh;
        setGeneration((current) => current + 1);
      })
      .catch(() => {
        toaster.create({
          type: "error",
          title: "Reset finished, but the editor could not reload",
          description: "Your clip was reset. Reload the page to continue editing.",
        });
      });
  }, [api, queries, target]);

  const error = bootstrap.error;
  const redirectTo = error ? recoveryDestination(error, projectId) : null;
  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  const seed = seedRef.current;
  if (error && !seed) {
    const body = apiFailureBody(error);
    if (apiFailureStatus(error) === 404 || (body.error && MISSING_CODES.has(body.error))) notFound();
    if (!redirectTo) throw error;
  }
  if (!seed) return <StudioLoading />;

  const { plan } = seed;
  const upgradePrompts = studioUpgradePrompts(plan.pricingTier, plan.scenesRequirement);
  const fontRequirement = plan.fontRequirement;
  const compositionPlanQaFixture = resolveCompositionPlanQaFixture(qaCompositionPlan, process.env.NODE_ENV);

  return (
    <BrandFontsProvider
      fonts={seed.fonts}
      requirement={fontRequirement?.message ?? null}
      upgrade={
        fontRequirement?.requiredTier
          ? {
              tier: fontRequirement.requiredTier,
              headline: "Upgrade to use custom fonts",
              canManageBilling: plan.canManageBilling,
            }
          : null
      }
    >
      <StudioShell
        key={generation}
        clipInfo={seed.clipInfo}
        timelineSegments={buildSegmentsFromUtterances(
          seed.utterances,
          seed.clipInfo.startSec,
          seed.clipInfo.duration,
        )}
        initialEditorDocument={seed.editor.document}
        initialEditorRevision={seed.editor.revision}
        initialEditorOriginal={seed.editor.original}
        sourceVideoUrl={seed.source.videoUrl}
        sourcePreviewId={seed.source.previewId}
        clipStartSec={seed.clipInfo.startSec}
        clipEndSec={seed.clipInfo.endSec}
        previewVideoUrl={seed.preview.previewUrl}
        previewStartSec={seed.preview.previewStartSec}
        previewDurationSec={seed.preview.previewDurationSec}
        waveformPeaksUrl={seed.preview.waveformPeaksUrl}
        // Once the source is purged, a still-missing proxy can never arrive —
        // the worker that cuts it reads straight from source storage — so the
        // studio shows a terminal message instead of polling/spinning forever.
        sourcePurged={seed.source.purged}
        fetchPreviewStatus={pollers.fetchPreviewStatus}
        fetchAutoLayoutAnalysis={pollers.fetchAutoLayoutAnalysis}
        fetchSplitLayoutAnalysis={pollers.fetchSplitLayoutAnalysis}
        fetchScreenLayoutAnalysis={pollers.fetchScreenLayoutAnalysis}
        brandLogo={seed.brandLogo}
        // The worker's screen-mode facecam layout analysis rides alongside the
        // document as a read-only sibling; it never folds into the editor document.
        layoutAnalysis={seed.editor.layoutAnalysis}
        autoLayoutAnalysis={seed.editor.autoLayoutAnalysis}
        splitLayoutAnalysis={seed.editor.splitLayoutAnalysis}
        splitLayoutFailure={seed.editor.splitLayoutFailure}
        layoutAnalysisFailure={seed.editor.layoutAnalysisFailure}
        compositionPlanQaFixture={compositionPlanQaFixture}
        visualAssets={seed.visualAssets}
        brandProfileId={seed.brandProfileId}
        brandAudio={seed.brandAudio}
        sceneFonts={seed.sceneFonts}
        sceneTemplates={seed.sceneTemplates}
        sceneWriteCapabilities={seed.sceneWriteCapabilities}
        generatedImagesCapability={seed.generatedImagesCapability}
        autoCensorPolicy={seed.autoCensorPolicy}
        upgradePrompts={upgradePrompts}
        updateProjectCensorTerms={(terms) => replaceProjectCensorTerms(api, projectId, terms)}
        replaceWorkspaceCensorWords={(words) => replaceWorkspaceWords.mutateAsync({ words })}
        resetWorkspaceCensorWords={() => resetWorkspaceWords.mutateAsync()}
        recordAutoCensorEvent={(input) => recordCensorEvent(api, target, input)}
        onResetComplete={onResetComplete}
      />
    </BrandFontsProvider>
  );
}
