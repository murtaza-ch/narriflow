"use client";

import { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { Box, Button, Flex, Slider, Stack, Text } from "@chakra-ui/react";
import { PANEL_PX, PanelEmpty, SectionLabel, chipProps, softButtonProps, studioSliderCss, tileProps } from "./panel-ui";
import { AlertTriangle, Check, ImageOff, LayoutGrid } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  resolveEffectiveLogoSettings,
  type BrandTemplateSummary,
  type CaptionPreset,
  type LogoPosition,
  type StudioLogo,
} from "@narriflow/validators";
import { useStudio } from "../studio-shell";
import { CaptionCue } from "../caption-style-engine";
import { brandQueries } from "@narriflow/api-client/brand";
import { requireStudioApi } from "../studio-api";
import { useStudioApi } from "../use-studio-api";

interface BrandTemplateResponse {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  defaultId: string | null;
}

/** 3x3 position grid, laid out to match the enum's own vertical-then-
 *  horizontal ordering (top-left, top-center, top-right, mid-left, …). */
const LOGO_POSITIONS: LogoPosition[] = [
  "top-left", "top-center", "top-right",
  "mid-left", "center", "mid-right",
  "bot-left", "bot-center", "bot-right",
];

/** Mini position picker: a "frame" with a dot at each of the 9
 *  candidate spots, mirroring where the logo will actually sit on the
 *  canvas (the composition FFmpeg adapter's logo placement uses the same
 *  left/center/right x top/mid/bottom split). */
function LogoPositionPicker({
  value,
  onChange,
}: {
  value: LogoPosition;
  onChange: (position: LogoPosition) => void;
}) {
  return (
    <Box
      position="relative"
      w="100%"
      aspectRatio={2}
      bg="studio.canvas"
      borderRadius="10px"
    >
      {LOGO_POSITIONS.map((position) => {
        const [vertical, horizontal] = position.split("-");
        const top = vertical === "top" ? "16%" : vertical === "bot" ? "84%" : "50%";
        const left = horizontal === "left" ? "12%" : horizontal === "right" ? "88%" : "50%";
        const selected = position === value;
        return (
          <Box
            key={position}
            as="button"
            aria-pressed={selected}
            aria-label={`Logo position: ${position.replace("-", " ")}`}
            title={position.replace("-", " ")}
            position="absolute"
            top={top}
            left={left}
            transform="translate(-50%, -50%)"
            boxSize={selected ? "16px" : "12px"}
            borderRadius="full"
            borderWidth="0"
            bg={selected ? "studio.accent" : "studio.borderStrong"}
            cursor="pointer"
            transition="background 120ms ease, width 120ms ease, height 120ms ease"
            _hover={{ bg: selected ? "studio.accent" : "studio.fgSubtle" }}
            onClick={() => onChange(position)}
          />
        );
      })}
    </Box>
  );
}

/** Per-clip logo overrides (studioEdits.logo, vizard-parity.md Phase A step
 *  6). The project brand snapshot stays the source of truth for the logo
 *  ASSET (see studio/page.tsx's `brandLogo` prop) — this section only
 *  overrides how it's shown on THIS clip; null fields inherit the
 *  snapshot, via the same `resolveEffectiveLogoSettings` helper the worker
 *  uses for burn-in and the preview canvas uses to draw the overlay. */
function LogoSection() {
  const { brandLogo, studioEdits, setStudioEdits, endCoalesce } = useStudio("brandLogo", "studioEdits", "setStudioEdits", "endCoalesce");

  const updateLogo = (patch: Partial<StudioLogo>, coalesceKey?: string) =>
    setStudioEdits(
      (prev) => ({ ...prev, logo: { ...prev.logo, ...patch } }),
      coalesceKey,
    );

  if (!brandLogo) {
    return (
      <Box>
        <SectionLabel>Logo</SectionLabel>
        <PanelEmpty
          icon={<ImageOff size={18} />}
          title="No logo yet"
          actions={
            <Button asChild size="xs" {...softButtonProps}>
              <NextLink href="/brand-kit">Open Brand kit</NextLink>
            </Button>
          }
        >
          Add one in Brand kit, then apply that brand to this project from its page.
        </PanelEmpty>
      </Box>
    );
  }

  const logo = studioEdits.logo;
  const effective = resolveEffectiveLogoSettings(brandLogo, logo);

  return (
    <Box>
      <SectionLabel
        action={
          <Flex
            as="button"
            aria-pressed={logo.enabled}
            aria-label={logo.enabled ? "Hide logo on this clip" : "Show logo on this clip"}
            align="center"
            justify="center"
            my="-3px"
            cursor="pointer"
            {...chipProps(logo.enabled)}
            h="26px"
            px="10px"
            fontSize="12px"
            onClick={() => updateLogo({ enabled: !logo.enabled })}
          >
            {logo.enabled ? "On" : "Off"}
          </Flex>
        }
      >
        Logo
      </SectionLabel>

      <Stack
        gap="14px"
        p="14px"
        bg="studio.subtle"
        borderRadius="12px"
        opacity={logo.enabled ? 1 : 0.5}
        transition="opacity 120ms ease"
      >
        <LogoPositionPicker
          value={effective.position}
          onChange={(position) => updateLogo({ position })}
        />

        <LogoSlider
          label="Opacity"
          ariaLabel="Logo opacity"
          value={effective.opacity}
          min={10}
          max={100}
          onChange={(opacity) => updateLogo({ opacity }, "logo-opacity")}
          onCommit={endCoalesce}
        />
        <LogoSlider
          label="Scale"
          ariaLabel="Logo scale"
          value={effective.scalePct}
          min={5}
          max={40}
          onChange={(scalePct) => updateLogo({ scalePct }, "logo-scale")}
          onCommit={endCoalesce}
        />
      </Stack>
    </Box>
  );
}

function LogoSlider({
  label,
  ariaLabel,
  value,
  min,
  max,
  onChange,
  onCommit,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <Flex align="center" gap="10px">
      <Text fontSize="12px" color="studio.fgMuted" w="52px" flexShrink={0}>
        {label}
      </Text>
      <Slider.Root
        aria-label={[ariaLabel]}
        value={[value]}
        min={min}
        max={max}
        onValueChange={(event) => onChange(event.value[0] ?? value)}
        onValueChangeEnd={onCommit}
        size="sm"
        css={studioSliderCss}
        flex="1"
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumbs />
        </Slider.Control>
      </Slider.Root>
      <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" w="38px" textAlign="right">
        {value}%
      </Text>
    </Flex>
  );
}

/** The preset's sample cue, still, in its own face and colors on a small dark frame. */
const THUMB_W = 92;
const SAMPLE_WORDS = ["make", "it", "pop"];

function TemplateThumb({ preset }: { preset: CaptionPreset }) {
  // Show as many sample words as the preset puts on screen, the last one active.
  const shown = SAMPLE_WORDS.slice(-Math.min(preset.wordsPerCue, SAMPLE_WORDS.length));
  const words = shown.map((word, index) => ({ word, isActive: index === shown.length - 1 }));
  return (
    <Flex
      w={`${THUMB_W}px`}
      h="54px"
      flexShrink={0}
      align="center"
      justify="center"
      overflow="hidden"
      borderRadius="8px"
      bg="studio.canvas"
      aria-hidden
    >
      <CaptionCue preset={preset} words={words} scale={(THUMB_W * 1.7) / 1080} frameWidth={THUMB_W} cueKey="thumb" reducedMotion />
    </Flex>
  );
}

function TemplateRow({
  template,
  selected,
  onSelect,
}: {
  template: BrandTemplateSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Flex
      as="button"
      aria-pressed={selected}
      align="center"
      gap="12px"
      w="100%"
      p="6px"
      pe="12px"
      {...tileProps(selected)}
      textAlign="left"
      onClick={onSelect}
    >
      <TemplateThumb preset={template.captionPreset} />
      <Box minW="0" flex="1">
        <Text fontSize="13px" fontWeight="500" color={selected ? "studio.accentFg" : "studio.fg"} truncate>
          {template.name}
        </Text>
        <Flex align="center" gap="1.5" mt="1px" minW="0">
          {/* The template's own brand colours, as two dots. */}
          <Flex flexShrink={0} gap="2px" aria-hidden>
            {[template.primaryColor, template.secondaryColor].map((color, index) => (
              <Box key={`${index}-${color}`} boxSize="9px" borderRadius="full" bg={color} />
            ))}
          </Flex>
          <Text fontSize="12px" color={selected ? "studio.accentFg" : "studio.fgSubtle"} opacity={selected ? 0.75 : 1} truncate>
            {template.captionPreset.fontName} · {template.captionPreset.position}
          </Text>
        </Flex>
      </Box>
      {selected ? (
        <Flex boxSize="18px" flexShrink={0} align="center" justify="center" borderRadius="full" bg="studio.accent" color="white" aria-hidden>
          <Check size={11} strokeWidth={3} />
        </Flex>
      ) : null}
    </Flex>
  );
}

export function BrandTemplatePanel() {
  const { setCaptionPreset } = useStudio("setCaptionPreset");
  const [templates, setTemplates] = useState<BrandTemplateResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [applyState, setApplyState] = useState<
    "idle" | "applied" | "missing"
  >("idle");

  const studioApi = useStudioApi();

  useEffect(() => {
    let canceled = false;
    async function loadTemplates() {
      setLoadState("loading");
      try {
        const api = requireStudioApi(studioApi);
        const payload = (await api.runtime.queryClient.fetchQuery(
          brandQueries({ transport: api.runtime.transport, scope: api.scope }).templates(),
        )) as unknown as BrandTemplateResponse;
        if (canceled) return;
        setTemplates(payload);
        setSelectedId(payload.defaultId ?? payload.mine[0]?.id ?? payload.builtIns[0]?.id ?? null);
        setLoadState("ready");
      } catch {
        if (!canceled) setLoadState("error");
      }
    }
    void loadTemplates();
    return () => {
      canceled = true;
    };
  }, [studioApi]);

  const allTemplates = useMemo(
    () => [...(templates?.mine ?? []), ...(templates?.builtIns ?? [])],
    [templates],
  );
  const selectedTemplate = allTemplates.find((template) => template.id === selectedId);

  function applyTemplate() {
    if (!selectedTemplate) {
      setApplyState("missing");
      setTimeout(() => setApplyState("idle"), 2500);
      return;
    }

    setCaptionPreset((current) => ({
      ...current,
      ...selectedTemplate.captionPreset,
      positionX: current.positionX,
      positionY: current.positionY,
      fontSize: current.fontSize,
    }));
    setApplyState("applied");
    setTimeout(() => setApplyState("idle"), 2000);
  }

  const templateGroups = [
    { title: "My templates", items: templates?.mine ?? [] },
    { title: "Built-in", items: templates?.builtIns ?? [] },
  ];

  return (
    <Box>
      <Stack gap="6" px={PANEL_PX} pt="4" pb="4">
        <LogoSection />

        {loadState === "loading" ? (
          <Flex align="center" justify="center" h="120px" color="studio.fgMuted" gap="8px">
            <Spinner size="xs" />
            <Text fontSize="13px" color="studio.fgMuted">Loading templates</Text>
          </Flex>
        ) : null}

        {loadState === "error" ? (
          <Flex role="alert" align="center" gap="8px" p="12px" color="studio.danger">
            <AlertTriangle size={14} />
            <Text fontSize="12px" color="studio.danger">
              Brand templates could not be loaded.
            </Text>
          </Flex>
        ) : null}

        {loadState === "ready"
          ? templateGroups.map((group) =>
              group.items.length ? (
                <Box key={group.title}>
                  <SectionLabel>{group.title}</SectionLabel>
                  <Stack gap="6px">
                    {group.items.map((template) => (
                      <TemplateRow
                        key={template.id}
                        template={template}
                        selected={template.id === selectedId}
                        onSelect={() => setSelectedId(template.id)}
                      />
                    ))}
                  </Stack>
                </Box>
              ) : null,
            )
          : null}
      </Stack>

      {/* Secondary action — Export owns the view's solid button. Pinned, so it
          stays reachable at the end of the long built-in list. */}
      {loadState === "ready" ? (
        <Box position="sticky" bottom="0" zIndex="2" px={PANEL_PX} pt="3" pb="5" bg="studio.canvas">
          <Flex
            as="button"
            w="100%"
            align="center"
            justify="center"
            h="44px"
            borderRadius="10px"
            bg="studio.raised"
            border="none"
            color={applyState === "missing" ? "studio.danger" : "studio.fg"}
            fontSize="14px"
            fontWeight="500"
            cursor="pointer"
            gap="8px"
            _hover={{ bg: "studio.borderStrong" }}
            transition="background 120ms ease, color 120ms ease"
            onClick={applyTemplate}
          >
            {applyState === "applied" ? (
              <Check size={14} />
            ) : applyState === "missing" ? (
              <AlertTriangle size={14} />
            ) : (
              <LayoutGrid size={14} />
            )}
            {applyState === "applied"
              ? "Template applied"
              : applyState === "missing"
                ? "Choose a template"
                : "Apply to captions"}
          </Flex>
        </Box>
      ) : null}
    </Box>
  );
}
