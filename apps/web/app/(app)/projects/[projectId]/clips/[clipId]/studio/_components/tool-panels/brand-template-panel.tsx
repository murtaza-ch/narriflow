"use client";

import { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { Box, Flex, Slider, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Check, ImageOff, LayoutGrid } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  resolveEffectiveLogoSettings,
  type BrandTemplateSummary,
  type LogoPosition,
  type StudioLogo,
} from "@narriflow/validators";
import { useStudio } from "../studio-shell";

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

/** Mini position picker: a bordered "frame" with a dot at each of the 9
 *  candidate spots, mirroring where the logo will actually sit on the
 *  canvas (buildLogoOverlayPosition in render-clips.ts uses the same
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
      aspectRatio={16 / 10}
      bg="studio.canvas"
      borderRadius="l2"
      borderWidth="1px"
      borderColor="studio.border"
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
            w="14px"
            h="14px"
            borderRadius="full"
            borderWidth="1.5px"
            borderColor={selected ? "studio.accent" : "studio.borderStrong"}
            bg={selected ? "studio.accent" : "studio.raised"}
            cursor="pointer"
            transition="background 120ms ease, border-color 120ms ease"
            _hover={{ borderColor: "studio.accent" }}
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
      <Stack gap="8px">
        <Text textStyle="eyebrow" color="studio.fgMuted">
          Logo
        </Text>
        <Flex
          align="flex-start"
          gap="8px"
          p="12px"
          bg="studio.subtle"
          borderRadius="l2"
          borderWidth="1px"
          borderColor="studio.border"
        >
          <Box color="studio.fgSubtle" flexShrink={0} mt="1px">
            <ImageOff size={14} />
          </Box>
          <Stack gap="4px">
            <Text fontSize="12px" color="studio.fgMuted">
              This project has no logo yet.
            </Text>
            <NextLink href="/brand-kit" style={{ width: "fit-content" }}>
              <Text fontSize="11px" color="studio.accentFg" fontWeight="600" _hover={{ textDecoration: "underline" }}>
                Add one in Brand kit
              </Text>
            </NextLink>
          </Stack>
        </Flex>
      </Stack>
    );
  }

  const logo = studioEdits.logo;
  const effective = resolveEffectiveLogoSettings(brandLogo, logo);

  return (
    <Stack gap="8px">
      <Flex align="center" justify="space-between">
        <Text textStyle="eyebrow" color="studio.fgMuted">
          Logo
        </Text>
        <Flex
          as="button"
          aria-pressed={logo.enabled}
          aria-label={logo.enabled ? "Hide logo on this clip" : "Show logo on this clip"}
          align="center"
          justify="center"
          h="22px"
          px="9px"
          borderRadius="l2"
          borderWidth="1px"
          borderColor={logo.enabled ? "studio.accent" : "studio.borderControl"}
          bg={logo.enabled ? "studio.raised" : "studio.subtle"}
          color={logo.enabled ? "studio.accentFg" : "studio.fgMuted"}
          fontSize="10.5px"
          fontWeight="600"
          cursor="pointer"
          transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
          _hover={{ borderColor: logo.enabled ? "studio.accent" : "studio.fgSubtle" }}
          onClick={() => updateLogo({ enabled: !logo.enabled })}
        >
          {logo.enabled ? "On" : "Off"}
        </Flex>
      </Flex>

      <Stack
        gap="12px"
        p="12px"
        bg="studio.subtle"
        borderRadius="l2"
        borderWidth="1px"
        borderColor="studio.border"
        opacity={logo.enabled ? 1 : 0.5}
        transition="opacity 120ms ease"
      >
        <LogoPositionPicker
          value={effective.position}
          onChange={(position) => updateLogo({ position })}
        />

        <Flex align="center" gap="8px">
          <Text fontSize="11px" color="studio.fgMuted" w="46px" flexShrink={0}>
            Opacity
          </Text>
          <Slider.Root
            aria-label={["Logo opacity"]}
            value={[effective.opacity]}
            min={10}
            max={100}
            onValueChange={(event) =>
              updateLogo({ opacity: event.value[0] ?? effective.opacity }, "logo-opacity")
            }
            onValueChangeEnd={endCoalesce}
            size="sm"
            colorPalette="accent"
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="34px" textAlign="right">
            {effective.opacity}%
          </Text>
        </Flex>

        <Flex align="center" gap="8px">
          <Text fontSize="11px" color="studio.fgMuted" w="46px" flexShrink={0}>
            Scale
          </Text>
          <Slider.Root
            aria-label={["Logo scale"]}
            value={[effective.scalePct]}
            min={5}
            max={40}
            onValueChange={(event) =>
              updateLogo({ scalePct: event.value[0] ?? effective.scalePct }, "logo-scale")
            }
            onValueChangeEnd={endCoalesce}
            size="sm"
            colorPalette="accent"
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="34px" textAlign="right">
            {effective.scalePct}%
          </Text>
        </Flex>
      </Stack>
    </Stack>
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
      gap="10px"
      w="100%"
      p="10px"
      borderRadius="l2"
      border="1px solid"
      borderColor={selected ? "studio.accent" : "studio.border"}
      bg={selected ? "studio.raised" : "studio.subtle"}
      cursor="pointer"
      textAlign="left"
      transition="background 120ms ease, border-color 120ms ease"
      _hover={{ borderColor: selected ? "studio.accent" : "studio.borderStrong" }}
      onClick={onSelect}
    >
      {/* User brand colors — literal by design */}
      <Flex flexShrink={0} gap="3px">
        <Box w="14px" h="28px" borderRadius="4px 0 0 4px" bg={template.primaryColor} />
        <Box w="14px" h="28px" borderRadius="0 4px 4px 0" bg={template.secondaryColor} />
      </Flex>
      <Box minW="0" flex="1">
        <Text fontSize="12px" fontWeight="600" color="studio.fg" truncate>
          {template.name}
        </Text>
        <Text fontSize="11px" color="studio.fgMuted" mt="1px">
          {template.captionPreset.fontName} · {template.captionPreset.position}
        </Text>
      </Box>
      {selected ? (
        <Box color="studio.accentFg" flexShrink={0}>
          <Check size={14} />
        </Box>
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

  useEffect(() => {
    let canceled = false;
    async function loadTemplates() {
      setLoadState("loading");
      try {
        const response = await fetch("/api/brand-templates");
        if (!response.ok) throw new Error("failed");
        const payload = (await response.json()) as BrandTemplateResponse;
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
  }, []);

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

  return (
    <Stack gap="14px" p="12px">
      <LogoSection />

      {loadState === "loading" ? (
        <Flex align="center" justify="center" h="120px" color="studio.fgMuted" gap="8px">
          <Spinner size="xs" />
          <Text fontSize="12px" color="studio.fgMuted">Loading templates</Text>
        </Flex>
      ) : null}

      {loadState === "error" ? (
        <Flex role="alert" align="center" gap="8px" p="12px" color="danger.400">
          <AlertTriangle size={14} />
          <Text fontSize="12px" color="danger.400">
            Brand templates could not be loaded.
          </Text>
        </Flex>
      ) : null}

      {loadState === "ready" ? (
        <>
          {templates?.mine.length ? (
            <Stack gap="8px">
              <Text textStyle="eyebrow" color="studio.fgMuted">
                My templates
              </Text>
              {templates.mine.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  selected={template.id === selectedId}
                  onSelect={() => setSelectedId(template.id)}
                />
              ))}
            </Stack>
          ) : null}

          {templates?.builtIns.length ? (
            <Stack gap="8px">
              <Text textStyle="eyebrow" color="studio.fgMuted">
                Built-in
              </Text>
              {templates.builtIns.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  selected={template.id === selectedId}
                  onSelect={() => setSelectedId(template.id)}
                />
              ))}
            </Stack>
          ) : null}

          {/* Secondary action — Export owns the view's solid button */}
          <Flex
            as="button"
            align="center"
            justify="center"
            h="34px"
            borderRadius="l2"
            bg="studio.raised"
            borderWidth="1px"
            borderColor={applyState === "missing" ? "danger.solid" : "studio.borderStrong"}
            color={applyState === "missing" ? "danger.400" : "studio.fg"}
            fontSize="12px"
            fontWeight="600"
            cursor="pointer"
            gap="6px"
            _hover={{ borderColor: applyState === "missing" ? "danger.solid" : "studio.fgSubtle" }}
            transition="border-color 120ms ease, color 120ms ease"
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
        </>
      ) : null}
    </Stack>
  );
}
