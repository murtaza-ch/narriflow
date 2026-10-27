"use client";

import { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { Box, Flex, Slider, Stack, Text } from "@chakra-ui/react";
import { tileProps, studioSliderCss } from "./panel-ui";
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
      aspectRatio={16 / 10}
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
            w="14px"
            h="14px"
            borderRadius="full"
            borderWidth="0"
            bg={selected ? "studio.accent" : "studio.borderStrong"}
            boxShadow={selected ? "0 0 0 3px var(--chakra-colors-studio-raised)" : undefined}
            cursor="pointer"
            transition="background 120ms ease"
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
      <Stack gap="8px">
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
          Logo
        </Text>
        <Flex
          align="flex-start"
          gap="12px"
          p="14px"
          bg="studio.subtle"
          borderRadius="10px"
        >
          <Box color="studio.fgSubtle" flexShrink={0} mt="1px">
            <ImageOff size={16} />
          </Box>
          <Stack gap="4px">
            <Text fontSize="13px" color="studio.fgMuted">
              This project has no logo yet.
            </Text>
            <NextLink href="/brand-kit" style={{ width: "fit-content" }}>
              <Text fontSize="13px" color="studio.fg" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px" textDecorationColor="studio.borderStrong" _hover={{ textDecorationColor: "studio.fg" }}>
                Add one in Brand kit
              </Text>
            </NextLink>
            <Text fontSize="12px" color="studio.fgSubtle">
              Then apply that brand to this project from its page.
            </Text>
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
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
          Logo
        </Text>
        <Flex
          as="button"
          aria-pressed={logo.enabled}
          aria-label={logo.enabled ? "Hide logo on this clip" : "Show logo on this clip"}
          align="center"
          justify="center"
          h="30px"
          px="14px"
          borderRadius="full"
          bg={logo.enabled ? "studio.accent" : "studio.raised"}
          color={logo.enabled ? "studio.canvas" : "studio.fgMuted"}
          fontSize="12px"
          fontWeight="500"
          cursor="pointer"
          transition="background 120ms ease, color 120ms ease"
          onClick={() => updateLogo({ enabled: !logo.enabled })}
        >
          {logo.enabled ? "On" : "Off"}
        </Flex>
      </Flex>

      <Stack
        gap="14px"
        p="14px"
        bg="studio.subtle"
        borderRadius="10px"
        opacity={logo.enabled ? 1 : 0.5}
        transition="opacity 120ms ease"
      >
        <LogoPositionPicker
          value={effective.position}
          onChange={(position) => updateLogo({ position })}
        />

        <Flex align="center" gap="8px">
          <Text fontSize="12px" color="studio.fgMuted" w="52px" flexShrink={0}>
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
            {effective.opacity}%
          </Text>
        </Flex>

        <Flex align="center" gap="8px">
          <Text fontSize="12px" color="studio.fgMuted" w="52px" flexShrink={0}>
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
      gap="12px"
      w="100%"
      p="12px"
      {...tileProps(selected)}
      textAlign="left"
      onClick={onSelect}
    >
      {/* User brand colors — literal by design */}
      <Flex flexShrink={0} gap="3px">
        <Box w="14px" h="28px" borderRadius="4px 0 0 4px" bg={template.primaryColor} />
        <Box w="14px" h="28px" borderRadius="0 4px 4px 0" bg={template.secondaryColor} />
      </Flex>
      <Box minW="0" flex="1">
        <Text fontSize="13px" fontWeight="500" color="studio.fg" truncate>
          {template.name}
        </Text>
        <Text fontSize="12px" color="studio.fgMuted" mt="2px">
          {template.captionPreset.fontName} · {template.captionPreset.position}
        </Text>
      </Box>
      {selected ? (
        <Box color="studio.fg" flexShrink={0}>
          <Check size={16} />
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
    <Stack gap="20px" px="20px" pt="16px" pb="20px">
      <LogoSection />

      {loadState === "loading" ? (
        <Flex align="center" justify="center" h="120px" color="studio.fgMuted" gap="8px">
          <Spinner size="xs" />
          <Text fontSize="13px" color="studio.fgMuted">Loading templates</Text>
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
              <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
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
              <Text fontSize="13px" fontWeight="500" color="studio.fgMuted">
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
        </>
      ) : null}
    </Stack>
  );
}
