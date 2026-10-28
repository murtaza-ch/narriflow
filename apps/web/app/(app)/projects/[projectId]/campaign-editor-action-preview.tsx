"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Box, Flex, Grid, NativeSelect, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Check, LayoutTemplate, Palette, Sparkles } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import { userErrorMessage } from "@narriflow/validators";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import type { Intent } from "@narriflow/api-client";
import { clipMutationOptions, clipQueries } from "@narriflow/api-client/clips";
import { intentIn, requireClipApi, useClipApi } from "@/lib/clip-media";
import {
  buildApplyProjectBrandProfileSelectedInput,
  buildApplySceneTemplateSelectedInput,
  buildApplyStyleSelectedInput,
  type CampaignCommandState,
  type CampaignEditorRetryIntent,
  serializeCampaignEditorActionPreflightRequest,
  submitCampaignEditorAction,
} from "./campaign-command-state";
import { clipActionErrorCopy } from "./clip-action-error-copy";

export type CampaignEditorActionKind = "brand_profile" | "style" | "scene";

type CatalogStyle = {
  id: string;
  name: string;
  fingerprint: string;
  fontName: string;
  captionPosition: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string | null;
  current: boolean;
};

type CatalogScene = {
  id: string;
  name: string;
  role: string;
  fingerprint: string;
  durationSec: number;
  contentKind: "video" | "image" | "color" | "text";
  isDefault: boolean;
};

type CampaignEditorActionCatalog = {
  profile: {
    id: string;
    name: string;
    fingerprint: string;
    styleFingerprint: string | null;
    currentStyle: {
      id: string | null;
      name: string | null;
      fontName: string;
      primaryColor: string;
      secondaryColor: string;
    } | null;
  } | null;
  styles: CatalogStyle[];
  scenes: CatalogScene[];
};

export type CampaignEditorOperationResult = {
  operationId: string;
  status: string;
  requestedCount: number;
  counts: {
    succeeded: number;
    unchanged: number;
    stale: number;
    ineligible: number;
    failed: number;
  };
};

type CampaignEditorActionPreflight = {
  action: "apply_brand_profile" | "apply_style" | "apply_scene_template";
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

function actionCopy(kind: CampaignEditorActionKind) {
  if (kind === "brand_profile") {
    return {
      description:
        "Restores the Project’s frozen caption style and makes each clip inherit its frozen logo presentation.",
      icon: <Sparkles size={15} />,
    };
  }
  if (kind === "style") {
    return {
      description:
        "Applies one member style through the same caption reducer as Studio. Clip-specific size and position stay intact.",
      icon: <Palette size={15} />,
    };
  }
  return {
    description:
      "Copies a frozen Scene Template into every selected editor document. Later template edits cannot change these clips.",
    icon: <LayoutTemplate size={15} />,
  };
}

/** What a clip's row says about it: done, needs a look, stopped, or still running. */
export type OutcomeTone = "ok" | "attention" | "failed" | "progress";

const OUTCOME_MARKS: Record<OutcomeTone, { bg: string; fg: string }> = {
  ok: { bg: "accent.subtle", fg: "accent.fg" },
  attention: { bg: "warning.subtle", fg: "warning.fg" },
  failed: { bg: "danger.subtle", fg: "danger.fg" },
  progress: { bg: "bg.muted", fg: "fg.muted" },
};

/** A round mark: the colour and glyph say the outcome before the words do. */
export function OutcomeMark({ tone, large = false }: { tone: OutcomeTone; large?: boolean }) {
  const colors = OUTCOME_MARKS[tone];
  return (
    <Flex
      boxSize={large ? "10" : "6"}
      flexShrink={0}
      align="center"
      justify="center"
      borderRadius="full"
      bg={colors.bg}
      color={colors.fg}
      aria-hidden="true"
    >
      {tone === "progress" ? (
        <Spinner size="xs" />
      ) : tone === "ok" ? (
        <Check size={large ? 18 : 13} strokeWidth={2.75} />
      ) : (
        <AlertTriangle size={large ? 17 : 12} strokeWidth={2.25} />
      )}
    </Flex>
  );
}

/** One clip in a drawer list, as a soft row: optional outcome mark, name, detail, trailing facts. */
export function ClipOutcomeRow({
  tone,
  title,
  detail,
  trailing,
}: {
  tone?: OutcomeTone;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <Flex align="center" gap="3" px="3" py="2.5" borderRadius="l2" bg="bg.soft">
      {tone ? <OutcomeMark tone={tone} /> : null}
      <Box flex="1" minW="0">
        <Text fontSize="13px" fontWeight="500" lineHeight="1.35">
          {title}
        </Text>
        {detail ? (
          <Text fontSize="12px" color="fg.muted" lineHeight="1.35">
            {detail}
          </Text>
        ) : null}
      </Box>
      {trailing ? (
        <Box flexShrink={0} textAlign="end">
          {trailing}
        </Box>
      ) : null}
    </Flex>
  );
}

/** A section heading with its running tally on the right. */
export function CampaignSectionHead({ label, summary }: { label: string; summary?: ReactNode }) {
  return (
    <Flex align="baseline" justify="space-between" gap="3" mb="2.5">
      <Text textStyle="eyebrow" color="fg.muted">
        {label}
      </Text>
      {summary ? (
        <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
          {summary}
        </Text>
      ) : null}
    </Flex>
  );
}

/** Counts as soft tiles; a tone tints a tile only while its count is above zero. */
export function CampaignStatTiles({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: number | string; tone?: "accent" | "warning" | "danger" }>;
}) {
  return (
    <Grid templateColumns={`repeat(${items.length}, minmax(0, 1fr))`} gap="2">
      {items.map(({ label, value, tone }) => {
        const lit = tone !== undefined && Number(value) > 0;
        return (
          <Box key={label} px="3" py="2.5" borderRadius="l2" bg={lit ? `${tone}.subtle` : "bg.soft"}>
            <Text
              fontSize="17px"
              fontWeight="550"
              lineHeight="1.2"
              fontVariantNumeric="tabular-nums"
              color={lit ? `${tone}.fg` : "fg"}
            >
              {value}
            </Text>
            <Text fontSize="11px" color={lit ? `${tone}.fg` : "fg.subtle"} mt="0.5">
              {label}
            </Text>
          </Box>
        );
      })}
    </Grid>
  );
}

/** A soft notice with its glyph: a warning to look at, or an error that stopped the action. */
export function CampaignNotice({
  tone = "warning",
  role,
  action,
  children,
}: {
  tone?: "warning" | "danger";
  role?: "alert";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Flex role={role} align="center" gap="2.5" px="3" py="2.5" borderRadius="l2" bg={`${tone}.subtle`}>
      <Box color={`${tone}.fg`} flexShrink={0} aria-hidden="true">
        <AlertTriangle size={14} />
      </Box>
      <Text fontSize="13px" flex="1" color={tone === "danger" ? "danger.fg" : "fg"}>
        {children}
      </Text>
      {action}
    </Flex>
  );
}

function SelectionRevisionPreview({
  state,
  preflight,
  loading,
  unavailable,
}: {
  state: CampaignCommandState;
  preflight: CampaignEditorActionPreflight | null;
  loading: boolean;
  unavailable: boolean;
}) {
  const itemById = new Map(
    preflight?.items.map((item) => [item.clipId, item]) ?? [],
  );
  return (
    <Box>
      <CampaignSectionHead
        label="Revision check"
        summary={
          loading
            ? "Checking…"
            : preflight
              ? `${preflight.counts.eligible} eligible · ${preflight.counts.unchanged} unchanged · ${preflight.counts.stale + preflight.counts.ineligible} attention`
              : `${state.selectedCount} selected`
        }
      />
      <Stack gap="1.5">
        {state.selectedItems.map((item, index) => {
          const result = itemById.get(item.clipId);
          const attention = result?.status === "stale" || result?.status === "ineligible";
          return (
            <ClipOutcomeRow
              key={item.clipId}
              tone={loading ? "progress" : unavailable || !result || attention ? "attention" : "ok"}
              title={`Clip ${index + 1}`}
              detail={
                result?.code
                  ? userErrorMessage(result.code)
                  : result?.status === "unchanged"
                    ? "Already equivalent"
                    : unavailable
                      ? "No action target available"
                      : null
              }
              trailing={
                <>
                  <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                    revision {item.expectedEditorRevision}
                  </Text>
                  {result?.status && result.status !== "eligible" ? (
                    <Text fontSize="11px" color={attention ? "warning.fg" : "fg.subtle"} textTransform="capitalize">
                      {result.status}
                    </Text>
                  ) : null}
                </>
              }
            />
          );
        })}
      </Stack>
    </Box>
  );
}

function ColorPair({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <Flex gap="1" aria-label={`Colors ${primary} and ${secondary}`}>
      <Box w="18px" h="28px" borderRadius="l1" bg={primary} borderWidth="1px" borderColor="border.subtle" />
      <Box w="18px" h="28px" borderRadius="l1" bg={secondary} borderWidth="1px" borderColor="border.subtle" />
    </Flex>
  );
}

export function CampaignEditorActionPreview({
  kind,
  projectId,
  state,
  onApplied,
}: {
  kind: CampaignEditorActionKind;
  projectId: string;
  state: CampaignCommandState;
  onApplied(
    result: CampaignEditorOperationResult,
    retryIntent: CampaignEditorRetryIntent,
  ): Promise<void>;
}) {
  const api = useClipApi();
  // The catalog is read fresh when the drawer opens and left alone while the user chooses.
  const catalogOptions = api ? clipQueries.editorActionCatalog(api.clips, api.scope, projectId) : null;
  const catalogQuery = useQuery({
    queryKey: catalogOptions?.queryKey ?? ["nf", "clips", "editor-action-catalog", "unavailable"],
    queryFn: catalogOptions?.queryFn ?? skipToken,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const catalog: CampaignEditorActionCatalog | null = catalogQuery.data ?? null;
  const loadState: "loading" | "ready" | "error" = catalogQuery.isError
    ? "error"
    : catalogQuery.isPending
      ? "loading"
      : "ready";
  const [selectedStyleId, setSelectedStyleId] = useState("");
  const [placement, setPlacement] = useState<"start" | "end">("start");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preflight, setPreflight] =
    useState<CampaignEditorActionPreflight | null>(null);
  const [preflightState, setPreflightState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const copy = actionCopy(kind);

  useEffect(() => {
    if (!catalog) return;
    setSelectedStyleId(
      catalog.styles.find((style) => style.current)?.id ?? catalog.styles[0]?.id ?? "",
    );
  }, [catalog]);
  const loadErrorMessage = catalogQuery.error
    ? clipActionErrorCopy(catalogQuery.error, "Campaign styles could not be loaded.")
    : null;

  const scenes = useMemo(
    () => catalog?.scenes.filter((scene) => scene.role === (placement === "start" ? "intro" : "outro")) ?? [],
    [catalog, placement],
  );
  useEffect(() => {
    if (!scenes.some((scene) => scene.id === selectedSceneId)) {
      setSelectedSceneId(
        scenes.find((scene) => scene.isDefault)?.id ?? scenes[0]?.id ?? "",
      );
    }
  }, [scenes, selectedSceneId]);

  const selectedStyle = catalog?.styles.find((style) => style.id === selectedStyleId) ?? null;
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? null;
  const previewRequest = useMemo(() => {
    if (kind === "brand_profile" && catalog?.profile) {
      return {
        action: "apply_brand_profile" as const,
        input: buildApplyProjectBrandProfileSelectedInput(
          catalog.profile.fingerprint,
          catalog.profile.styleFingerprint,
          state.selectedItems,
        ),
      };
    }
    if (kind === "style" && selectedStyle) {
      return {
        action: "apply_style" as const,
        input: buildApplyStyleSelectedInput(
          selectedStyle.id,
          selectedStyle.fingerprint,
          state.selectedItems,
        ),
      };
    }
    if (kind === "scene" && catalog?.profile && selectedScene) {
      return {
        action: "apply_scene_template" as const,
        profileId: catalog.profile.id,
        templateId: selectedScene.id,
        input: buildApplySceneTemplateSelectedInput(
          selectedScene.fingerprint,
          placement,
          state.selectedItems,
        ),
      };
    }
    return null;
  }, [
    catalog?.profile,
    kind,
    placement,
    selectedScene,
    selectedStyle,
    state.selectedItems,
  ]);
  const preflightRequestBody = useMemo(
    () => serializeCampaignEditorActionPreflightRequest(previewRequest),
    [previewRequest],
  );

  useEffect(() => {
    if (!preflightRequestBody) {
      setPreflight(null);
      setPreflightState("idle");
      setPreviewError(null);
      return;
    }
    if (!api) return;
    const controller = new AbortController();
    setPreflight(null);
    setPreflightState("loading");
    setPreviewError(null);
    void api.clips.projects[":id"]["campaign-operations"]["preview-editor-action"]
      .$post(
        { param: { id: projectId }, json: JSON.parse(preflightRequestBody) },
        { init: { signal: controller.signal } },
      )
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.items || !payload.counts) {
          throw new Error("Clip eligibility could not be checked.");
        }
        setPreflight(payload as CampaignEditorActionPreflight);
        setPreflightState("ready");
      })
      .catch((previewFailure: unknown) => {
        if (controller.signal.aborted) return;
        setPreflightState("error");
        setPreviewError(clipActionErrorCopy(previewFailure, "Clip eligibility could not be checked."));
      });
    return () => controller.abort();
  }, [preflightRequestBody, projectId, api]);

  const targetAvailable =
    kind === "brand_profile"
      ? catalog?.profile != null
      : kind === "style"
        ? selectedStyle != null
        : catalog?.profile != null && selectedScene != null;
  const hasActionableItems =
    preflight != null &&
    preflight.counts.eligible + preflight.counts.unchanged > 0;

  // One intent per apply: a retry of the same choice after a timeout or lost
  // response replays the accepted operation; a changed choice is a new intent.
  const applyIntent = useRef<Intent<unknown> | null>(null);
  const applyAction = useMutation({
    ...clipMutationOptions,
    mutationFn: async (request: NonNullable<typeof previewRequest>) => {
      const { runtime, clips, brand } = requireClipApi(api);
      const intent = intentIn(applyIntent, runtime);
      const accepted = await submitCampaignEditorAction({ clips, brand }, projectId, request, {
        idempotencyKey: intent.keyFor(request),
      });
      intent.complete();
      return accepted;
    },
  });

  async function apply() {
    if (
      submitting ||
      !targetAvailable ||
      preflightState !== "ready" ||
      !hasActionableItems ||
      state.selectedItems.length === 0 ||
      !catalog ||
      !previewRequest
    ) {
      return;
    }
    let retryIntent: CampaignEditorRetryIntent;
    if (previewRequest.action === "apply_brand_profile") {
      retryIntent = {
        action: previewRequest.action,
        profileFingerprint: previewRequest.input.profileFingerprint,
        styleFingerprint: previewRequest.input.styleFingerprint,
      };
    } else if (previewRequest.action === "apply_style") {
      retryIntent = {
        action: previewRequest.action,
        templateId: previewRequest.input.templateId,
        templateFingerprint: previewRequest.input.templateFingerprint,
      };
    } else if (previewRequest.action === "apply_scene_template") {
      retryIntent = {
        action: previewRequest.action,
        profileId: previewRequest.profileId,
        templateId: previewRequest.templateId,
        templateFingerprint: previewRequest.input.templateFingerprint,
        placement: previewRequest.input.placement,
      };
    } else {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload = await applyAction.mutateAsync(previewRequest);
      if (!payload.operationId || !payload.counts) {
        throw new Error("The campaign action could not be applied.");
      }
      await onApplied(
        {
          operationId: payload.operationId,
          status: payload.status ?? "completed",
          requestedCount: payload.requestedCount ?? state.selectedItems.length,
          counts: payload.counts,
        },
        retryIntent,
      );
    } catch (applyError) {
      setError(clipActionErrorCopy(applyError, "The campaign action could not be applied."));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadState === "loading") {
    return (
      <Flex minH="220px" align="center" justify="center" gap="2" color="fg.muted">
        <Spinner size="xs" />
        <Text fontSize="sm">Loading project brand system</Text>
      </Flex>
    );
  }

  return (
    <Stack gap="5">
      <Text fontSize="13px" color="fg.muted">
        {copy.description}
      </Text>

      {kind === "brand_profile" ? (
        catalog?.profile ? (
          <Flex bg="bg.soft" borderRadius="l2" p="4" align="center" justify="space-between" gap="4">
            <Box minW="0">
              <Text textStyle="eyebrow" color="fg.muted">Project profile</Text>
              <Text textStyle="title" fontSize="sm" mt="1" truncate>
                {catalog.profile.name}
              </Text>
              <Text fontSize="xs" color="fg.muted" mt="0.5">
                {catalog.profile.currentStyle?.name ?? "Logo inheritance only"}
                {catalog.profile.currentStyle?.fontName
                  ? ` · ${catalog.profile.currentStyle.fontName}`
                  : ""}
              </Text>
            </Box>
            {catalog.profile.currentStyle ? (
              <ColorPair
                primary={catalog.profile.currentStyle.primaryColor}
                secondary={catalog.profile.currentStyle.secondaryColor}
              />
            ) : null}
          </Flex>
        ) : (
          <BrandKitPrerequisite>Choose a Project Brand Profile before using this action.</BrandKitPrerequisite>
        )
      ) : null}

      {kind === "style" ? (
        <Stack gap="3">
          <Box>
            <Text textStyle="eyebrow" color="fg.muted" mb="1.5">Member style</Text>
            <NativeSelect.Root size="sm" disabled={(catalog?.styles.length ?? 0) === 0}>
              <NativeSelect.Field
                value={selectedStyleId}
                onChange={(event) => setSelectedStyleId(event.currentTarget.value)}
                
                >
                {catalog?.styles.length ? null : <option value="">No member styles</option>}
                {catalog?.styles.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.name}{style.current ? " · current" : ""}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Box>
          {selectedStyle ? (
            <Flex bg="bg.soft" borderRadius="l2" p="4" align="center" justify="space-between" gap="4">
              <Box>
                <Text textStyle="title" fontSize="sm">{selectedStyle.name}</Text>
                <Text fontSize="xs" color="fg.muted" mt="0.5">
                  {selectedStyle.fontName} · captions {selectedStyle.captionPosition}
                </Text>
              </Box>
              <ColorPair primary={selectedStyle.primaryColor} secondary={selectedStyle.secondaryColor} />
            </Flex>
          ) : (
            <BrandKitPrerequisite>Add a style to the Project Brand Profile before using this action.</BrandKitPrerequisite>
          )}
        </Stack>
      ) : null}

      {kind === "scene" ? (
        <Stack gap="3">
          <SegmentedControl
            aria-label="Placement"
            w="full"
            css={{ "& [data-part=item]": { flex: 1, justifyContent: "center" } }}
            items={[
              { label: "Intro", value: "start" },
              { label: "Outro", value: "end" },
            ]}
            value={placement}
            onValueChange={(value) => setPlacement(value as typeof placement)}
          />
          <Box>
            <Text textStyle="eyebrow" color="fg.muted" mb="1.5">Scene Template</Text>
            <NativeSelect.Root size="sm" disabled={scenes.length === 0}>
              <NativeSelect.Field
                value={selectedSceneId}
                onChange={(event) => setSelectedSceneId(event.currentTarget.value)}
                
                >
                {scenes.length ? null : <option value="">No {placement === "start" ? "intro" : "outro"} scenes</option>}
                {scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.name}{scene.isDefault ? " · default" : ""}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Box>
          {selectedScene ? (
            <Flex bg="bg.soft" borderRadius="l2" p="4" align="center" justify="space-between" gap="4">
              <Box>
                <Text textStyle="title" fontSize="sm">{selectedScene.name}</Text>
                <Text fontSize="xs" color="fg.muted" mt="0.5">
                  {selectedScene.contentKind} · {selectedScene.durationSec.toFixed(1)}s per clip
                </Text>
              </Box>
              <Text fontVariantNumeric="tabular-nums">
              +{(selectedScene.durationSec * state.selectedCount).toFixed(1)}s
              </Text>
            </Flex>
          ) : (
            <BrandKitPrerequisite>
              {catalog?.profile
                ? `Add an ${placement === "start" ? "intro" : "outro"} Scene Template before using this action.`
                : "Choose a Project Brand Profile before using this action."}
            </BrandKitPrerequisite>
          )}
        </Stack>
      ) : null}

      <SelectionRevisionPreview
        state={state}
        preflight={preflight}
        loading={preflightState === "loading"}
        unavailable={!targetAvailable}
      />

      {previewError ? (
        <CampaignNotice role="alert">{previewError}</CampaignNotice>
      ) : null}

      <CampaignStatTiles
        items={[
          { label: "Selected", value: state.selectedCount },
          { label: "Processing usage", value: "0 min" },
          { label: "Revision / changed clip", value: "1 max" },
        ]}
      />

      {error ?? loadErrorMessage ? (
        <CampaignNotice tone="danger" role="alert">
          {error ?? loadErrorMessage}
        </CampaignNotice>
      ) : null}

      {loadState === "error" ? null : (
        <Button
          size="sm"
          alignSelf="flex-end"
          disabled={
            submitting ||
            !targetAvailable ||
            preflightState !== "ready" ||
            !hasActionableItems ||
            state.selectedItems.length === 0
          }
          onClick={apply}
        >
          {submitting ? <Spinner size="xs" /> : copy.icon}
          <Text ms="1">{submitting ? "Applying…" : "Apply to selected"}</Text>
        </Button>
      )}
    </Stack>
  );
}

/** A missing brand prerequisite, with the way to where it's made. */
function BrandKitPrerequisite({ children }: { children: ReactNode }) {
  return (
    <CampaignNotice
      action={
        <Button size="xs" variant="ghost" asChild>
          <Link href="/brand-kit">Open Brand Kit</Link>
        </Button>
      }
    >
      {children}
    </CampaignNotice>
  );
}
