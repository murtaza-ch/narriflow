"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  clipAspectRatioOptions,
  planFeatureRequirement,
  userErrorMessage,
  type ClipAspectRatio,
  type ClipRenderResolution,
} from "@narriflow/validators";
import {
  Box,
  chakra,
  Flex,
  Link as ChakraLink,
  Popover,
  Portal,
  Stack,
  Text,
  VisuallyHidden,
} from "@chakra-ui/react";
import { AlertTriangle, Check, ChevronDown, Film, Gem, Info } from "lucide-react";
import { retryIngestFormAction } from "../actions";
import { authenticatedActionResultMessage } from "@/lib/authenticated-request-browser";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { useUpgrade } from "../../_components/upgrade";

/** Preselects exactly the given aspect ratio (falling back to 9:16 when
 *  none is provided) — never a hardcoded 9:16 regardless of what the
 *  committed pack's `defaultAspectRatio` says. */
function buildDefaultSelection(
  aspectRatio: ClipAspectRatio | undefined,
): Record<ClipAspectRatio, boolean> {
  return {
    "9:16": false,
    "1:1": false,
    "16:9": false,
    "4:5": false,
    [aspectRatio ?? "9:16"]: true,
  };
}

/** Where each shape plays, in a few words — the tile's only copy besides its ratio. */
const FORMAT_HINTS: Record<ClipAspectRatio, string> = {
  "9:16": "Shorts, Reels, TikTok",
  "1:1": "Square feed posts",
  "16:9": "YouTube and web",
  "4:5": "Instagram feed",
};

/** How long the "queued" confirmation stays before the popover closes itself. */
const QUEUED_CLOSE_MS = 1400;

/** A clip drawn in its own shape, 30px on its longest side. */
function RatioGlyph({
  ratioW,
  ratioH,
  active,
}: {
  ratioW: number;
  ratioH: number;
  active: boolean;
}) {
  const scale = 30 / Math.max(ratioW, ratioH);
  return (
    <Box
      aria-hidden="true"
      w={`${Math.round(ratioW * scale)}px`}
      h={`${Math.round(ratioH * scale)}px`}
      borderRadius="5px"
      bg={active ? "accent.solid" : "fg.subtle/35"}
      transition="background-color 120ms ease"
    />
  );
}

/** One output shape as a soft tile; picking it fills the tile with the accent tint. */
function FormatTile({
  option,
  hint,
  dimensions,
  checked,
  disabled,
  onToggle,
}: {
  option: (typeof clipAspectRatioOptions)[number];
  hint: string;
  dimensions: string;
  checked: boolean;
  disabled: boolean;
  onToggle(): void;
}) {
  return (
    <chakra.button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`${option.label}, ${hint}`}
      title={dimensions}
      disabled={disabled}
      onClick={onToggle}
      position="relative"
      display="flex"
      flexDirection="column"
      alignItems="center"
      gap="2"
      pt="3.5"
      pb="3"
      px="2"
      borderRadius="l2"
      bg={checked ? "accent.subtle" : "bg.soft"}
      cursor="pointer"
      transition="background-color 120ms ease"
      _hover={{ bg: checked ? "accent.muted" : "bg.softHover" }}
      _disabled={{ cursor: "not-allowed", opacity: 0.6 }}
    >
      <Flex boxSize="9" align="center" justify="center">
        <RatioGlyph ratioW={option.iconW} ratioH={option.iconH} active={checked} />
      </Flex>
      <Box textAlign="center" minW="0" maxW="full">
        <Text
          fontSize="14px"
          fontWeight="550"
          lineHeight="1.2"
          color={checked ? "accent.fg" : "fg"}
          fontVariantNumeric="tabular-nums"
        >
          {option.value}
        </Text>
        <Text fontSize="11px" color="fg.subtle" mt="0.5" truncate>
          {hint}
        </Text>
      </Box>
      {checked ? (
        <Flex
          aria-hidden="true"
          position="absolute"
          top="2"
          insetEnd="2"
          boxSize="4"
          align="center"
          justify="center"
          borderRadius="full"
          bg="accent.solid"
          color="accent.contrast"
        >
          <Check size={10} strokeWidth={3.5} />
        </Flex>
      ) : null}
    </chakra.button>
  );
}

export function RenderClipsButton({
  projectId,
  disabled,
  buttonLabel,
  isFreeTier = false,
  can1080pExport = !isFreeTier,
  clipIds,
  size = "sm",
  defaultAspectRatio,
  placement = "bottom-start",
  onQueued,
}: {
  projectId: string;
  disabled: boolean;
  buttonLabel: string;
  /** Free renders are 720p and watermarked. The project page says so up top,
   *  but a user confirming *this* render should not have to remember that. */
  isFreeTier?: boolean;
  /** vizard-parity Phase C export options — whether the owner's plan can
   *  render at 1080p (billing.service's hasFeature(tier, "export.1080p")),
   *  computed server-side by the page and threaded down through ClipsPanel.
   *  Defaults to the inverse of `isFreeTier` for any caller that hasn't been
   *  updated to pass it explicitly (today every free/paid split is the
   *  same line for both features — see PLAN_FEATURES). */
  can1080pExport?: boolean;
  /** When provided (non-empty), scopes the render to exactly these clips —
   *  the ranked-rows toolbar's bulk "Render selected" (Phase 3). Omitted
   *  entirely, the request renders across all of the project's clips (the
   *  original "Render clips" / "Re-render clips" behavior). */
  clipIds?: string[];
  size?: "xs" | "sm";
  /** The committed content pack's `defaultAspectRatio` — preselects this
   *  format instead of always defaulting to 9:16. Callers pass "16:9" for
   *  caption-only projects (that mode's render is always 16:9, independent
   *  of whatever the pack's own default says). Falls back to "9:16" when
   *  omitted. */
  defaultAspectRatio?: ClipAspectRatio;
  /** Which side of the button the popover opens on; a bar at the foot of the page opens upward. */
  placement?: "bottom-start" | "top-start";
  onQueued?(): void;
}) {
  const router = useRouter();
  const { currentTier } = useUpgrade();
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [selection, setSelection] = useState<Record<ClipAspectRatio, boolean>>(
    () => buildDefaultSelection(defaultAspectRatio),
  );
  // Defaults to the best resolution this plan allows — 1080p for paid,
  // 720p for free — rather than always defaulting to one value.
  const [resolution, setResolution] = useState<ClipRenderResolution>(() =>
    can1080pExport ? "1080p" : "720p",
  );
  const [submitting, setSubmitting] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAspectRatios = clipAspectRatioOptions
    .filter((option) => selection[option.value])
    .map((option) => option.value);
  const clipCount = clipIds && clipIds.length > 0 ? clipIds.length : null;
  const scope = clipCount
    ? `${clipCount} selected clip${clipCount === 1 ? "" : "s"}`
    : "All clips";
  const busy = isPending || submitting;
  const onQueuedRef = useRef(onQueued);
  onQueuedRef.current = onQueued;
  // Set when a render is queued, cleared once the caller has been told, so
  // `onQueued` runs exactly once however the confirmation ends.
  const queuedUnreportedRef = useRef(false);
  const reportQueued = useCallback(() => {
    if (!queuedUnreportedRef.current) return;
    queuedUnreportedRef.current = false;
    onQueuedRef.current?.();
  }, []);

  // The confirmation stays a moment, then the popover (and whatever opened it)
  // closes. Closing or reopening it sooner reports the render straight away.
  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => {
      setIsOpen(false);
      reportQueued();
    }, QUEUED_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [queued, reportQueued]);

  async function handleRender() {
    if (selectedAspectRatios.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/clips/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          aspectRatios: selectedAspectRatios,
          resolution,
          ...(clipIds && clipIds.length > 0 ? { clipIds } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        console.warn(JSON.stringify({ level: "error", message: "render_clips_failed", status: response.status }));
        setError(
          userErrorMessage(body?.error) ??
            "Could not start rendering. Please try again.",
        );
        return;
      }

      queuedUnreportedRef.current = true;
      setQueued(true);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      console.warn(JSON.stringify({ level: "error", message: "render_clips_failed", errorName: err instanceof Error ? err.name : "UnknownError" }));
      setError("Could not start rendering. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(details) => {
        setIsOpen(details.open);
        reportQueued();
        if (details.open) {
          setQueued(false);
          setError(null);
        }
      }}
      positioning={{ placement, gutter: 12 }}
    >
      <Popover.Trigger asChild>
        <Button size={size} disabled={disabled || isPending}>
          {isPending ? <Spinner size="xs" borderTopColor="accent.contrast" /> : null}
          <Text ms={isPending ? "1" : "0"}>{buttonLabel}</Text>
          <ChevronDown size={16} aria-hidden />
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="344px" maxW="calc(100vw - 24px)" p="4">
            {/* Mounted with the popover, so the change to "queued" is announced. */}
            <VisuallyHidden role="status">{queued ? "Render queued" : ""}</VisuallyHidden>
            {queued ? (
              <Stack gap="2.5" align="center" textAlign="center" py="5">
                <Flex
                  boxSize="10"
                  align="center"
                  justify="center"
                  borderRadius="full"
                  bg="accent.subtle"
                  color="accent.fg"
                  aria-hidden="true"
                >
                  <Check size={18} strokeWidth={2.5} />
                </Flex>
                <Box>
                  <Text fontSize="15px" fontWeight="550" letterSpacing="-0.01em">
                    Render queued
                  </Text>
                  <Text fontSize="12px" color="fg.muted" mt="0.5">
                    {selectedAspectRatios.length} format
                    {selectedAspectRatios.length === 1 ? "" : "s"} · {resolution}. Progress shows on this page.
                  </Text>
                </Box>
              </Stack>
            ) : (
              <Stack gap="4">
                <Box>
                  <Text fontSize="15px" fontWeight="550" letterSpacing="-0.01em" color="fg">
                    Render
                  </Text>
                  <Text fontSize="12px" color="fg.muted" mt="0.5">
                    {scope} · uses your plan's render capacity
                  </Text>
                </Box>

                <Box role="group" aria-label="Formats" display="grid" gridTemplateColumns="1fr 1fr" gap="2">
                  {clipAspectRatioOptions.map((option) => {
                    const scale = resolution === "720p" ? 2 / 3 : 1;
                    return (
                      <FormatTile
                        key={option.value}
                        option={option}
                        hint={FORMAT_HINTS[option.value]}
                        dimensions={`${Math.round(option.width * scale)}×${Math.round(option.height * scale)}`}
                        checked={selection[option.value]}
                        disabled={busy}
                        onToggle={() =>
                          setSelection((current) => ({
                            ...current,
                            [option.value]: !current[option.value],
                          }))
                        }
                      />
                    );
                  })}
                </Box>

                <Box>
                  <Flex align="center" justify="space-between" gap="3">
                    <Text fontSize="13px" fontWeight="500" color="fg.muted">
                      Resolution
                    </Text>
                    <SegmentedControl
                      size="sm"
                      aria-label="Resolution"
                      disabled={busy}
                      items={[
                        { label: "720p", value: "720p" },
                        {
                          label: (
                            <Flex align="center" gap="1.5">
                              1080p
                              {!can1080pExport ? (
                                <Box as="span" color="upgrade.fg" display="inline-flex">
                                  <Gem size={12} aria-hidden />
                                </Box>
                              ) : null}
                            </Flex>
                          ),
                          value: "1080p",
                          disabled: !can1080pExport,
                        },
                      ]}
                      value={resolution}
                      onValueChange={(value) =>
                        setResolution(value as ClipRenderResolution)
                      }
                    />
                  </Flex>
                  {!can1080pExport ? (
                    <PlanLimitNotice
                      message={planFeatureRequirement(currentTier, "export.1080p")?.message ?? null}
                      upgrade={featureUpgradePrompt(currentTier, "export.1080p", "Upgrade to export in 1080p")}
                    />
                  ) : null}
                  {isFreeTier ? (
                    <Flex align="center" gap="1.5" mt="2" color="fg.subtle">
                      <Info size={12} aria-hidden />
                      <Text fontSize="12px">Free-plan renders carry a watermark.</Text>
                    </Flex>
                  ) : null}
                </Box>

                {error ? (
                  <Flex role="alert" align="flex-start" gap="2" p="2.5" borderRadius="l2" bg="danger.subtle" color="danger.fg">
                    <Box mt="0.5" flexShrink={0}>
                      <AlertTriangle size={13} aria-hidden />
                    </Box>
                    <Text fontSize="12px">{error}</Text>
                  </Flex>
                ) : null}

                <Flex justify="space-between" align="center" gap="3">
                  <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                    {selectedAspectRatios.length} format
                    {selectedAspectRatios.length === 1 ? "" : "s"}
                    {clipCount
                      ? ` · ${selectedAspectRatios.length * clipCount} render${selectedAspectRatios.length * clipCount === 1 ? "" : "s"}`
                      : ""}
                  </Text>
                  <Button
                    size="sm"
                    disabled={selectedAspectRatios.length === 0 || busy}
                    onClick={handleRender}
                  >
                    {busy ? (
                      <Spinner size="xs" borderTopColor="accent.contrast" />
                    ) : (
                      <Film size={15} aria-hidden />
                    )}
                    <Text ms="1">{busy ? "Queuing…" : "Start render"}</Text>
                  </Button>
                </Flex>
              </Stack>
            )}
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

type RetryIngestState = { ok: boolean; error: string | null };

const initialRetryIngestState: RetryIngestState = { ok: true, error: null };

/**
 * Re-queues ingest for a project stuck in "failed". Wraps
 * retryIngestFormAction (a Server Action) with useActionState for a real
 * pending state and an inline, user-visible error — a bare
 * `<form action={fn}>` would show nothing for expected failures like hitting
 * the retry limit, since Next redacts thrown action errors in production.
 */
export function RetryIngestButton({
  projectId,
  disabled = false,
  limitReachedMessage,
}: {
  projectId: string;
  disabled?: boolean;
  /** Shown instead of the button once the retry limit has been reached. */
  limitReachedMessage?: string | null;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<
    RetryIngestState,
    FormData
  >(async (_previous, formData) => {
    const result = await retryIngestFormAction(formData);
    if (result.ok) {
      router.refresh();
      return { ok: true, error: null };
    }
    return {
      ok: false,
      error: authenticatedActionResultMessage(
        result,
        "Could not retry ingest. Please try again.",
      ),
    };
  }, initialRetryIngestState);

  if (disabled && limitReachedMessage) {
    // A dead end with no way forward is the thing this whole retry flow was
    // meant to remove, so the exhausted state still offers an exit.
    return (
      <Text fontSize="xs" color="fg.muted">
        {limitReachedMessage}{" "}
        <ChakraLink asChild color="accent.fg" textUnderlineOffset="3px">
          <Link href="/upload">Start a new import</Link>
        </ChakraLink>
        .
      </Text>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <Stack gap="1.5" align="flex-start">
        <Button
          type="submit"
          size="sm"
          variant="subtle"
          disabled={disabled || isPending}
        >
          {isPending ? (
            <Spinner size="xs" borderTopColor="accent.fg" />
          ) : null}
          <Text ms={isPending ? "1" : "0"}>Retry ingest</Text>
        </Button>
        {state.error ? (
          <Flex align="center" gap="1.5" color="danger.fg">
            <AlertTriangle size={12} aria-hidden />
            <Text fontSize="xs">{state.error}</Text>
          </Flex>
        ) : null}
      </Stack>
    </form>
  );
}
