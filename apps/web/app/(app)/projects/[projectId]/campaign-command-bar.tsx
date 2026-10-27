"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
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
import { Button } from "@narriflow/ui/components/button";
import { ActionMenu, type ActionMenuItem } from "@narriflow/ui/components/menu";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  Film,
  LayoutTemplate,
  MoreHorizontal,
  Palette,
  RefreshCw,
  WandSparkles,
  Trash2,
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
  type CampaignActionAvailability,
  type CampaignAvailableAction,
  type CampaignCommandState,
  type CampaignEditorRetryIntent,
  type CampaignEditorRetryRequest,
} from "./campaign-command-state";
import {
  CampaignEditorActionPreview,
  type CampaignEditorActionKind,
  type CampaignEditorOperationResult,
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

function outcomeColor(status: string) {
  if (status === "succeeded" || status === "completed" || status === "unchanged") {
    return "success.solid";
  }
  if (status === "stale" || status === "ineligible") return "warning.solid";
  if (status === "failed") return "danger.solid";
  return "accent.solid";
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

function campaignEditorRetryEndpoint(
  projectId: string,
  request: CampaignEditorRetryRequest,
) {
  if (request.action === "apply_brand_profile") {
    return `/api/projects/${projectId}/campaign-operations/apply-brand-profile`;
  }
  if (request.action === "apply_style") {
    return `/api/projects/${projectId}/campaign-operations/apply-style`;
  }
  if (request.action === "apply_motion") {
    return `/api/projects/${projectId}/campaign-operations/apply-motion`;
  }
  return `/api/projects/${projectId}/brand-profiles/${request.profileId}/scene-templates/${request.templateId}/apply`;
}

function MotionSelectionPreview({
  change,
}: {
  change: ApplyMotionSelectedInput["change"];
}) {
  return (
    <Flex
      layerStyle="well"
      minH="116px"
      position="relative"
      overflow="hidden"
      align="center"
      justify="center"
      bg="bg.subtle"
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
  const { openUpgrade } = useUpgrade();
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

  useEffect(() => {
    if (!drawerOpen || !operation || ["completed", "partial", "failed"].includes(operation.status)) {
      return;
    }
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/campaign-operations`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { operations?: CampaignOperation[] };
        const next = payload.operations?.find((candidate) => candidate.id === operation.id);
        if (!stopped && next) setOperation(next);
      } catch {
        // A missed poll is harmless; the next bounded interval reconciles it.
      }
    }, 2_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [drawerOpen, operation, projectId]);

  useEffect(() => {
    if (!drawerOpen || !previewingMotion) {
      setMotionPreflightState("idle");
      setMotionPreflight(null);
      return;
    }
    const controller = new AbortController();
    setMotionPreflightState("loading");
    setMotionPreflight(null);
    setError(null);
    void fetch(
      `/api/projects/${projectId}/campaign-operations/preview-editor-action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "apply_motion",
          input: JSON.parse(motionPreflightKey),
        }),
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (MotionPreflight & { message?: string })
          | null;
        if (!response.ok || !payload?.counts || !payload.items) {
          throw new Error(payload?.message || "Motion preflight could not be completed.");
        }
        setMotionPreflight(payload);
        setMotionPreflightState("ready");
      })
      .catch((preflightError: unknown) => {
        if (controller.signal.aborted) return;
        setMotionPreflightState("error");
        setError(
          preflightError instanceof Error
            ? preflightError.message
            : "Motion preflight could not be completed.",
        );
      });
    return () => controller.abort();
  }, [drawerOpen, motionPreflightKey, previewingMotion, projectId]);

  useEffect(() => {
    if (!drawerOpen || !previewingBundle) {
      setBundlePreflightState("idle");
      setBundlePreflight(null);
      return;
    }
    const controller = new AbortController();
    setBundlePreflightState("loading");
    setBundlePreflight(null);
    setError(null);
    void fetch(`/api/projects/${projectId}/export-bundles/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bundlePreflightKey,
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (BundlePreflight & { message?: string })
          | null;
        if (!response.ok || !payload?.counts || !payload.items) {
          throw new Error(
            payload?.message || "Bundle availability could not be checked.",
          );
        }
        setBundlePreflight(payload);
        setBundlePreflightState("ready");
      })
      .catch((preflightError: unknown) => {
        if (controller.signal.aborted) return;
        setBundlePreflightState("error");
        setError(
          preflightError instanceof Error
            ? preflightError.message
            : "Bundle availability could not be checked.",
        );
      });
    return () => controller.abort();
  }, [bundlePreflightKey, drawerOpen, previewingBundle, projectId]);

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
      const response = await fetch(`/api/projects/${projectId}/export-bundles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: bundlePreflightKey,
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            message?: string;
            operationId?: string;
            manifest?: {
              included: Array<{ clipId: string }>;
              excluded: Array<{ clipId: string; code: string }>;
            };
          }
        | null;
      if (!response.ok || !payload?.operationId) {
        setError(
          payload?.message ||
            (payload?.error && userErrorMessage(payload.error)) ||
            "The export bundle could not be queued.",
        );
        return;
      }
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
    } catch {
      setError("The export bundle could not be queued. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryBundle() {
    if (!operation || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/campaign-operations/${operation.id}/retry-export-bundle`,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        operationId?: string;
        error?: string;
        message?: string;
      } | null;
      if (!response.ok || !payload?.operationId) {
        setError(payload?.message || "No failed bundle items can be retried.");
        return;
      }
      setOperation({ ...operation, id: payload.operationId, status: "running" });
    } catch {
      setError("The failed bundle items could not be retried.");
    } finally {
      setSubmitting(false);
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

  async function receiveEditorActionResult(
    result: CampaignEditorOperationResult,
    nextRetryIntent: CampaignEditorRetryIntent,
  ) {
    let hydrated: CampaignOperation | null = null;
    try {
      const response = await fetch(
        `/api/projects/${projectId}/campaign-operations`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          operations?: CampaignOperation[];
        };
        hydrated =
          payload.operations?.find(
            (candidate) => candidate.id === result.operationId,
          ) ?? null;
      }
    } catch {
      // The settled operation summary remains truthful when history hydration
      // misses one request. Project refresh reconciles the item rows.
    }
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
    router.refresh();
  }

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
      const response = await fetch(
        `/api/projects/${projectId}/campaign-operations/apply-motion`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify(
            motionPreflightInput,
          ),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            message?: string;
            operationId?: string;
            status?: string;
            requestedCount?: number;
            counts?: {
              succeeded: number;
              unchanged: number;
              stale: number;
              ineligible: number;
              failed: number;
            };
          }
        | null;
      if (!response.ok || !payload?.operationId || !payload.counts) {
        setError(
          payload?.message ||
            (payload?.error && userErrorMessage(payload.error)) ||
            "Motion could not be applied to the selected clips.",
        );
        return;
      }

      let hydrated: CampaignOperation | null = null;
      try {
        const listResponse = await fetch(
          `/api/projects/${projectId}/campaign-operations`,
          { cache: "no-store" },
        );
        if (listResponse.ok) {
          const list = (await listResponse.json()) as {
            operations?: CampaignOperation[];
          };
          hydrated =
            list.operations?.find(
              (candidate) => candidate.id === payload.operationId,
            ) ?? null;
        }
      } catch {
        // The settled snapshot below remains truthful if operation-history
        // hydration misses one request; a later project refresh reconciles it.
      }
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
      router.refresh();
    } catch {
      setError("Motion could not be applied. Check the connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryEditorAction() {
    if (!operation || !editorRetryRequest || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        campaignEditorRetryEndpoint(projectId, editorRetryRequest),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
            "campaign-retry-of": operation.id,
          },
          body: JSON.stringify(editorRetryRequest.input),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | (Partial<CampaignEditorOperationResult> & {
            error?: string;
            message?: string;
          })
        | null;
      if (!response.ok || !payload?.operationId || !payload.counts) {
        throw new Error(
          payload?.message ||
            (payload?.error && userErrorMessage(payload.error)) ||
            "The failed campaign items could not be retried.",
        );
      }

      let hydrated: CampaignOperation | null = null;
      try {
        const listResponse = await fetch(
          `/api/projects/${projectId}/campaign-operations`,
          { cache: "no-store" },
        );
        if (listResponse.ok) {
          const list = (await listResponse.json()) as {
            operations?: CampaignOperation[];
          };
          hydrated =
            list.operations?.find(
              (candidate) => candidate.id === payload.operationId,
            ) ?? null;
        }
      } catch {
        // The settled retry summary remains truthful if item hydration misses
        // this request; the project refresh below reconciles the item rows.
      }
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
      router.refresh();
    } catch (retryError) {
      setError(
        retryError instanceof Error
          ? retryError.message
          : "The failed campaign items could not be retried.",
      );
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
    item: { value: string; label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean },
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
    {
      value: "clear",
      label: "Clear selection",
      icon: <Trash2 size={14} />,
      onSelect: onClear,
    },
  ];

  if (state.selectedCount === 0) return null;

  return (
    <>
      <Flex align="center" gap="2">
        {state.primary === "prepare_exports" ? (
          <RenderClipsButton
            projectId={projectId}
            disabled={false}
            buttonLabel={actionLabel(state)}
            isFreeTier={isFreeTier}
            can1080pExport={can1080pExport}
            clipIds={state.attentionItems.map((item) => item.clipId)}
            size="sm"
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
            defaultAspectRatio={defaultAspectRatio}
          />
        ) : state.primary ? (
          <Button size="sm" onClick={runPrimary}>
            <Archive size={13} />
            <Text ms="1">{actionLabel(state)}</Text>
          </Button>
        ) : null}
        <ActionMenu
          ariaLabel="More campaign actions"
          items={menuItems}
          trigger={
            <Button size="sm" variant="subtle" aria-label="More campaign actions">
              <MoreHorizontal size={14} />
              <Text display={{ base: "none", md: "inline" }} ms="1">
                More
              </Text>
            </Button>
          }
        />
      </Flex>

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
              <Stack gap="1">
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
                  <Stack gap="4">
                    <Box>
                      <Text fontSize="sm" color="fg">
                        Queue new render variants for all {state.selectedCount} selected
                        {state.selectedCount === 1 ? " clip" : " clips"}.
                      </Text>
                      <Text fontSize="xs" color="fg.muted" mt="1">
                        Choose any supported aspect ratio and resolution. Existing ready exports remain immutable.
                      </Text>
                    </Box>
                    <Stack gap="0">
                      {state.selectedItems.map((item, index) => (
                        <Flex
                          key={item.clipId}
                          align="center"
                          justify="space-between"
                          py="2.5"
                          borderBottomWidth="1px"
                          borderColor="border.subtle"
                        >
                          <Text fontSize="sm">Clip {index + 1}</Text>
                          <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                            revision {item.expectedEditorRevision}
                          </Text>
                        </Flex>
                      ))}
                    </Stack>
                  </Stack>
                ) : previewingBundle ? (
                  <Stack gap="5">
                    <Box>
                      <Text fontSize="sm" color="fg">
                        {bundlePreflightState === "loading"
                          ? "Checking the selected export revisions…"
                          : `${bundlePreflight?.counts.eligible ?? 0} exact export${bundlePreflight?.counts.eligible === 1 ? "" : "s"} will be frozen into one ZIP.`}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" mt="1">
                        {defaultAspectRatio} · {resolution}
                        {bundlePreflight
                          ? ` · about ${formatBundleSize(bundlePreflight.estimatedSizeBytes)}`
                          : " · server preflight"}
                      </Text>
                    </Box>
                    {bundlePreflightState === "loading" ? (
                      <Flex align="center" gap="2" color="fg.muted">
                        <Spinner size="xs" />
                        <Text fontSize="xs">Verifying revisions and immutable files</Text>
                      </Flex>
                    ) : null}
                    {bundlePreflight &&
                    bundlePreflight.counts.stale + bundlePreflight.counts.ineligible > 0 ? (
                      <Flex
                        align="flex-start"
                        gap="2"
                        p="3"
                        borderStartWidth="3px"
                        borderStartColor="warning.solid"
                        bg="warning.subtle"
                      >
                        <AlertTriangle size={14} />
                        <Text fontSize="xs">
                          {bundlePreflight.counts.stale + bundlePreflight.counts.ineligible} selected clip
                          {bundlePreflight.counts.stale + bundlePreflight.counts.ineligible === 1 ? " needs" : "s need"} attention and will not be included.
                        </Text>
                      </Flex>
                    ) : null}
                    <Stack gap="0">
                      {bundlePreflight?.items.map((item) => (
                        <Flex
                          key={item.clipId}
                          align="center"
                          justify="space-between"
                          py="2.5"
                          borderBottomWidth="1px"
                          borderColor="border.subtle"
                        >
                          <Flex align="center" gap="2">
                            {item.status === "eligible" ? (
                              <Box color="success.fg" display="flex">
                              <Check size={13} />
                              </Box>
                            ) : (
                              <AlertTriangle size={13} />
                            )}
                            <Box>
                              <Text fontSize="sm">
                                Clip {clipsById.get(item.clipId) ?? "—"}
                              </Text>
                              <Text fontSize="xs" color="fg.muted">
                                {item.status === "eligible"
                                  ? `${item.aspectRatios.join(", ")} · ${formatBundleSize(item.estimatedSizeBytes)}`
                                  : bundleAttentionMessage(item)}
                              </Text>
                            </Box>
                          </Flex>
                          <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                            {item.status === "stale" && item.currentEditorRevision !== null
                              ? `${item.expectedEditorRevision} → ${item.currentEditorRevision}`
                              : `revision ${item.expectedEditorRevision}`}
                          </Text>
                        </Flex>
                      ))}
                    </Stack>
                  </Stack>
                ) : previewingMotion ? (
                  <Stack gap="5">
                    <Box>
                      <Text fontSize="sm" color="fg">
                        Apply one validated motion preset to {state.selectedCount} selected
                        {state.selectedCount === 1 ? " clip" : " clips"}.
                      </Text>
                      <Text fontSize="xs" color="fg.muted" mt="1">
                        Each clip keeps its own revision fence. Equivalent edits are recorded as unchanged.
                      </Text>
                    </Box>

                    <Flex gap="1">
                      {([
                        ["clip_transition", "Clip transition"],
                        ["manual_broll", "Manual B-roll"],
                      ] as const).map(([value, label]) => (
                        <Button
                          key={value}
                          flex="1"
                          size="sm"
                          variant={motionScope === value ? "subtle" : "ghost"}
                          color={motionScope === value ? "fg" : "fg.muted"}
                          aria-pressed={motionScope === value}
                          onClick={() => setMotionScope(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </Flex>

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
                      <Stack gap="3">
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
                      <Flex align="baseline" justify="space-between" mb="2">
                        <Text textStyle="eyebrow" color="fg.muted">
                        Revision check
                        </Text>
                        <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                          {motionPreflightState === "loading"
                            ? "Checking current revisions…"
                            : `${motionPreflight?.counts.eligible ?? 0} eligible · ${motionAttentionCount} attention`}
                        </Text>
                      </Flex>
                      <Stack gap="0">
                        {motionPreflightState === "loading" ? (
                          <Flex align="center" gap="2" py="3">
                            <Spinner size="xs" />
                            <Text fontSize="xs" color="fg.muted">
                              Reading the latest clip edits…
                            </Text>
                          </Flex>
                        ) : null}
                        {motionPreflight?.items.map((item, index) => {
                          const attention = item.status === "stale" || item.status === "ineligible";
                          return (
                            <Flex
                              key={item.clipId}
                              align="center"
                              justify="space-between"
                              py="2.5"
                              borderBottomWidth="1px"
                              borderColor="border.subtle"
                            >
                              <Flex align="center" gap="2">
                                {attention ? (
                                  <AlertTriangle size={13} />
                                ) : (
                                  <Box color="success.fg" display="flex">
                                  <Check size={13} />
                                  </Box>
                                )}
                                <Box>
                                  <Text fontSize="sm">Clip {index + 1}</Text>
                                  {item.code ? (
                                    <Text fontSize="xs" color="fg.muted">
                                      {userErrorMessage(item.code)}
                                    </Text>
                                  ) : null}
                                </Box>
                              </Flex>
                              <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                                {item.status} · revision {item.currentEditorRevision ?? "—"}
                              </Text>
                            </Flex>
                          );
                        })}
                      </Stack>
                    </Box>

                    {motionAttentionCount > 0 ? (
                      <Flex
                        align="flex-start"
                        gap="2"
                        p="3"
                        borderStartWidth="3px"
                        borderStartColor="warning.solid"
                        bg="warning.subtle"
                      >
                        <AlertTriangle size={14} />
                        <Text fontSize="xs">
                          {(motionPreflight?.counts.eligible ?? 0) === 0
                            ? "Resolve the stale or ineligible clips before applying this motion."
                            : "Stale and ineligible clips will be recorded exactly as shown; eligible clips still apply."}
                        </Text>
                      </Flex>
                    ) : null}
                  </Stack>
                ) : operation ? (
                  <Stack gap="4">
                    <Flex align="center" justify="space-between">
                      <Flex align="center" gap="2">
                        {!["completed", "partial", "failed"].includes(operation.status) ? (
                          <Spinner size="xs" />
                        ) : [
                            "apply_motion",
                            "apply_brand_profile",
                            "apply_style",
                            "apply_scene_template",
                          ].includes(operation.action) ? (
                          <WandSparkles size={14} />
                        ) : (
                          <Film size={14} />
                        )}
                        <Text textStyle="title" fontSize="sm">
                          {operation.status.replaceAll("_", " ")}
                        </Text>
                      </Flex>
                      <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.subtle">
                      {operation.items.length || operation.requestedCount} items
                      </Text>
                    </Flex>
                    <Flex
                    py="3"
                    gap="4"
                      justify="space-between"
                      flexWrap="wrap"
                    >
                      {([
                        ["Changed", operation.succeededCount],
                        ["Unchanged", operation.unchangedCount],
                        ["Stale", operation.staleCount],
                        ["Ineligible", operation.ineligibleCount],
                        ["Failed", operation.failedCount],
                      ] as const).map(([label, count]) => (
                        <Box key={label} minW="50px">
                          <Text fontSize="sm" fontVariantNumeric="tabular-nums" color="fg">
                          {count}
                          </Text>
                          <Text textStyle="eyebrow" fontSize="12px" color="fg.muted">
                            {label}
                          </Text>
                        </Box>
                      ))}
                    </Flex>
                    <Stack gap="0">
                      {operation.items.map((item) => (
                        <Flex
                          key={item.id}
                          position="relative"
                          align="center"
                          justify="space-between"
                          gap="3"
                          ps="3"
                          py="2.5"
                          borderBottomWidth="1px"
                          borderColor="border.subtle"
                        >
                          <Box
                            position="absolute"
                            insetInlineStart="0"
                            top="0"
                            bottom="0"
                            w="3px"
                            bg={outcomeColor(item.status)}
                          />
                          <Box minW="0">
                            <Text fontSize="sm">
                              Clip {clipsById.get(item.requestedClipId) ?? "—"}
                            </Text>
                            {item.errorCode ? (
                              <Text fontSize="xs" color="fg.muted">
                                {userErrorMessage(item.errorCode)}
                              </Text>
                            ) : null}
                          </Box>
                          <Text textStyle="eyebrow" color="fg.muted">
                          {item.status.replaceAll("_", " ")}
                          </Text>
                        </Flex>
                      ))}
                    </Stack>
                    {editorRetryRequest ? (
                      <Text fontSize="xs" color="fg.muted">
                        Retry creates a new operation for only the failed or refreshed stale clips. Completed and ineligible items stay untouched.
                      </Text>
                    ) : [
                        "apply_motion",
                        "apply_brand_profile",
                        "apply_style",
                        "apply_scene_template",
                      ].includes(operation.action) &&
                      operation.failedCount + operation.staleCount > 0 ? (
                      <Text fontSize="xs" color="fg.muted">
                        Keep these clips selected while the project refreshes their revision fences before retrying.
                      </Text>
                    ) : null}
                    {[
                      "apply_motion",
                      "apply_brand_profile",
                      "apply_style",
                      "apply_scene_template",
                    ].includes(operation.action) && operation.ineligibleCount > 0 ? (
                      <Text fontSize="xs" color="fg.muted">
                        Open ineligible clips in Studio to resolve their document constraints; retry never resubmits them automatically.
                      </Text>
                    ) : null}
                    {operation.bundle?.status === "completed" ? (
                      <Button size="sm" asChild>
                        <a
                          href={`/api/projects/${projectId}/export-bundles/${operation.bundle.id}/download`}
                        >
                          <Download size={14} />
                          <Text ms="1">Download ZIP</Text>
                        </a>
                      </Button>
                    ) : null}
                  </Stack>
                ) : null}

                {error ? (
                  <Flex role="alert" align="flex-start" gap="2" color="danger.fg" mt="4">
                    <AlertTriangle size={14} />
                    <Text fontSize="xs">{error}</Text>
                  </Flex>
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
                    {submitting ? <Spinner size="xs" /> : <ChevronRight size={14} />}
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
