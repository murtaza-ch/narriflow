"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  clipAspectRatioOptions,
  userErrorMessage,
  type ClipAspectRatio,
  type ClipRenderResolution,
} from "@narriflow/validators";
import {
  Box,
  Flex,
  Link as ChakraLink,
  Popover,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import { retryIngestFormAction } from "../actions";

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

export function RenderClipsButton({
  projectId,
  disabled,
  buttonLabel,
  isFreeTier = false,
  can1080pExport = !isFreeTier,
  clipIds,
  size = "sm",
  defaultAspectRatio,
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
}) {
  const router = useRouter();
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
  const [error, setError] = useState<string | null>(null);

  const selectedAspectRatios = clipAspectRatioOptions
    .filter((option) => selection[option.value])
    .map((option) => option.value);

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
        console.error("render_clips_failed", response.status, body);
        setError(
          userErrorMessage(body?.error) ??
            "Could not start rendering. Please try again.",
        );
        return;
      }

      setIsOpen(false);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      console.error("render_clips_failed", err);
      setError("Could not start rendering. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(details) => setIsOpen(details.open)}
      positioning={{ placement: "bottom-start" }}
    >
      <Popover.Trigger asChild>
        <Button size={size} disabled={disabled || isPending}>
          {isPending ? <Spinner size="xs" borderTopColor="accent.contrast" /> : null}
          <Text ms={isPending ? "1" : "0"}>{buttonLabel}</Text>
          <ChevronDown size={12} aria-hidden />
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content layerStyle="panel" boxShadow="cardHover" minW="240px" p="3">
            <Stack gap="3">
              <Box>
                <Text textStyle="eyebrow" color="fg.subtle">
                  Render formats
                </Text>
                <Text fontSize="11px" color="fg.muted" mt="0.5">
                  Choose which variants to queue{" "}
                  {clipIds && clipIds.length > 0
                    ? `across the ${clipIds.length} selected clip${clipIds.length === 1 ? "" : "s"}`
                    : "across all clips"}
                  . Rendering uses capacity on your plan.
                  {isFreeTier ? " Free-plan renders carry a watermark." : ""}
                </Text>
              </Box>

              <Stack gap="1.5">
                {clipAspectRatioOptions.map((option) => {
                  const checked = selection[option.value];

                  return (
                    <Flex
                      key={option.value}
                      align="center"
                      gap="2"
                      px="2"
                      py="1.5"
                      borderRadius="l1"
                      borderWidth="1px"
                      borderColor={checked ? "border.emphasized" : "border"}
                      bg={checked ? "bg.muted" : "transparent"}
                      transition="border-color 120ms ease, background 120ms ease"
                    >
                      <Checkbox
                        flex="1"
                        checked={checked}
                        onCheckedChange={(nextChecked) =>
                          setSelection((current) => ({
                            ...current,
                            [option.value]: nextChecked,
                          }))
                        }
                      >
                        <Box>
                          <Text fontSize="xs" color="fg">
                            {option.label}
                          </Text>
                          <Text textStyle="data" fontSize="10px" color="fg.muted">
                            {option.width}x{option.height}
                          </Text>
                        </Box>
                      </Checkbox>
                    </Flex>
                  );
                })}
              </Stack>

              <Box>
                <Text textStyle="eyebrow" color="fg.subtle" mb="1.5">
                  Resolution
                </Text>
                <SegmentedControl
                  size="sm"
                  items={[
                    { label: "720p", value: "720p" },
                    {
                      label: "1080p",
                      value: "1080p",
                      disabled: !can1080pExport,
                    },
                  ]}
                  value={resolution}
                  onValueChange={(value) =>
                    setResolution(value as ClipRenderResolution)
                  }
                />
                {!can1080pExport ? (
                  <Text fontSize="11px" color="fg.muted" mt="1">
                    1080p exports and watermark-free renders need a paid plan.{" "}
                    <ChakraLink asChild color="accent.fg" textUnderlineOffset="3px">
                      <Link href="/settings/subscription">Upgrade</Link>
                    </ChakraLink>
                    .
                  </Text>
                ) : null}
              </Box>

              <Flex justify="space-between" align="center" gap="2">
                <Text textStyle="data" fontSize="11px" color="fg.muted">
                  {selectedAspectRatios.length} format
                  {selectedAspectRatios.length === 1 ? "" : "s"} selected
                </Text>
                <Button
                  size="xs"
                  disabled={
                    selectedAspectRatios.length === 0 || isPending || submitting
                  }
                  onClick={handleRender}
                >
                  {isPending || submitting ? (
                    <Spinner size="xs" borderTopColor="accent.contrast" />
                  ) : (
                    <Check size={12} />
                  )}
                  <Text ms="1">Queue render</Text>
                </Button>
              </Flex>

              {error ? (
                <Flex align="center" gap="1.5" color="danger.fg">
                  <AlertTriangle size={12} aria-hidden />
                  <Text fontSize="xs">{error}</Text>
                </Flex>
              ) : null}
            </Stack>
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
      error: result.error ?? "Could not retry ingest. Please try again.",
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
          size="xs"
          variant="outline"
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
