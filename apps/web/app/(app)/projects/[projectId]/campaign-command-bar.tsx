"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { type QueryClient, skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { type Intent, invalidateScoped, type WorkspaceScope } from "@narriflow/api-client";
import {
  CLIP_RESOURCES,
  clipCommands,
  clipMutationOptions,
  clipQueries,
  invalidateAfterClipChange,
  invalidateProjectClips,
} from "@narriflow/api-client/clips";
import { playableMediaUrl, intentIn, requireClipApi, useClipApi } from "@/lib/clip-media";
import { clipActionErrorCopy, failureNeedsStateRefetch } from "./clip-action-error-copy";
import {
  Box,
  Drawer,
  Flex,
  NativeSelect,
  Portal,
  Slider,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { ActionMenu, type ActionMenuItem } from "@narriflow/ui/components/menu";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import {
  Archive,
  Download,
  ExternalLink,
  Film,
  LayoutTemplate,
  MoreHorizontal,
  Palette,
  RefreshCw,
  WandSparkles,
  X,
} from "lucide-react";
import type {
  ApplyMotionSelectedInput,
  ClipAspectRatio,
  ClipRenderResolution,
  StudioTransition,
} from "@narriflow/validators";
import { userErrorMessage } from "@narriflow/validators";
import {
  MOTION_ENTRANCE_OPTIONS as ENTRANCE_OPTIONS,
  MOTION_EXIT_OPTIONS as EXIT_OPTIONS,
  TRANSITION_OPTIONS,
} from "@/lib/motion-options";
import { UpgradeGem, useUpgrade, type UpgradePrompt } from "../../_components/upgrade";
import { RenderClipsButton } from "./render-clips-button";
import {
  buildApplyMotionSelectedInput,
  buildCampaignEditorRetryRequest,
  submitCampaignEditorAction,
  type CampaignActionAvailability,
  type CampaignAvailableAction,
  type CampaignCommandState,
  type CampaignEditorRetryIntent,
} from "./campaign-command-state";
import {
  CampaignEditorActionPreview,
  CampaignNotice,
  CampaignSectionHead,
  CampaignStatTiles,
  ClipOutcomeRow,
  OutcomeMark,
  type CampaignEditorActionKind,
  type CampaignEditorOperationResult,
  type OutcomeTone,
} from "./campaign-editor-action-preview";

type ManualBrollMotion = Extract<
  ApplyMotionSelectedInput["change"],
  { scope: "manual_broll" }
>["motion"];

type OperationItem = {
  id: string;
  requestedClipId: string;
  expectedEditorRevision: number | null;
  status: string;
  errorCode: string | null;
};

type CampaignOperation = {
  id: string;
  action: string;
  status: string;
  requestedCount: number;
  succeededCount: number;
  unchangedCount: number;
  staleCount: number;
  ineligibleCount: number;
  failedCount: number;
  items: OperationItem[];
  bundle: {
    id: string;
    status: string;
    expiresAt: string | null;
    errorCode: string | null;
  } | null;
};

type MotionPreflight = {
  requestedCount: number;
  counts: {
    eligible: number;
    unchanged: number;
    stale: number;
    ineligible: number;
  };
  items: Array<{
    clipId: string;
    expectedEditorRevision: number;
    currentEditorRevision: number | null;
    status: "eligible" | "unchanged" | "stale" | "ineligible";
    code: string | null;
  }>;
};

type BundlePreflight = {
  requestedCount: number;
  counts: { eligible: number; stale: number; ineligible: number };
  estimatedSizeBytes: number;
  items: Array<{
    clipId: string;
    expectedEditorRevision: number;
    currentEditorRevision: number | null;
    exportEditorRevision: number | null;
    status: "eligible" | "stale" | "ineligible";
    code: string | null;
    aspectRatios: ClipAspectRatio[];
    estimatedSizeBytes: number;
  }>;
};

function transitionLabel(type: StudioTransition["type"]) {
  return TRANSITION_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

function motionLabel(
  value: ManualBrollMotion["entrance"] | ManualBrollMotion["exit"],
) {
  return [...ENTRANCE_OPTIONS, ...EXIT_OPTIONS].find(
    (option) => option.value === value,
  )?.label ?? value;
}

/** How an item or operation status reads: done, needs a look, stopped, or still running. */
function outcomeTone(status: string): OutcomeTone {
  if (status === "succeeded" || status === "completed" || status === "unchanged") return "ok";
  if (status === "stale" || status === "ineligible" || status === "partial") return "attention";
  if (status === "failed") return "failed";
  return "progress";
}

function actionLabel(state: CampaignCommandState) {
  switch (state.primary) {
    case "export_bundle":
      return `Build ZIP (${state.selectedCount})`;
    case "render_selected":
      return `Render selected (${state.selectedCount})`;
    default:
      return `Prepare exports (${state.attentionItems.length})`;
  }
}

function operationTitle(action: string | undefined) {
  switch (action) {
    case "apply_brand_profile":
      return "Brand Profile results";
    case "apply_style":
      return "Style results";
    case "apply_scene_template":
      return "Scene results";
    case "apply_motion":
      return "Motion results";
    default:
      return "Export bundle";
  }
}

function formatBundleSize(bytes: number) {
  if (bytes === 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function bundleAttentionMessage(item: BundlePreflight["items"][number]) {
  if (item.code === "campaign_clip_stale") {
    return item.currentEditorRevision === null
      ? "The clip is no longer available"
      : `Revision changed to ${item.currentEditorRevision}`;
  }
  if (item.code === "campaign_clip_not_found") {
    return "The clip is no longer available";
  }
  if (
    item.exportEditorRevision !== null &&
    item.exportEditorRevision !== item.expectedEditorRevision
  ) {
    return `Ready export is revision ${item.exportEditorRevision}; render revision ${item.expectedEditorRevision}`;
  }
  return "The requested export is not ready";
}

function MotionSelectionPreview({
  change,
}: {
  change: ApplyMotionSelectedInput["change"];
}) {
  return (
    <Flex
      minH="116px"
      position="relative"
      overflow="hidden"
      align="center"
      justify="center"
      borderRadius="l2"
      bg="bg.soft"
    >
      <Box
        key={
          change.scope === "clip_transition"
            ? change.transition.type
            : `${change.motion.entrance}:${change.motion.exit}`
        }
        w="58%"
        h="66px"
        position="relative"
        borderRadius="l2"
        bg="bg.panel"
        opacity={
          change.scope === "clip_transition" &&
          ["fade", "fade-black", "dip-white"].includes(
            change.transition.type,
          )
            ? 0.74
            : 1
        }
        animation="fade-up"
      >
        <Box
          position="absolute"
          insetInlineStart="0"
          top="0"
          bottom="0"
          w={change.scope === "manual_broll" ? "3px" : "1px"}
          bg={change.scope === "manual_broll" ? "accent.solid" : "bg.softHover"}
        />
        <Flex h="full" direction="column" align="center" justify="center" gap="1">
          <WandSparkles size={16} />
          <Text textStyle="eyebrow" color="fg.muted">
          {change.scope === "clip_transition"
              ? transitionLabel(change.transition.type)
              : `${motionLabel(change.motion.entrance)} · ${motionLabel(change.motion.exit)}`}
          </Text>
        </Flex>
      </Box>
      <Text
        position="absolute"
        insetInlineStart="10px"
        bottom="7px"
        fontSize="12px"
        fontVariantNumeric="tabular-nums"
        color="fg.muted"
      >
        {change.scope === "clip_transition"
          ? `${change.transition.durationSec.toFixed(2)}s · clip boundary`
          : "0.50s phases · manual B-roll"}
      </Text>
    </Flex>
  );
}

/** The upgrade prompt for each campaign action group; `null` when the plan already covers it. */
export type CampaignUpgradePrompts = Readonly<
  Record<keyof CampaignActionAvailability, UpgradePrompt | null>
>;

export function CampaignCommandBar({
  projectId,
  state,
  defaultAspectRatio,
  isFreeTier,
  can1080pExport,
  upgradePrompts,
  onClear,
}: {
  projectId: string;
  state: CampaignCommandState;
  defaultAspectRatio: ClipAspectRatio;
  isFreeTier: boolean;
  can1080pExport: boolean;
  upgradePrompts: CampaignUpgradePrompts;
  onClear(): void;
}) {
  const router = useRouter();
  const api = useClipApi();
  const { openUpgrade } = useUpgrade();
  // One intent per user action: a retry after a timeout or lost response replays
  // the accepted command; changed input, or a confirmed acceptance, is a new intent.
  const bundleIntent = useRef<Intent<unknown> | null>(null);
  const retryBundleIntent = useRef<Intent<unknown> | null>(null);
  const motionIntent = useRef<Intent<unknown> | null>(null);
  const retryActionIntent = useRef<Intent<unknown> | null>(null);
  const resolution: ClipRenderResolution = can1080pExport ? "1080p" : "720p";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<CampaignOperation | null>(null);
  const [retryIntent, setRetryIntent] =
    useState<CampaignEditorRetryIntent | null>(null);
  const [previewingBundle, setPreviewingBundle] = useState(false);
  const [previewingRender, setPreviewingRender] = useState(false);
  const [previewingMotion, setPreviewingMotion] = useState(false);
  const [editorActionKind, setEditorActionKind] =
    useState<CampaignEditorActionKind | null>(null);
  const [motionScope, setMotionScope] = useState<
    ApplyMotionSelectedInput["change"]["scope"]
  >("clip_transition");
  const [transitionType, setTransitionType] = useState<
    StudioTransition["type"]
  >("fade");
  const [transitionDurationSec, setTransitionDurationSec] = useState(0.4);
  const [motionEntrance, setMotionEntrance] = useState<ManualBrollMotion["entrance"]>(
    "fade",
  );
  const [motionExit, setMotionExit] = useState<ManualBrollMotion["exit"]>("fade");
  const [motionDurationSec, setMotionDurationSec] = useState(0.5);
  const [motionPreflight, setMotionPreflight] = useState<MotionPreflight | null>(null);
  const [motionPreflightState, setMotionPreflightState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [bundlePreflight, setBundlePreflight] = useState<BundlePreflight | null>(null);
  const [bundlePreflightState, setBundlePreflightState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");

  const clipsById = useMemo(
    () =>
      new Map(
        state.selectedItems.map((item, index) => [item.clipId, index + 1]),
      ),
    [state.selectedItems],
  );
  const motionChange = useMemo<ApplyMotionSelectedInput["change"]>(
    () =>
      motionScope === "clip_transition"
        ? {
            scope: "clip_transition",
            transition: {
              type: transitionType,
              durationSec: transitionDurationSec,
            },
          }
        : {
            scope: "manual_broll",
            motion: { entrance: motionEntrance, exit: motionExit, durationSec: motionDurationSec },
          },
    [
      motionEntrance,
      motionExit,
      motionDurationSec,
      motionScope,
      transitionDurationSec,
      transitionType,
    ],
  );
  const motionPreflightInput = useMemo(
    () => buildApplyMotionSelectedInput(motionChange, state.selectedItems),
    [motionChange, state.selectedItems],
  );
  const motionPreflightKey = useMemo(
    () => JSON.stringify(motionPreflightInput),
    [motionPreflightInput],
  );
  const bundlePreflightInput = useMemo(
    () => ({
      clips: state.selectedItems.map(
        ({ clipId, expectedEditorRevision }) => ({
          clipId,
          expectedEditorRevision,
        }),
      ),
      aspectRatios: [defaultAspectRatio],
      resolution,
    }),
    [defaultAspectRatio, resolution, state.selectedItems],
  );
  const bundlePreflightKey = useMemo(
    () => JSON.stringify(bundlePreflightInput),
    [bundlePreflightInput],
  );
  const motionAttentionCount = motionPreflight
    ? motionPreflight.counts.stale + motionPreflight.counts.ineligible
    : 0;
  const canSubmitMotion =
    motionPreflightState === "ready" &&
    (motionPreflight?.counts.eligible ?? 0) > 0;
  const editorRetryRequest = useMemo(
    () =>
      operation
        ? buildCampaignEditorRetryRequest({
            operation,
            intent: retryIntent,
            selectedItems: state.selectedItems,
          })
        : null,
    [operation, retryIntent, state.selectedItems],
  );

  // A running operation is read again every 2 seconds while its drawer is open;
  // a missed poll is harmless, the next one reconciles it.
  const operationRunning =
    drawerOpen && operation !== null && !["completed", "partial", "failed"].includes(operation.status);
  const operationsOptions = api ? clipQueries.campaignOperations(api.clips, api.scope, projectId) : null;
  const operationPoll = useQuery({
    queryKey: operationsOptions?.queryKey ?? ["nf", "clips", "campaign-operations", "unavailable"],
    queryFn: operationsOptions?.queryFn ?? skipToken,
    enabled: operationRunning,
    refetchInterval: operationRunning ? 2_000 : false,
  });
  const polledOperation = operation
    ? operationPoll.data?.operations.find((candidate) => candidate.id === operation.id)
    : undefined;
  useEffect(() => {
    if (polledOperation) setOperation(polledOperation);
  }, [polledOperation]);

  useEffect(() => {
    if (!api || !drawerOpen || !previewingMotion) {
      setMotionPreflightState("idle");
      setMotionPreflight(null);
      return;
    }
    const controller = new AbortController();
    setMotionPreflightState("loading");
    setMotionPreflight(null);
    setError(null);
    void api.clips.projects[":id"]["campaign-operations"]["preview-editor-action"].$post(
        {
          param: { id: projectId },
          json: { action: "apply_motion", input: JSON.parse(motionPreflightKey) },
        },
        { init: { signal: controller.signal } },
      )
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.counts || !payload.items) {
          throw new Error("Motion preflight could not be completed.");
        }
        setMotionPreflight(payload as MotionPreflight);
        setMotionPreflightState("ready");
      })
      .catch((preflightError: unknown) => {
        if (controller.signal.aborted) return;
        setMotionPreflightState("error");
        setError(clipActionErrorCopy(preflightError, "Motion preflight could not be completed."));
      });
    return () => controller.abort();
  }, [drawerOpen, motionPreflightKey, previewingMotion, projectId, api]);

  useEffect(() => {
    if (!api || !drawerOpen || !previewingBundle) {
      setBundlePreflightState("idle");
      setBundlePreflight(null);
      return;
    }
    const controller = new AbortController();
    setBundlePreflightState("loading");
    setBundlePreflight(null);
    setError(null);
    void api.exports.projects[":id"]["export-bundles"].preview.$post(
        { param: { id: projectId }, json: JSON.parse(bundlePreflightKey) },
        { init: { signal: controller.signal } },
      )
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.counts || !payload.items) {
          throw new Error("Bundle availability could not be checked.");
        }
        setBundlePreflight(payload as BundlePreflight);
        setBundlePreflightState("ready");
      })
      .catch((preflightError: unknown) => {
        if (controller.signal.aborted) return;
        setBundlePreflightState("error");
        setError(clipActionErrorCopy(preflightError, "Bundle availability could not be checked."));
      });
    return () => controller.abort();
  }, [bundlePreflightKey, drawerOpen, previewingBundle, projectId, api]);

  const createBundleMutation = useMutation({
    ...clipMutationOptions,
    mutationFn: async () => {
      const { runtime, exports, scope, queryClient } = requireClipApi(api);
      const input = JSON.parse(bundlePreflightKey) as typeof bundlePreflightInput;
      const intent = intentIn(bundleIntent, runtime);
      const accepted = await exports.projects[":id"]["export-bundles"].$post(
        { param: { id: projectId }, json: input },
        { headers: { "Idempotency-Key": intent.keyFor(input) } },
      ).then((response) => response.json());
      intent.complete();
      await invalidateBundleReads(queryClient, scope);
      return accepted;
    },
    onError: refetchWhenUncertain,
  });

  /** A bundle freezes finished exports: the operation list and the Project's exports move. */
  function invalidateBundleReads(queryClient: QueryClient, scope: WorkspaceScope) {
    return Promise.all([
      invalidateScoped(queryClient, scope, "clips", CLIP_RESOURCES.campaignOperations, projectId),
      invalidateScoped(queryClient, scope, "exports"),
    ]);
  }

  /** After a lost response or a conflict, the domain state says whether the command was accepted. */
  function refetchWhenUncertain(failure: unknown) {
    if (api && failureNeedsStateRefetch(failure)) void invalidateProjectClips(api.queryClient, api.scope, projectId);
  }

  async function createBundle() {
    if (
      submitting ||
      bundlePreflightState !== "ready" ||
      (bundlePreflight?.counts.eligible ?? 0) === 0 ||
      !state.availableActions.includes("export_bundle")
    ) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = await createBundleMutation.mutateAsync();
      setPreviewingBundle(false);
      setPreviewingRender(false);
      setPreviewingMotion(false);
      setEditorActionKind(null);
      setRetryIntent(null);
      setOperation({
        id: payload.operationId,
        action: "export_bundle",
        status: "running",
        requestedCount: state.selectedItems.length,
        succeededCount: 0,
        unchangedCount: 0,
        staleCount: 0,
        ineligibleCount: payload.manifest?.excluded.length ?? 0,
        failedCount: 0,
        items: [
          ...(payload.manifest?.included.map((item) => ({
            id: item.clipId,
            requestedClipId: item.clipId,
            expectedEditorRevision:
              state.selectedItems.find((candidate) => candidate.clipId === item.clipId)
                ?.expectedEditorRevision ?? null,
            status: "pending",
            errorCode: null,
          })) ?? []),
          ...(payload.manifest?.excluded.map((item) => ({
            id: item.clipId,
            requestedClipId: item.clipId,
            expectedEditorRevision:
              state.selectedItems.find((candidate) => candidate.clipId === item.clipId)
                ?.expectedEditorRevision ?? null,
            status: "ineligible",
            errorCode: item.code,
          })) ?? []),
        ],
        bundle: null,
      });
    } catch (failure) {
      setError(clipActionErrorCopy(failure, "The export bundle could not be queued. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  const retryBundleMutation = useMutation({
    ...clipMutationOptions,
    mutationFn: async (operationId: string) => {
      const { runtime, exports, scope, queryClient } = requireClipApi(api);
      const intent = intentIn(retryBundleIntent, runtime);
      const accepted = await exports.projects[":id"]["campaign-operations"][":operationId"]["retry-export-bundle"]
        .$post(
          { param: { id: projectId, operationId } },
          { headers: { "Idempotency-Key": intent.keyFor({ operationId }) } },
        )
        .then((response) => response.json());
      intent.complete();
      await invalidateBundleReads(queryClient, scope);
      return accepted;
    },
    onError: refetchWhenUncertain,
  });

  async function retryBundle() {
    if (!operation || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = await retryBundleMutation.mutateAsync(operation.id);
      setOperation({ ...operation, id: payload.operationId, status: "running" });
    } catch (failure) {
      setError(clipActionErrorCopy(failure, "The failed bundle items could not be retried."));
    } finally {
      setSubmitting(false);
    }
  }

  const [downloadingBundle, setDownloadingBundle] = useState(false);
  /** The ZIP is a short-lived grant: ask for a fresh one, then the browser fetches it directly (no Clerk token). */
  async function downloadBundle(bundleId: string | undefined) {
    if (!bundleId || downloadingBundle) return;
    setDownloadingBundle(true);
    setError(null);
    try {
      const { exports } = requireClipApi(api);
      const grant = await exports.projects[":id"]["export-bundles"][":bundleId"].download
        .$get({ param: { id: projectId, bundleId } })
        .then((response) => response.json());
      const url = playableMediaUrl(grant.downloadUrl);
      if (!url) throw new Error("invalid_download_grant");
      window.location.assign(url);
    } catch (failure) {
      setError(clipActionErrorCopy(failure, "The ZIP could not be downloaded. Try again."));
    } finally {
      setDownloadingBundle(false);
    }
  }

  function openBundlePreview() {
    setError(null);
    setOperation(null);
    setRetryIntent(null);
    setPreviewingBundle(true);
    setPreviewingRender(false);
    setPreviewingMotion(false);
    setEditorActionKind(null);
    setDrawerOpen(true);
  }

  function openRenderPreview() {
    setError(null);
    setOperation(null);
    setRetryIntent(null);
    setPreviewingBundle(false);
    setPreviewingRender(true);
    setPreviewingMotion(false);
    setEditorActionKind(null);
    setDrawerOpen(true);
  }

  function openMotionPreview() {
    setError(null);
    setOperation(null);
    setRetryIntent(null);
    setPreviewingBundle(false);
    setPreviewingRender(false);
    setPreviewingMotion(true);
    setEditorActionKind(null);
    setDrawerOpen(true);
  }

  function openEditorActionPreview(kind: CampaignEditorActionKind) {
    setError(null);
    setOperation(null);
    setRetryIntent(null);
    setPreviewingBundle(false);
    setPreviewingRender(false);
    setPreviewingMotion(false);
    setEditorActionKind(kind);
    setDrawerOpen(true);
  }

  /** The settled operation with its item rows, or `null` when the history read misses once. */
  async function hydrateOperation(operationId: string): Promise<CampaignOperation | null> {
    if (!api) return null;
    try {
      const list = await api.queryClient.fetchQuery({
        ...clipQueries.campaignOperations(api.clips, api.scope, projectId),
        staleTime: 0,
      });
      return list.operations.find((candidate) => candidate.id === operationId) ?? null;
    } catch {
      // The settled summary stays truthful when history hydration misses one
      // request; the Project reads refetched below reconcile the item rows.
      return null;
    }
  }

  /** Clips, editor revisions and operations moved; a Studio opened next must not read a cached older document. */
  async function invalidateAfterCampaignApply() {
    if (!api) return;
    await Promise.all([
      invalidateAfterClipChange(api.queryClient, api.scope, projectId),
      invalidateScoped(api.queryClient, api.scope, "studio"),
    ]);
  }

  async function receiveEditorActionResult(
    result: CampaignEditorOperationResult,
    nextRetryIntent: CampaignEditorRetryIntent,
  ) {
    const hydrated = await hydrateOperation(result.operationId);
    const action =
      editorActionKind === "brand_profile"
        ? "apply_brand_profile"
        : editorActionKind === "style"
          ? "apply_style"
          : "apply_scene_template";
    setEditorActionKind(null);
    setRetryIntent(nextRetryIntent);
    setOperation(
      hydrated ?? {
        id: result.operationId,
        action,
        status: result.status,
        requestedCount: result.requestedCount,
        succeededCount: result.counts.succeeded,
        unchangedCount: result.counts.unchanged,
        staleCount: result.counts.stale,
        ineligibleCount: result.counts.ineligible,
        failedCount: result.counts.failed,
        items: [],
        bundle: null,
      },
    );
    await invalidateAfterCampaignApply();
  }

  const motionMutation = useMutation({
    ...clipMutationOptions,
    mutationFn: async () => {
      const { runtime, clips } = requireClipApi(api);
      const intent = intentIn(motionIntent, runtime);
      const accepted = await clipCommands.applyMotion(
        clips,
        projectId,
        motionPreflightInput,
        intent.keyFor(motionPreflightInput),
      );
      intent.complete();
      return accepted;
    },
    onError: refetchWhenUncertain,
  });

  async function applySelectedMotion() {
    if (
      submitting ||
      !state.availableActions.includes("apply_motion") ||
      !canSubmitMotion
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = await motionMutation.mutateAsync();
      const hydrated = await hydrateOperation(payload.operationId);
      setPreviewingMotion(false);
      setRetryIntent({ action: "apply_motion", change: motionChange });
      setOperation(
        hydrated ?? {
          id: payload.operationId,
          action: "apply_motion",
          status: payload.status ?? "completed",
          requestedCount: payload.requestedCount ?? state.selectedItems.length,
          succeededCount: payload.counts.succeeded,
          unchangedCount: payload.counts.unchanged,
          staleCount: payload.counts.stale,
          ineligibleCount: payload.counts.ineligible,
          failedCount: payload.counts.failed,
          items: [],
          bundle: null,
        },
      );
      await invalidateAfterCampaignApply();
    } catch (failure) {
      setError(clipActionErrorCopy(failure, "Motion could not be applied to the selected clips."));
    } finally {
      setSubmitting(false);
    }
  }

  const retryEditorActionMutation = useMutation({
    ...clipMutationOptions,
    mutationFn: async (input: { request: NonNullable<typeof editorRetryRequest>; retryOfId: string }) => {
      const { runtime, clips, brand } = requireClipApi(api);
      // The same failed items retried again after a lost response keep one key;
      // the retry-of header names the operation being continued.
      const intent = intentIn(retryActionIntent, runtime);
      const accepted = await submitCampaignEditorAction({ clips, brand }, projectId, input.request, {
        idempotencyKey: intent.keyFor(input),
        retryOfId: input.retryOfId,
      });
      intent.complete();
      return accepted;
    },
    onError: refetchWhenUncertain,
  });

  async function retryEditorAction() {
    if (!operation || !editorRetryRequest || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = await retryEditorActionMutation.mutateAsync({
        request: editorRetryRequest,
        retryOfId: operation.id,
      });
      if (!payload.operationId || !payload.counts) {
        throw new Error("incomplete_retry_response");
      }
      const hydrated = await hydrateOperation(payload.operationId);
      setOperation(
        hydrated ?? {
          id: payload.operationId,
          action: editorRetryRequest.action,
          status: payload.status ?? "completed",
          requestedCount:
            payload.requestedCount ?? editorRetryRequest.input.clips.length,
          succeededCount: payload.counts.succeeded,
          unchangedCount: payload.counts.unchanged,
          staleCount: payload.counts.stale,
          ineligibleCount: payload.counts.ineligible,
          failedCount: payload.counts.failed,
          items: [],
          bundle: null,
        },
      );
      await invalidateAfterCampaignApply();
    } catch (failure) {
      setError(clipActionErrorCopy(failure, "The failed campaign items could not be retried."));
    } finally {
      setSubmitting(false);
    }
  }

  function runPrimary() {
    if (state.primary === "export_bundle") {
      openBundlePreview();
    }
  }

  // A runnable command opens its preview; a plan-locked one stays in the menu
  // with a gem and opens the upgrade dialog, sending no request.
  function commandItem(
    action: CampaignAvailableAction,
    promptKey: keyof CampaignUpgradePrompts,
    item: { value: string; label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean; hint?: ReactNode },
  ): ActionMenuItem[] {
    if (state.availableActions.includes(action)) return [item];
    const prompt = upgradePrompts[promptKey];
    if (!state.lockedActions.includes(action) || !prompt) return [];
    return [
      {
        ...item,
        disabled: false,
        hint: <UpgradeGem />,
        onSelect: () => openUpgrade(prompt),
      },
    ];
  }

  const editorMenuItems = [
    ...commandItem("apply_brand_profile", "creative", {
      value: "brand-profile",
      label: "Apply project Brand Profile",
      icon: <WandSparkles size={14} />,
      onSelect: () => openEditorActionPreview("brand_profile"),
    }),
    ...commandItem("apply_style", "creative", {
      value: "style",
      label: "Apply style preset",
      icon: <Palette size={14} />,
      onSelect: () => openEditorActionPreview("style"),
    }),
    ...commandItem("apply_scene_template", "creative", {
      value: "scene",
      label: "Add intro or outro",
      icon: <LayoutTemplate size={14} />,
      onSelect: () => openEditorActionPreview("scene"),
    }),
    ...commandItem("apply_motion", "motion", {
      value: "motion",
      label: "Apply motion to selected",
      icon: <WandSparkles size={14} />,
      onSelect: openMotionPreview,
    }),
  ];
  const zipMenuItems =
    state.primary === "export_bundle"
      ? []
      : commandItem("export_bundle", "exports", {
          value: "zip",
          label: "Build download ZIP",
          icon: <Archive size={14} />,
          disabled: state.readyItems.length === 0,
          // The ZIP freezes finished exports, so say what it is waiting for.
          hint:
            state.readyItems.length === 0 ? (
              <Text as="span" fontSize="12px" color="fg.subtle">Render first</Text>
            ) : undefined,
          onSelect: openBundlePreview,
        });

  const menuItems: ActionMenuItem[] = [
    ...(state.primary !== "render_selected"
      ? [{
          value: "render",
          label: "Render all selected",
          icon: <Film size={14} />,
          onSelect: openRenderPreview,
        }]
      : []),
    ...editorMenuItems,
    ...zipMenuItems,
    {
      value: "studio",
      label: "Open first clip in Studio",
      icon: <ExternalLink size={14} />,
      onSelect: () =>
        router.push(
          `/projects/${projectId}/clips/${state.selectedClipIds[0]}/studio`,
        ),
    },
  ];

  if (state.selectedCount === 0) return null;

  return (
    <>
      {/* Floating bar: one flat surface at the foot of the page while clips
          are selected. It portals out so no scrolling ancestor clips it, and
          its popovers open upward. */}
      <Portal>
        <Flex
          position="fixed"
          insetInline="0"
          bottom={{ base: "4", md: "6" }}
          justify="center"
          px="3"
          zIndex="sticky"
          pointerEvents="none"
        >
          <Flex
            role="region"
            aria-label="Selected clips"
            align="center"
            gap="1.5"
            p="2"
            maxW="full"
            bg="bg.raised"
            // The raised fill separates the bar on graphite; porcelain adds a
            // hairline (none on graphite), like every floating surface.
            borderWidth="1px"
            borderColor="border.card"
            borderRadius="l3"
            pointerEvents="auto"
            animation="fade-up"
          >
            <Flex align="center" gap="2" ps="1.5" pe="0.5">
              <Flex
                minW="6"
                h="6"
                px="2"
                align="center"
                justify="center"
                borderRadius="full"
                bg="accent.subtle"
                color="accent.fg"
                fontSize="12px"
                fontWeight="600"
                fontVariantNumeric="tabular-nums"
              >
                {state.selectedCount}
              </Flex>
              <Text fontSize="13px" fontWeight="500" color="fg" whiteSpace="nowrap">
                selected
              </Text>
              <IconButton
                size="xs"
                variant="ghost"
                aria-label="Clear selection"
                title="Clear selection"
                onClick={onClear}
              >
                <X size={14} />
              </IconButton>
            </Flex>
            {state.primary === "prepare_exports" ? (
              <RenderClipsButton
                projectId={projectId}
                disabled={false}
                buttonLabel={actionLabel(state)}
                isFreeTier={isFreeTier}
                can1080pExport={can1080pExport}
                clipIds={state.attentionItems.map((item) => item.clipId)}
                size="sm"
                placement="top-start"
                defaultAspectRatio={defaultAspectRatio}
              />
            ) : state.primary === "render_selected" ? (
              <RenderClipsButton
                projectId={projectId}
                disabled={false}
                buttonLabel={actionLabel(state)}
                isFreeTier={isFreeTier}
                can1080pExport={can1080pExport}
                clipIds={state.selectedClipIds}
                size="sm"
                placement="top-start"
                defaultAspectRatio={defaultAspectRatio}
              />
            ) : state.primary ? (
              <Button size="sm" onClick={runPrimary}>
                <Archive size={14} />
                <Text ms="1">{actionLabel(state)}</Text>
              </Button>
            ) : null}
            <ActionMenu
              ariaLabel="More campaign actions"
              positioning={{ placement: "top-end", gutter: 12 }}
              items={menuItems}
              trigger={
                <IconButton
                  size="sm"
                  variant="subtle"
                  aria-label="More campaign actions"
                  title="More actions"
                >
                  <MoreHorizontal size={16} />
                </IconButton>
              }
            />
          </Flex>
        </Flex>
      </Portal>

      <Drawer.Root
        open={drawerOpen}
        onOpenChange={(details) => setDrawerOpen(details.open)}
        placement="end"
        size="md"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Header>
                <Stack gap="0.5">
                  <Drawer.Title textStyle="title" fontSize="18px" fontWeight="500">
                    {previewingBundle
                      ? "Review bundle"
                      : previewingRender
                        ? "Render selected"
                        : editorActionKind === "brand_profile"
                          ? "Project Brand Profile"
                          : editorActionKind === "style"
                            ? "Style preset"
                            : editorActionKind === "scene"
                              ? "Intro or outro"
                              : previewingMotion
                                ? "Apply motion"
                                : operationTitle(operation?.action)}
                  </Drawer.Title>
                  <Text fontSize="13px" color="fg.muted">
                    {state.selectedCount} selected clip{state.selectedCount === 1 ? "" : "s"}
                  </Text>
                </Stack>
              </Drawer.Header>
              <Drawer.Body py="5">
                {editorActionKind ? (
                  <CampaignEditorActionPreview
                    kind={editorActionKind}
                    projectId={projectId}
                    state={state}
                    onApplied={receiveEditorActionResult}
                  />
                ) : previewingRender ? (
                  <Stack gap="5">
                    <Box>
                      <Text fontSize="14px" fontWeight="500" color="fg">
                        Queue new renders for all {state.selectedCount} selected
                        {state.selectedCount === 1 ? " clip" : " clips"}
                      </Text>
                      <Text fontSize="13px" color="fg.muted" mt="1">
                        Pick formats and resolution next. Ready exports stay as they are.
                      </Text>
                    </Box>
                    <Stack gap="1.5">
                      {state.selectedItems.map((item, index) => (
                        <ClipOutcomeRow
                          key={item.clipId}
                          title={`Clip ${index + 1}`}
                          trailing={
                            <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                              revision {item.expectedEditorRevision}
                            </Text>
                          }
                        />
                      ))}
                    </Stack>
                  </Stack>
                ) : previewingBundle ? (
                  <Stack gap="5">
                    <Box>
                      <Text fontSize="14px" fontWeight="500" color="fg">
                        {bundlePreflightState === "loading"
                          ? "Checking the selected export revisions…"
                          : `${bundlePreflight?.counts.eligible ?? 0} exact export${bundlePreflight?.counts.eligible === 1 ? "" : "s"} will be frozen into one ZIP.`}
                      </Text>
                      <Flex align="center" gap="2" mt="1.5" wrap="wrap">
                        <Flex h="6" px="2.5" align="center" borderRadius="full" bg="bg.soft" fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                          {defaultAspectRatio} · {resolution}
                        </Flex>
                        <Flex h="6" px="2.5" align="center" borderRadius="full" bg="bg.soft" fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                          {bundlePreflight
                            ? `about ${formatBundleSize(bundlePreflight.estimatedSizeBytes)}`
                            : "size on check"}
                        </Flex>
                      </Flex>
                    </Box>
                    {bundlePreflightState === "loading" ? (
                      <Flex align="center" gap="2" color="fg.muted">
                        <Spinner size="xs" />
                        <Text fontSize="13px">Verifying revisions and immutable files</Text>
                      </Flex>
                    ) : null}
                    {bundlePreflight &&
                    bundlePreflight.counts.stale + bundlePreflight.counts.ineligible > 0 ? (
                      <CampaignNotice>
                        {bundlePreflight.counts.stale + bundlePreflight.counts.ineligible} selected clip
                        {bundlePreflight.counts.stale + bundlePreflight.counts.ineligible === 1 ? " needs" : "s need"} attention and will not be included.
                      </CampaignNotice>
                    ) : null}
                    <Stack gap="1.5">
                      {bundlePreflight?.items.map((item) => (
                        <ClipOutcomeRow
                          key={item.clipId}
                          tone={item.status === "eligible" ? "ok" : "attention"}
                          title={`Clip ${clipsById.get(item.clipId) ?? "—"}`}
                          detail={
                            item.status === "eligible"
                              ? `${item.aspectRatios.join(", ")} · ${formatBundleSize(item.estimatedSizeBytes)}`
                              : bundleAttentionMessage(item)
                          }
                          trailing={
                            <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                              {item.status === "stale" && item.currentEditorRevision !== null
                                ? `${item.expectedEditorRevision} → ${item.currentEditorRevision}`
                                : `revision ${item.expectedEditorRevision}`}
                            </Text>
                          }
                        />
                      ))}
                    </Stack>
                  </Stack>
                ) : previewingMotion ? (
                  <Stack gap="5">
                    <Box>
                      <Text fontSize="14px" fontWeight="500" color="fg">
                        Apply one motion preset to {state.selectedCount} selected
                        {state.selectedCount === 1 ? " clip" : " clips"}
                      </Text>
                      <Text fontSize="13px" color="fg.muted" mt="1">
                        Each clip keeps its own revision fence. Equivalent edits are recorded as unchanged.
                      </Text>
                    </Box>

                    <SegmentedControl
                      aria-label="Motion scope"
                      w="full"
                      css={{ "& [data-part=item]": { flex: 1, justifyContent: "center" } }}
                      items={[
                        { label: "Clip transition", value: "clip_transition" },
                        { label: "Manual B-roll", value: "manual_broll" },
                      ]}
                      value={motionScope}
                      onValueChange={(value) => setMotionScope(value as typeof motionScope)}
                    />

                    <MotionSelectionPreview change={motionChange} />

                    {motionScope === "clip_transition" ? (
                      <Stack gap="4">
                        <Box>
                          <Text textStyle="eyebrow" color="fg.muted" mb="1.5">
                            Transition
                          </Text>
                          <NativeSelect.Root size="sm">
                            <NativeSelect.Field
                              value={transitionType}
                              onChange={(event) =>
                                setTransitionType(
                                  event.currentTarget.value as StudioTransition["type"],
                                )
                              }
                            >
                              {TRANSITION_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect.Field>
                            <NativeSelect.Indicator />
                          </NativeSelect.Root>
                        </Box>
                        <Box>
                          <Flex align="center" justify="space-between" mb="2">
                            <Text textStyle="eyebrow" color="fg.muted">
                              Duration
                            </Text>
                            <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                              {transitionDurationSec.toFixed(2)}s
                            </Text>
                          </Flex>
                          <Slider.Root
                            value={[transitionDurationSec]}
                            min={0.1}
                            max={1.5}
                            step={0.05}
                            size="sm"
                            colorPalette="accent"
                            onValueChange={(details) =>
                              setTransitionDurationSec(details.value[0] ?? 0.4)
                            }
                          >
                            <Slider.Control>
                              <Slider.Track>
                                <Slider.Range />
                              </Slider.Track>
                              <Slider.Thumbs />
                            </Slider.Control>
                          </Slider.Root>
                        </Box>
                      </Stack>
                    ) : (
                      <Stack gap="4">
                        <Flex gap="3" direction={{ base: "column", sm: "row" }}>
                          <Box flex="1">
                            <Text textStyle="eyebrow" color="fg.muted" mb="1.5">
                              Entrance
                            </Text>
                            <NativeSelect.Root size="sm">
                              <NativeSelect.Field
                                value={motionEntrance}
                                onChange={(event) =>
                                  setMotionEntrance(
                                    event.currentTarget.value as ManualBrollMotion["entrance"],
                                  )
                                }
                              >
                                {ENTRANCE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                          </Box>
                          <Box flex="1">
                            <Text textStyle="eyebrow" color="fg.muted" mb="1.5">
                              Exit
                            </Text>
                            <NativeSelect.Root size="sm">
                              <NativeSelect.Field
                                value={motionExit}
                                onChange={(event) =>
                                  setMotionExit(
                                    event.currentTarget.value as ManualBrollMotion["exit"],
                                  )
                                }
                              >
                                {EXIT_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                          </Box>
                        </Flex>
                        <Box>
                          <Flex align="center" justify="space-between" mb="2">
                            <Text textStyle="eyebrow" color="fg.muted">Duration</Text>
                            <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">{motionDurationSec.toFixed(2)}s</Text>
                          </Flex>
                          <Slider.Root value={[motionDurationSec]} min={0.1} max={2} step={0.05} size="sm" colorPalette="accent" onValueChange={(details) => setMotionDurationSec(details.value[0] ?? 0.5)}>
                            <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
                          </Slider.Root>
                        </Box>
                      </Stack>
                    )}

                    <Box>
                      <CampaignSectionHead
                        label="Revision check"
                        summary={
                          motionPreflightState === "loading"
                            ? "Checking current revisions…"
                            : `${motionPreflight?.counts.eligible ?? 0} eligible · ${motionAttentionCount} attention`
                        }
                      />
                      <Stack gap="1.5">
                        {motionPreflightState === "loading" ? (
                          <Flex align="center" gap="2" py="3">
                            <Spinner size="xs" />
                            <Text fontSize="13px" color="fg.muted">
                              Reading the latest clip edits…
                            </Text>
                          </Flex>
                        ) : null}
                        {motionPreflight?.items.map((item, index) => {
                          const attention = item.status === "stale" || item.status === "ineligible";
                          return (
                            <ClipOutcomeRow
                              key={item.clipId}
                              tone={attention ? "attention" : "ok"}
                              title={`Clip ${index + 1}`}
                              detail={item.code ? userErrorMessage(item.code) : null}
                              trailing={
                                <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                                  {item.status} · revision {item.currentEditorRevision ?? "—"}
                                </Text>
                              }
                            />
                          );
                        })}
                      </Stack>
                    </Box>

                    {motionAttentionCount > 0 ? (
                      <CampaignNotice>
                        {(motionPreflight?.counts.eligible ?? 0) === 0
                          ? "Resolve the stale or ineligible clips before applying this motion."
                          : "Stale and ineligible clips will be recorded exactly as shown; eligible clips still apply."}
                      </CampaignNotice>
                    ) : null}
                  </Stack>
                ) : operation ? (
                  <Stack gap="5">
                    <Flex align="center" gap="3">
                      <OutcomeMark tone={outcomeTone(operation.status)} large />
                      <Box flex="1" minW="0">
                        <Text textStyle="title" fontSize="16px" textTransform="capitalize">
                          {operation.status.replaceAll("_", " ")}
                        </Text>
                        <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                          {operation.items.length || operation.requestedCount} items
                        </Text>
                      </Box>
                    </Flex>
                    <CampaignStatTiles
                      items={[
                        { label: "Changed", value: operation.succeededCount, tone: "accent" },
                        { label: "Unchanged", value: operation.unchangedCount },
                        { label: "Stale", value: operation.staleCount, tone: "warning" },
                        { label: "Ineligible", value: operation.ineligibleCount, tone: "warning" },
                        { label: "Failed", value: operation.failedCount, tone: "danger" },
                      ]}
                    />
                    <Stack gap="1.5">
                      {operation.items.map((item) => (
                        <ClipOutcomeRow
                          key={item.id}
                          tone={outcomeTone(item.status)}
                          title={`Clip ${clipsById.get(item.requestedClipId) ?? "—"}`}
                          detail={item.errorCode ? userErrorMessage(item.errorCode) : null}
                          trailing={
                            <Text fontSize="12px" color="fg.muted" textTransform="capitalize">
                              {item.status.replaceAll("_", " ")}
                            </Text>
                          }
                        />
                      ))}
                    </Stack>
                    {editorRetryRequest ? (
                      <Text fontSize="12px" color="fg.muted">
                        Retry creates a new operation for only the failed or refreshed stale clips. Completed and ineligible items stay untouched.
                      </Text>
                    ) : [
                        "apply_motion",
                        "apply_brand_profile",
                        "apply_style",
                        "apply_scene_template",
                      ].includes(operation.action) &&
                      operation.failedCount + operation.staleCount > 0 ? (
                      <Text fontSize="12px" color="fg.muted">
                        Keep these clips selected while the project refreshes their revision fences before retrying.
                      </Text>
                    ) : null}
                    {[
                      "apply_motion",
                      "apply_brand_profile",
                      "apply_style",
                      "apply_scene_template",
                    ].includes(operation.action) && operation.ineligibleCount > 0 ? (
                      <Text fontSize="12px" color="fg.muted">
                        Open ineligible clips in Studio to resolve their document constraints; retry never resubmits them automatically.
                      </Text>
                    ) : null}
                    {operation.bundle?.status === "completed" ? (
                      <Button
                        size="sm"
                        disabled={downloadingBundle}
                        onClick={() => void downloadBundle(operation.bundle?.id)}
                      >
                        {downloadingBundle ? <Spinner size="xs" /> : <Download size={14} />}
                        <Text ms="1">Download ZIP</Text>
                      </Button>
                    ) : null}
                  </Stack>
                ) : null}

                {error ? (
                  <Box mt="4">
                    <CampaignNotice tone="danger" role="alert">
                      {error}
                    </CampaignNotice>
                  </Box>
                ) : null}
              </Drawer.Body>
              <Drawer.Footer>
              <Drawer.ActionTrigger asChild>
              <Button variant="ghost" size="sm">
              Close
              </Button>
              </Drawer.ActionTrigger>
                {editorActionKind ? null : previewingRender ? (
                  <RenderClipsButton
                    projectId={projectId}
                    disabled={false}
                    buttonLabel="Choose formats"
                    isFreeTier={isFreeTier}
                    can1080pExport={can1080pExport}
                    clipIds={state.selectedClipIds}
                    size="sm"
                    defaultAspectRatio={defaultAspectRatio}
                    onQueued={() => setDrawerOpen(false)}
                  />
                ) : previewingBundle ? (
                  <Button
                    size="sm"
                    disabled={
                      submitting ||
                      bundlePreflightState !== "ready" ||
                      (bundlePreflight?.counts.eligible ?? 0) === 0
                    }
                    onClick={createBundle}
                  >
                    {submitting ? <Spinner size="xs" /> : <Archive size={14} />}
                    <Text ms="1">{submitting ? "Queueing…" : "Build ZIP"}</Text>
                  </Button>
                ) : previewingMotion ? (
                  <Button
                    size="sm"
                    disabled={submitting || !canSubmitMotion}
                    onClick={applySelectedMotion}
                  >
                    {submitting ? <Spinner size="xs" /> : <WandSparkles size={14} />}
                    <Text ms="1">{submitting ? "Applying…" : "Apply to selected"}</Text>
                  </Button>
                ) : operation?.action === "export_bundle" &&
                  ["partial", "failed"].includes(operation.status) ? (
                  <Button size="sm" disabled={submitting} onClick={retryBundle}>
                    {submitting ? <Spinner size="xs" /> : <RefreshCw size={14} />}
                    <Text ms="1">Retry eligible failures</Text>
                  </Button>
                ) : editorRetryRequest ? (
                  <Button
                    size="sm"
                    disabled={submitting}
                    onClick={retryEditorAction}
                  >
                    {submitting ? <Spinner size="xs" /> : <RefreshCw size={14} />}
                    <Text ms="1">
                      {submitting
                        ? "Retrying…"
                        : `Retry ${editorRetryRequest.input.clips.length} failed or stale`}
                    </Text>
                  </Button>
                ) : null}
              </Drawer.Footer>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </>
  );
}
