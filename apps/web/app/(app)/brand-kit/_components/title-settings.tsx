"use client";

/**
 * A brand template's Title section (title-text spec section 7): whether new clips open with their AI
 * title drawn on the video, for how long, where, and in which style. The style controls are the
 * Studio's own (`TextStyleControls`) on the app's surfaces; the live sample is drawn by the real
 * painter on the form's phone preview (`TitlePreviewLayer`).
 */

import { useState, type ReactNode } from "react";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { NumberInput } from "@narriflow/ui/components/number-input";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Switch } from "@narriflow/ui/components/switch";
import type { BrandTitle, StudioTextLayer, TextLayerStyle } from "@narriflow/validators";
import { TextControlsAppTone, TextStyleControls } from "@/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/text-style-controls";
import { TextLayerFramePreview } from "@/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/text-layer-sample";
import { Panel } from "./brand-kit-ui";

/** Display durations offered as one tap (seconds); null is the whole clip. Any 1–600 s can be typed. */
const DURATION_CHOICES = [3, 5, 10] as const;
const DURATION_RANGE = { min: 1, max: 600 } as const;
const CUSTOM_DURATION_START = 15;

/** Top / middle / bottom as the title's vertical centre (percent of the frame height). */
export const TITLE_POSITIONS = { top: 12, middle: 50, bottom: 80 } as const;
type TitlePosition = keyof typeof TITLE_POSITIONS;

const isChoice = (durationSec: number | null) => durationSec === null || (DURATION_CHOICES as readonly number[]).includes(durationSec);
const positionOf = (positionY: number): TitlePosition | null =>
  (Object.keys(TITLE_POSITIONS) as TitlePosition[]).find((key) => TITLE_POSITIONS[key] === positionY) ?? null;

export function TitleSettingsPanel({ value, onChange }: { value: BrandTitle; onChange: (patch: Partial<BrandTitle>) => void }) {
  // "Custom" stays chosen while a typed duration happens to equal a choice; a stored odd value opens on it.
  const [customDuration, setCustomDuration] = useState(() => !isChoice(value.durationSec));
  // A position the form did not set (stored by another client) stays selectable as "Custom".
  const [storedPositionY] = useState(() => (positionOf(value.positionY) ? null : value.positionY));
  const durationKey = customDuration ? "custom" : value.durationSec === null ? "whole" : String(value.durationSec);
  const positionKey = positionOf(value.positionY) ?? "custom";

  return (
    <Panel title="Title">
      <Text fontSize="13px" color="fg.muted" mt="-3">
        The clip&apos;s AI title, drawn over its opening seconds. Separate from captions; editable per clip in the Studio.
      </Text>
      <Switch checked={value.enabled} onCheckedChange={(enabled) => onChange({ enabled })}>
        Add the clip title to new clips
      </Switch>
      {value.enabled ? (
        <>
          <Flex gap="5" wrap="wrap" align="flex-end">
            <FieldGroup label="Show for">
              <SegmentedControl
                aria-label="Title display duration"
                items={[
                  ...DURATION_CHOICES.map((seconds) => ({ label: `${seconds} s`, value: String(seconds) })),
                  { label: "Whole clip", value: "whole" },
                  { label: "Custom", value: "custom" },
                ]}
                value={durationKey}
                onValueChange={(key) => {
                  if (key === "custom") {
                    setCustomDuration(true);
                    if (value.durationSec === null) onChange({ durationSec: CUSTOM_DURATION_START });
                    return;
                  }
                  setCustomDuration(false);
                  onChange({ durationSec: key === "whole" ? null : Number(key) });
                }}
              />
            </FieldGroup>
            {customDuration ? (
              <FieldGroup label="Seconds">
                <NumberInput
                  size="sm"
                  w="112px"
                  min={DURATION_RANGE.min}
                  max={DURATION_RANGE.max}
                  value={value.durationSec === null ? "" : String(value.durationSec)}
                  inputProps={{ "aria-label": "Title display duration in seconds" }}
                  onValueChange={(_, seconds) => {
                    if (Number.isFinite(seconds) && seconds >= DURATION_RANGE.min && seconds <= DURATION_RANGE.max) onChange({ durationSec: seconds });
                  }}
                />
              </FieldGroup>
            ) : null}
            <FieldGroup label="Position">
              <SegmentedControl
                aria-label="Title position"
                items={[
                  { label: "Top", value: "top" },
                  { label: "Middle", value: "middle" },
                  { label: "Bottom", value: "bottom" },
                  ...(storedPositionY !== null ? [{ label: "Custom", value: "custom" }] : []),
                ]}
                value={positionKey}
                onValueChange={(key) => {
                  if (key === "custom") {
                    if (storedPositionY !== null) onChange({ positionY: storedPositionY });
                    return;
                  }
                  onChange({ positionY: TITLE_POSITIONS[key as TitlePosition] });
                }}
              />
            </FieldGroup>
          </Flex>
          <Stack gap="2" maxW="440px">
            <Text fontSize="13px" fontWeight="500" color="fg">
              Title style
            </Text>
            <TextControlsAppTone>
              <TextStyleControls value={value.style} onChange={(patch) => onChange({ style: { ...value.style, ...patch } satisfies TextLayerStyle })} />
            </TextControlsAppTone>
          </Stack>
        </>
      ) : (
        <Text fontSize="13px" color="fg.muted">
          New clips open without a title. Its style, timing and position are kept for when you switch it back on.
        </Text>
      )}
    </Panel>
  );
}

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="1.5" align="flex-start">
      <Text fontSize="13px" fontWeight="500" color="fg">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** The phone preview's canvas: a 9:16 export. */
const PORTRAIT_CANVAS = { width: 1080, height: 1920 } as const;
const SAMPLE_TITLE = "How I grew my channel to a million subscribers";

/** The title layer a new clip would get from these settings, for the preview. */
export function titlePreviewLayer(title: BrandTitle, text = SAMPLE_TITLE): StudioTextLayer {
  return { id: "title", role: "title", text, startSec: 0, endSec: title.durationSec, positionX: title.positionX, positionY: title.positionY, widthPct: title.widthPct, style: title.style };
}

/** The title drawn by the real painter on the form's phone preview (nothing while the title is off). */
export function TitlePreviewLayer({ layer }: { layer: StudioTextLayer | null }) {
  return layer ? <TextLayerFramePreview layer={layer} canvas={PORTRAIT_CANVAS} /> : null;
}
