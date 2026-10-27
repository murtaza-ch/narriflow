"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Box, Flex, NativeSelect, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Check, LayoutTemplate, Palette, Sparkles } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { userErrorMessage } from "@narriflow/validators";
import {
  buildApplyProjectBrandProfileSelectedInput,
  buildApplySceneTemplateSelectedInput,
  buildApplyStyleSelectedInput,
  type CampaignCommandState,
  type CampaignEditorRetryIntent,
  serializeCampaignEditorActionPreflightRequest,
} from "./campaign-command-state";

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
  role: "intro" | "outro";
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
      title: "Apply project Brand Profile",
      description:
        "Restores the Project’s frozen caption style and makes each clip inherit its frozen logo presentation.",
      icon: <Sparkles size={15} />,
    };
  }
  if (kind === "style") {
    return {
      title: "Apply style preset",
      description:
        "Applies one member style through the same caption reducer as Studio. Clip-specific size and position stay intact.",
      icon: <Palette size={15} />,
    };
  }
  return {
    title: "Add intro or outro",
    description:
      "Copies a frozen Scene Template into every selected editor document. Later template edits cannot change these clips.",
    icon: <LayoutTemplate size={15} />,
  };
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
      <Flex align="baseline" justify="space-between" mb="2">
        <Text textStyle="eyebrow" color="fg.muted">
        Revision check
        </Text>
        <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
          {loading
            ? "Checking…"
            : preflight
              ? `${preflight.counts.eligible} eligible · ${preflight.counts.unchanged} unchanged · ${preflight.counts.stale + preflight.counts.ineligible} attention`
              : `${state.selectedCount} selected`}
        </Text>
      </Flex>
      <Stack gap="0">
      {state.selectedItems.map((item, index) => {
          const result = itemById.get(item.clipId);
          const attention = result?.status === "stale" || result?.status === "ineligible";
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
                {loading ? (
                  <Spinner size="xs" />
                ) : unavailable || !result ? (
                  <AlertTriangle size={13} />
                ) : attention ? (
                  <AlertTriangle size={13} />
                ) : (
                  <Box color="success.fg" display="flex">
                  <Check size={13} />
                  </Box>
                )}
                <Box>
                  <Text fontSize="sm">Clip {index + 1}</Text>
                  {result?.code ? (
                    <Text fontSize="xs" color="fg.muted">
                      {userErrorMessage(result.code)}
                    </Text>
                  ) : result?.status === "unchanged" ? (
                    <Text fontSize="xs" color="fg.muted">Already equivalent</Text>
                  ) : unavailable ? (
                    <Text fontSize="xs" color="fg.muted">No action target available</Text>
                  ) : null}
                </Box>
              </Flex>
              <Box textAlign="end">
                <Text fontSize="12px" fontVariantNumeric="tabular-nums" color="fg.muted">
                revision {item.expectedEditorRevision}
                </Text>
                {result?.status ? (
                <Text textStyle="eyebrow" fontSize="12px" color={attention ? "warning.fg" : "fg.muted"}>
                    {result.status}
                  </Text>
                ) : null}
              </Box>
            </Flex>
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
  const [catalog, setCatalog] = useState<CampaignEditorActionCatalog | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
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
    let stopped = false;
    setLoadState("loading");
    setError(null);
    void fetch(
      `/api/projects/${projectId}/campaign-operations/editor-action-catalog`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (CampaignEditorActionCatalog & { error?: string; message?: string })
          | null;
        if (!response.ok || !payload) {
          throw new Error(
            payload?.message ||
              (payload?.error && userErrorMessage(payload.error)) ||
              "Campaign styles could not be loaded.",
          );
        }
        if (stopped) return;
        setCatalog(payload);
        setSelectedStyleId(
          payload.styles.find((style) => style.current)?.id ??
            payload.styles[0]?.id ??
            "",
        );
        setLoadState("ready");
      })
      .catch((loadError: unknown) => {
        if (stopped) return;
        setLoadState("error");
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Campaign styles could not be loaded.",
        );
      });
    return () => {
      stopped = true;
    };
  }, [projectId]);

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
    const controller = new AbortController();
    setPreflight(null);
    setPreflightState("loading");
    setPreviewError(null);
    void fetch(
      `/api/projects/${projectId}/campaign-operations/preview-editor-action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: preflightRequestBody,
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (CampaignEditorActionPreflight & {
              error?: string;
              message?: string;
            })
          | null;
        if (!response.ok || !payload?.items || !payload.counts) {
          throw new Error(
            payload?.message ||
              (payload?.error && userErrorMessage(payload.error)) ||
              "Clip eligibility could not be checked.",
          );
        }
        setPreflight(payload);
        setPreflightState("ready");
      })
      .catch((previewFailure: unknown) => {
        if (controller.signal.aborted) return;
        setPreflightState("error");
        setPreviewError(
          previewFailure instanceof Error
            ? previewFailure.message
            : "Clip eligibility could not be checked.",
        );
    });
    return () => controller.abort();
  }, [preflightRequestBody, projectId]);

  const targetAvailable =
    kind === "brand_profile"
      ? catalog?.profile != null
      : kind === "style"
        ? selectedStyle != null
        : catalog?.profile != null && selectedScene != null;
  const hasActionableItems =
    preflight != null &&
    preflight.counts.eligible + preflight.counts.unchanged > 0;

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
    let endpoint: string;
    let body: unknown;
    let retryIntent: CampaignEditorRetryIntent;
    if (previewRequest.action === "apply_brand_profile") {
      endpoint = `/api/projects/${projectId}/campaign-operations/apply-brand-profile`;
      body = previewRequest.input;
      retryIntent = {
        action: previewRequest.action,
        profileFingerprint: previewRequest.input.profileFingerprint,
        styleFingerprint: previewRequest.input.styleFingerprint,
      };
    } else if (previewRequest.action === "apply_style") {
      endpoint = `/api/projects/${projectId}/campaign-operations/apply-style`;
      body = previewRequest.input;
      retryIntent = {
        action: previewRequest.action,
        templateId: previewRequest.input.templateId,
        templateFingerprint: previewRequest.input.templateFingerprint,
      };
    } else if (previewRequest.action === "apply_scene_template") {
      endpoint = `/api/projects/${projectId}/brand-profiles/${previewRequest.profileId}/scene-templates/${previewRequest.templateId}/apply`;
      body = previewRequest.input;
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
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
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
            "The campaign action could not be applied.",
        );
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
      setError(
        applyError instanceof Error
          ? applyError.message
          : "The campaign action could not be applied.",
      );
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
      <Flex align="flex-start" gap="3">
        <Flex
        flexShrink={0}
        w="32px"
        h="32px"
        align="center"
        justify="center"
        borderRadius="full"
        bg="bg.soft"
        color="fg.muted"
        >
        {copy.icon}
        </Flex>
        <Box>
        <Text textStyle="title" fontSize="md">
            {copy.title}
          </Text>
          <Text fontSize="xs" color="fg.muted" mt="1">
            {copy.description}
          </Text>
        </Box>
      </Flex>

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
          <Flex gap="1">
            {([['start', 'Intro'], ['end', 'Outro']] as const).map(([value, label]) => (
              <Button
                key={value}
                flex="1"
                size="sm"
                variant={placement === value ? "subtle" : "ghost"}
                color={placement === value ? "fg" : "fg.muted"}
                aria-pressed={placement === value}
                onClick={() => setPlacement(value)}
              >
                {label}
              </Button>
            ))}
          </Flex>
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
        <Flex role="alert" p="3" gap="2" color="warning.fg" bg="warning.subtle" borderStartWidth="3px" borderStartColor="warning.solid">
          <AlertTriangle size={14} />
          <Text fontSize="xs">{previewError}</Text>
        </Flex>
      ) : null}

      <Flex py="3" justify="space-between" gap="3">
        <Box>
          <Text fontSize="sm" fontVariantNumeric="tabular-nums">{state.selectedCount}</Text>
          <Text textStyle="eyebrow" fontSize="12px" color="fg.muted">Selected</Text>
        </Box>
        <Box textAlign="center">
          <Text fontSize="sm" fontVariantNumeric="tabular-nums">0 min</Text>
          <Text textStyle="eyebrow" fontSize="12px" color="fg.muted">Processing usage</Text>
        </Box>
        <Box textAlign="end">
          <Text fontSize="sm" fontVariantNumeric="tabular-nums">1 max</Text>
          <Text textStyle="eyebrow" fontSize="12px" color="fg.muted">Revision / changed clip</Text>
        </Box>
      </Flex>

      {error ? (
        <Flex role="alert" p="3" gap="2" color="danger.fg" bg="danger.subtle" borderStartWidth="3px" borderStartColor="danger.solid">
          <AlertTriangle size={14} />
          <Text fontSize="xs">{error}</Text>
        </Flex>
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
    <Flex p="3" gap="2" align="center" borderStartWidth="3px" borderStartColor="warning.solid" bg="warning.subtle">
      <AlertTriangle size={14} />
      <Text fontSize="xs" flex="1">{children}</Text>
      <Button size="xs" variant="ghost" asChild>
        <Link href="/brand-kit">Open Brand Kit</Link>
      </Button>
    </Flex>
  );
}
