"use client";

import { useState } from "react";
import {
  Box,
  Flex,
  Popover,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Check, ChevronDown, Download } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { PLAN_CATALOG, clipAspectRatioOptions } from "@narriflow/validators";
import { useUpgrade, type UpgradePrompt } from "@/app/(app)/_components/upgrade";
import { useStudio, type AspectRatio } from "./studio-shell";
import { StudioLockGem } from "./studio-lock-gem";
import { resolutionAction } from "./studio-upgrade";
import {
  canSubmitStudioExport,
  studioExportBlockReason,
  studioExportMotionLocked,
} from "./studio-export-policy";
import { SectionLabel, chipProps, tileProps } from "./tool-panels/panel-ui";

function defaultSelection(aspectRatio: AspectRatio): Record<AspectRatio, boolean> {
  return {
    "9:16": aspectRatio === "9:16",
    "1:1": aspectRatio === "1:1",
    "16:9": aspectRatio === "16:9",
    "4:5": aspectRatio === "4:5",
  };
}

/**
 * 720p / 1080p. A locked 1080p stays visible with a gem and never becomes the
 * selection: choosing it opens the upgrade dialog instead.
 */
export function ResolutionChoices({
  can1080pExport,
  prompt,
  resolution,
  onSelect,
  onUpgrade,
}: {
  can1080pExport: boolean;
  prompt: UpgradePrompt | null;
  resolution: "720p" | "1080p";
  onSelect: (value: "720p" | "1080p") => void;
  onUpgrade: (prompt: UpgradePrompt) => void;
}) {
  return (
    <Flex gap="2" role="group" aria-label="Export resolution">
      {(["720p", "1080p"] as const).map((value) => {
        const action = resolutionAction(value, can1080pExport);
        const lockedPrompt = action === "upgrade" ? prompt : null;
        return (
          <Flex
            key={value}
            as="button"
            align="center"
            justify="center"
            gap="1.5"
            aria-pressed={resolution === value}
            aria-haspopup={lockedPrompt ? "dialog" : undefined}
            flex="1"
            cursor="pointer"
            {...chipProps(resolution === value)}
            onClick={() => {
              if (action === "select") onSelect(value);
              else if (prompt) onUpgrade(prompt);
            }}
          >
            {value}
            {lockedPrompt?.tier ? <StudioLockGem tier={lockedPrompt.tier} /> : null}
          </Flex>
        );
      })}
    </Flex>
  );
}

/**
 * A clip whose saved motion the plan no longer includes can't export until the
 * motion is turned off or the plan is upgraded.
 */
export function MotionExportNotice({
  planName,
  onRemove,
  onUpgrade,
}: {
  planName: string | null;
  onRemove: () => void;
  onUpgrade: (() => void) | null;
}) {
  const action = {
    as: "button" as const,
    color: "studio.fg",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
    cursor: "pointer",
  };
  return (
    <Box role="alert" mt="3" fontSize="13px" color="studio.fgMuted" lineHeight="1.5">
      <Text>
        This clip uses motion, which {planName ? `needs ${planName} to export` : "your plan can't export"}.
      </Text>
      <Flex mt="1.5" gap="4">
        <Box {...action} onClick={onRemove}>
          Turn off motion
        </Box>
        {onUpgrade ? (
          <Box {...action} color="upgrade.fg" aria-haspopup="dialog" onClick={onUpgrade}>
            Upgrade
          </Box>
        ) : null}
      </Flex>
    </Box>
  );
}

export function StudioExportMenu() {
  const {
    clipInfo,
    aspectRatio,
    exportState,
    compositionPlanStatus,
    handleExport,
    upgradePrompts,
    editorDocument,
    setActiveTool,
  } = useStudio("clipInfo", "aspectRatio", "exportState", "compositionPlanStatus", "handleExport", "upgradePrompts", "editorDocument", "setActiveTool");
  const { openUpgrade } = useUpgrade();
  const motionLocked = studioExportMotionLocked(editorDocument, clipInfo.canPersistMotion);
  const motionPrompt = upgradePrompts.motion;
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState(() => defaultSelection(aspectRatio));
  const [resolution, setResolution] = useState<"720p" | "1080p">(() =>
    clipInfo.can1080pExport ? "1080p" : "720p",
  );

  const selected = clipAspectRatioOptions
    .filter((option) => selection[option.value])
    .map((option) => option.value);
  const busy = exportState === "exporting";
  const blockReason = studioExportBlockReason(compositionPlanStatus);
  const canSubmit = canSubmitStudioExport({
    compositionPlanStatus,
    exportState,
    selectedVariantCount: selected.length,
    motionLocked,
  });

  async function submit() {
    if (!canSubmit) return;
    // Acknowledge the click immediately; the top-bar trigger changes to
    // “Preparing…” while the durable export record is created.
    setOpen(false);
    await handleExport({ aspectRatios: selected, resolution });
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (details.open && selected.length === 0) {
          setSelection(defaultSelection(aspectRatio));
        }
      }}
      positioning={{ placement: "bottom-end", gutter: 8 }}
    >
      <Popover.Trigger asChild>
        <Button
          size="sm"
          colorPalette="brand"
          variant="solid"
          disabled={exportState === "queued"}
          aria-label="Open export options"
          aria-haspopup="dialog"
        >
          {busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : <Download size={13} />}
          <Text>
            {busy
              ? "Preparing…"
              : exportState === "queued"
                ? "Queued"
                : blockReason || motionLocked
                  ? "Export blocked"
                  : "Export"}
          </Text>
          {exportState === "queued" ? <Check size={13} /> : <ChevronDown size={12} aria-hidden />}
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="min(340px, calc(100vw - 24px))"
            p="5"
            bg="studio.surface"
            color="studio.fg"
            borderWidth="0"
            borderRadius="14px"
            boxShadow="none"
          >
            <SectionLabel>Formats</SectionLabel>
            <Stack gap="2" role="group" aria-label="Export aspect ratios">
              {clipAspectRatioOptions.map((option) => {
                const checked = selection[option.value];
                return (
                  <Flex
                    key={option.value}
                    as="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`${option.label} ${option.width}×${option.height}`}
                    align="center"
                    gap="3"
                    h="44px"
                    px="3"
                    textAlign="left"
                    {...tileProps(checked)}
                    onClick={() =>
                      setSelection((current) => ({
                        ...current,
                        [option.value]: !current[option.value],
                      }))
                    }
                  >
                    <Flex
                      align="center"
                      justify="center"
                      boxSize="18px"
                      flexShrink={0}
                      borderRadius="5px"
                      bg={checked ? "studio.accent" : "transparent"}
                      borderWidth={checked ? "0" : "1.5px"}
                      borderColor="studio.borderControl"
                      color="studio.canvas"
                    >
                      {checked ? <Check size={13} strokeWidth={3} /> : null}
                    </Flex>
                    <Text flex="1" fontSize="14px" color="studio.fg">
                      {option.label}
                    </Text>
                    <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums">
                      {option.width}×{option.height}
                    </Text>
                  </Flex>
                );
              })}
            </Stack>

            {blockReason ? (
              <Text role="alert" mt="3" fontSize="13px" color="studio.danger">
                {blockReason}
              </Text>
            ) : null}
            {motionLocked ? (
              <MotionExportNotice
                planName={motionPrompt?.tier ? PLAN_CATALOG[motionPrompt.tier].name : null}
                onRemove={() => {
                  setOpen(false);
                  setActiveTool("transitions");
                }}
                onUpgrade={
                  motionPrompt?.tier
                    ? () => {
                        setOpen(false);
                        openUpgrade(motionPrompt);
                      }
                    : null
                }
              />
            ) : null}

            <Box mt="5">
              <SectionLabel>Resolution</SectionLabel>
              <ResolutionChoices
                can1080pExport={clipInfo.can1080pExport}
                prompt={upgradePrompts.export1080p}
                resolution={resolution}
                onSelect={setResolution}
                onUpgrade={(prompt) => {
                  setOpen(false);
                  openUpgrade(prompt);
                }}
              />
              <Text fontSize="12px" color="studio.fgSubtle" mt="2.5" lineHeight="1.5">
                {clipInfo.exportHasWatermark
                  ? "Free-plan exports include a Narriflow watermark. "
                  : "Watermark-free export is included in your plan. "}
                {clipInfo.exportHasWatermark && upgradePrompts.watermark ? (
                  <Box
                    as="button"
                    color="studio.fg"
                    textDecoration="underline"
                    textUnderlineOffset="3px"
                    aria-haspopup="dialog"
                    cursor="pointer"
                    onClick={() => {
                      setOpen(false);
                      openUpgrade(upgradePrompts.watermark!);
                    }}
                  >
                    Remove the watermark
                  </Box>
                ) : null}
              </Text>
            </Box>

            <Flex
              as="button"
              mt="5"
              w="full"
              h="44px"
              align="center"
              justify="center"
              gap="2"
              borderRadius="10px"
              bg="studio.fg"
              border="none"
              color="studio.canvas"
              fontSize="14px"
              fontWeight="500"
              cursor={canSubmit ? "pointer" : "not-allowed"}
              opacity={canSubmit ? 1 : 0.45}
              aria-disabled={!canSubmit}
              transition="opacity 120ms ease"
              _hover={canSubmit ? { opacity: 0.9 } : undefined}
              onClick={canSubmit ? () => void submit() : undefined}
            >
              {busy ? <Spinner size="xs" /> : <Download size={15} />}
              {busy
                ? "Saving first…"
                : `Export ${selected.length} ${selected.length === 1 ? "format" : "formats"}`}
            </Flex>
            <Text mt="2.5" fontSize="12px" color="studio.fgSubtle" textAlign="center">
              You can leave while it renders.
            </Text>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
