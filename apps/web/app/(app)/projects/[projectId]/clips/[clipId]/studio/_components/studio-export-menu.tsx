"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Box,
  Flex,
  Link as ChakraLink,
  Popover,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Check, ChevronDown, Download, LockKeyhole } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { clipAspectRatioOptions } from "@narriflow/validators";
import { useStudio, type AspectRatio } from "./studio-shell";
import {
  canSubmitStudioExport,
  studioExportBlockReason,
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

export function StudioExportMenu() {
  const {
    clipInfo,
    aspectRatio,
    exportState,
    compositionPlanStatus,
    handleExport,
  } = useStudio("clipInfo", "aspectRatio", "exportState", "compositionPlanStatus", "handleExport");
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
                : blockReason
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

            <Box mt="5">
              <SectionLabel
                action={
                  !clipInfo.can1080pExport ? (
                    <Box color="studio.fgSubtle">
                      <LockKeyhole size={13} aria-label="Plan restricted" />
                    </Box>
                  ) : null
                }
              >
                Resolution
              </SectionLabel>
              <Flex gap="2" role="group" aria-label="Export resolution">
                {(["720p", "1080p"] as const).map((value) => {
                  const disabled = value === "1080p" && !clipInfo.can1080pExport;
                  return (
                    <Box
                      key={value}
                      as="button"
                      aria-pressed={resolution === value}
                      aria-disabled={disabled}
                      flex="1"
                      cursor={disabled ? "not-allowed" : "pointer"}
                      opacity={disabled ? 0.45 : 1}
                      {...chipProps(resolution === value)}
                      onClick={disabled ? undefined : () => setResolution(value)}
                    >
                      {value}
                    </Box>
                  );
                })}
              </Flex>
              <Text fontSize="12px" color="studio.fgSubtle" mt="2.5" lineHeight="1.5">
                {clipInfo.exportHasWatermark
                  ? "Free-plan exports include a Narriflow watermark. "
                  : "Watermark-free export is included in your plan. "}
                {!clipInfo.can1080pExport ? (
                  <ChakraLink asChild color="studio.fg" textUnderlineOffset="3px">
                    <Link href="/settings/billing">View upgrade options</Link>
                  </ChakraLink>
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
