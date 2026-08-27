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
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import { clipAspectRatioOptions } from "@narriflow/validators";
import { useStudio, type AspectRatio } from "./studio-shell";
import {
  canSubmitStudioExport,
  studioExportBlockReason,
} from "./studio-export-policy";

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
  } = useStudio();
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
          colorPalette="accent"
          variant={open ? "outline" : "solid"}
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
            layerStyle="panel"
            boxShadow="cardHover"
            w="min(340px, calc(100vw - 24px))"
            p="0"
            overflow="hidden"
          >
            <Box px="4" pt="4" pb="3" borderBottomWidth="1px" borderColor="border">
              <Text textStyle="eyebrow" color="fg.subtle">
                Delivery formats
              </Text>
              <Text fontSize="12px" color="fg.muted" mt="1">
                Export the saved editor version. You can leave while rendering continues.
              </Text>
            </Box>

            <Stack gap="4" p="4">
              <Stack gap="1.5" aria-label="Export aspect ratios">
                {clipAspectRatioOptions.map((option) => {
                  const checked = selection[option.value];
                  return (
                    <Checkbox
                      key={option.value}
                      w="full"
                      alignItems="center"
                      px="2.5"
                      py="2"
                      borderWidth="1px"
                      borderColor={checked ? "border.emphasized" : "border"}
                      bg={checked ? "bg.muted" : "transparent"}
                      borderRadius="l1"
                      checked={checked}
                      inputProps={{
                        "aria-label": `${option.label} ${option.width}×${option.height}`,
                      }}
                      onCheckedChange={(next) =>
                        setSelection((current) => ({
                          ...current,
                          [option.value]: next,
                        }))
                      }
                    >
                      <Flex justify="space-between" align="center" flex="1" gap="3">
                        <Text fontSize="12px" color="fg">
                          {option.label}
                        </Text>
                        <Text textStyle="data" fontSize="10px" color="fg.muted">
                          {option.width}×{option.height}
                        </Text>
                      </Flex>
                    </Checkbox>
                  );
                })}
              </Stack>

              {blockReason ? (
                <Text role="alert" fontSize="11px" color="danger.fg">
                  {blockReason}
                </Text>
              ) : null}

              <Box>
                <Flex align="center" justify="space-between" mb="1.5">
                  <Text textStyle="eyebrow" color="fg.subtle">
                    Resolution
                  </Text>
                  {!clipInfo.can1080pExport ? <LockKeyhole size={12} aria-label="Plan restricted" /> : null}
                </Flex>
                <SegmentedControl
                  size="sm"
                  items={[
                    { label: "720p", value: "720p" },
                    { label: "1080p", value: "1080p", disabled: !clipInfo.can1080pExport },
                  ]}
                  value={resolution}
                  onValueChange={(value) => setResolution(value as "720p" | "1080p")}
                />
                <Text fontSize="11px" color="fg.muted" mt="2">
                  {clipInfo.exportHasWatermark
                    ? "Free-plan exports include a Narriflow watermark. "
                    : "Watermark-free export is included in your plan. "}
                  {!clipInfo.can1080pExport ? (
                    <ChakraLink asChild color="accent.fg" textUnderlineOffset="3px">
                      <Link href="/settings/subscription">View upgrade options</Link>
                    </ChakraLink>
                  ) : null}
                </Text>
              </Box>

              <Flex justify="space-between" align="center" gap="3">
                <Text textStyle="data" fontSize="11px" color="fg.muted">
                  {selected.length} variant{selected.length === 1 ? "" : "s"}
                </Text>
                <Button
                  size="sm"
                  colorPalette="accent"
                  variant="solid"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : <Download size={13} />}
                  {busy ? "Saving first…" : "Export clip"}
                </Button>
              </Flex>
            </Stack>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
