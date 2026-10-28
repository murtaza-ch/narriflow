"use client";

import { brandFontReference, useBrandFontLibrary } from "./brand-fonts";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text, chakra } from "@chakra-ui/react";
import { AlertCircle, ArrowLeft, Check, ChevronLeft, ChevronRight, ImageIcon, Palette, Upload as UploadIcon, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Select } from "@narriflow/ui/components/select";
import { Slider } from "@narriflow/ui/components/slider";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { ColorSwatchField } from "@narriflow/ui/components/color-swatch-field";
import { PhoneFrame } from "@narriflow/ui/components/phone-frame";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  CAPTION_FONT_NAMES,
  CAPTION_MOTIONS,
  CAPTION_POSITION_Y_DEFAULTS,
  CAPTION_PRESETS,
  type NamedCaptionPreset,
  applyCaptionPresetLook,
  brandTemplateInputSchema,
  captionPresetSchema,
  matchCaptionPreset,
  type BrandTemplateInput,
  type BrandTemplateSummary,
  type CaptionAnimation,
  type CaptionFontName,
  type CaptionPreset,
  type CaptionShadow,
  type LogoPosition,
} from "@narriflow/validators";
import { CaptionPresetPreview, CaptionSamplePreview } from "../../_shared/caption-preset-preview";
import { CAPTION_BACKDROPS, captionBackdropSrc, captionStyleBackdrop, type CaptionBackdrop } from "../../_shared/caption-preset-backdrops";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import { Panel } from "./brand-kit-ui";
import {
  createBrandTemplateAction,
  updateBrandTemplateAction,
} from "../style-actions";
import {
  authenticatedRequestFailureMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

const POSITION_GRID: LogoPosition[][] = [
  ["top-left", "top-center", "top-right"],
  ["mid-left", "center", "mid-right"],
  ["bot-left", "bot-center", "bot-right"],
];

const ANIMATION_OPTIONS = Object.entries(CAPTION_MOTIONS).map(([value, spec]) => ({
  label: spec.label,
  value: value as CaptionAnimation,
}));

const SHADOW_OPTIONS: { label: string; value: CaptionShadow }[] = [
  { label: "None", value: "none" },
  { label: "Soft", value: "soft" },
  { label: "Hard", value: "hard" },
  { label: "3D", value: "extrude" },
];

// Quick-pick swatches for caption colors — user color VALUES stay literal.
const BRAND_SWATCHES = [
  "#ffffff",
  "#000000",
  "#00ff88",
  "#ffd400",
  "#ff3355",
  "#4a5af0",
  "#00c2ff",
  "#ff8a00",
  "#b46bff",
  "#1db954",
  "#e5e5e5",
  "#101318",
];

/** 3x3 logo placement → flex alignment inside the phone frame. */
const LOGO_PLACEMENT: Record<
  LogoPosition,
  { align: "flex-start" | "center" | "flex-end"; justify: "flex-start" | "center" | "flex-end" }
> = {
  "top-left": { align: "flex-start", justify: "flex-start" },
  "top-center": { align: "flex-start", justify: "center" },
  "top-right": { align: "flex-start", justify: "flex-end" },
  "mid-left": { align: "center", justify: "flex-start" },
  center: { align: "center", justify: "center" },
  "mid-right": { align: "center", justify: "flex-end" },
  "bot-left": { align: "flex-end", justify: "flex-start" },
  "bot-center": { align: "flex-end", justify: "center" },
  "bot-right": { align: "flex-end", justify: "flex-end" },
};

interface TemplateFormProps {
  mode: "create" | "edit";
  initialTemplate?: BrandTemplateSummary;
  /** Where Cancel and the back arrow go. */
  cancelHref: string;
}

function defaultCaption(): CaptionPreset {
  return captionPresetSchema.parse({});
}

function defaultInput(): BrandTemplateInput {
  return {
    name: "Untitled style",
    captionPreset: defaultCaption(),
    logoStorageKey: null,
    logoPosition: "bot-right",
    logoOpacity: 80,
    logoScalePct: 15,
    primaryColor: "#FFFFFF",
    secondaryColor: "#00FF88",
    accentColor: null,
  };
}

export function TemplateForm({ mode, initialTemplate, cancelHref }: TemplateFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<CaptionBackdrop | null>(null);

  const [state, setState] = useState<BrandTemplateInput>(() => {
    if (initialTemplate) {
      return {
        name: initialTemplate.name,
        captionPreset: initialTemplate.captionPreset,
        logoStorageKey: initialTemplate.logoStorageKey,
        logoPosition: initialTemplate.logoPosition,
        logoOpacity: initialTemplate.logoOpacity,
        logoScalePct: initialTemplate.logoScalePct,
        primaryColor: initialTemplate.primaryColor,
        secondaryColor: initialTemplate.secondaryColor,
        accentColor: initialTemplate.accentColor,
      };
    }
    return defaultInput();
  });

  // Keep caption colors in sync with brand colors
  // biome-ignore lint/correctness/useExhaustiveDependencies: brand colors intentionally drive the functional state update.
  useEffect(() => {
    setState((prev) => ({
      ...prev,
      captionPreset: {
        ...prev.captionPreset,
        primaryColor: prev.primaryColor,
        highlightColor: prev.secondaryColor,
      },
    }));
  }, [state.primaryColor, state.secondaryColor]);

  // Edit mode: resolve the stored logo into a signed URL so the preview can
  // composite it. A freshly-uploaded blob URL always wins over this fetch.
  useEffect(() => {
    if (mode !== "edit" || !initialTemplate?.logoStorageKey) return;
    let cancelled = false;
    void fetch(`/api/brand-templates/${initialTemplate.id}/logo-url`)
      .then((res) => (res.ok ? (res.json() as Promise<{ url?: string }>) : null))
      .then((body) => {
        if (cancelled || !body?.url) return;
        setLogoPreviewUrl((prev) => prev ?? body.url ?? null);
      })
      .catch(() => {
        // Preview falls back to the ghost placeholder.
      });
    return () => {
      cancelled = true;
    };
  }, [mode, initialTemplate]);

  // Cmd/Ctrl+S saves, as in the Studio.
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        submitRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function update<K extends keyof BrandTemplateInput>(
    key: K,
    value: BrandTemplateInput[K],
  ) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function updateCaption<K extends keyof CaptionPreset>(
    key: K,
    value: CaptionPreset[K],
  ) {
    setState((prev) => ({
      ...prev,
      captionPreset: { ...prev.captionPreset, [key]: value },
    }));
  }

  function setLogoPreview(url: string | null) {
    setLogoPreviewUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return url;
    });
  }

  async function handleLogoUpload(file: File) {
    setLogoUploading(true);
    setError(null);
    try {
      const presignRes = await fetch("/api/brand-templates/logo/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentType: file.type || "image/png",
          sizeBytes: file.size,
        }),
      });
      if (!presignRes.ok) {
        const body = await presignRes.json().catch(() => ({}));
        throw new Error(body.message ?? "Logo presign failed");
      }
      const { key, uploadUrl, contentType } = (await presignRes.json()) as {
        key: string;
        uploadUrl: string;
        contentType: string;
      };
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status})`);
      }
      update("logoStorageKey", key);
      setLogoPreview(URL.createObjectURL(file));
    } catch (uploadError) {
      toaster.create({
        type: "error",
        title: "Logo upload failed",
        description:
          uploadError instanceof Error ? uploadError.message : "Please try again.",
      });
    } finally {
      setLogoUploading(false);
    }
  }

  function handleSubmit() {
    setError(null);
    const parsed = brandTemplateInputSchema.safeParse(state);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid style");
      return;
    }
    startTransition(async () => {
      try {
        if (mode === "create") {
          const created = await createBrandTemplateAction(parsed.data);
          if (isAuthenticatedActionFailure(created)) {
            toaster.create({
              type: "error",
              title: "Save failed",
              description: authenticatedRequestFailureMessage(
                created,
                window.location.pathname,
                "The style could not be created.",
              ),
            });
            return;
          }
          toaster.create({ type: "success", title: "Style created" });
          router.push(`/brand-kit/styles/${created.id}`);
        } else if (initialTemplate) {
          const updated = await updateBrandTemplateAction(initialTemplate.id, parsed.data);
          if (isAuthenticatedActionFailure(updated)) {
            toaster.create({
              type: "error",
              title: "Save failed",
              description: authenticatedRequestFailureMessage(
                updated,
                window.location.pathname,
                "The style could not be saved.",
              ),
            });
            return;
          }
          toaster.create({ type: "success", title: "Style saved" });
          router.refresh();
        }
      } catch (submitError) {
        toaster.create({
          type: "error",
          title: "Save failed",
          description:
            submitError instanceof Error ? submitError.message : "Please try again.",
        });
      }
    });
  }

  submitRef.current = () => {
    if (!pending) handleSubmit();
  };

  /** A catalog look brings its own colors: they become the style's colors so the two never disagree. */
  function applyLook(named: NamedCaptionPreset) {
    setState((prev) => ({
      ...prev,
      primaryColor: named.preset.primaryColor,
      secondaryColor: named.preset.highlightColor,
      captionPreset: applyCaptionPresetLook(prev.captionPreset, named),
    }));
  }

  const preset = state.captionPreset;
  const matched = matchCaptionPreset(preset);

  return (
    <Stack gap="8">
      <Flex align="center" justify="space-between" gap="4" wrap="wrap" animation="fade-up" animationFillMode="backwards">
        <Flex align="center" gap="3" minW="0" flex="1">
          <IconButton asChild size="sm" variant="ghost" aria-label="Back" ms="-2">
            <Link href={cancelHref}><ArrowLeft size={16} /></Link>
          </IconButton>
          <Stack gap="0.5" minW="0" flex="1">
            {/* The style's name is the page title, edited in place. */}
            <chakra.h1 m="0">
              <chakra.input
                aria-label="Style name"
                value={state.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={mode === "create" ? "New style" : "Untitled style"}
                maxLength={80}
                textStyle="title"
                fontSize={{ base: "22px", md: "28px" }}
                w="full"
                maxW="560px"
                h="11"
                px="2"
                ms="-2"
                bg="transparent"
                color="fg"
                borderWidth="1px"
                borderColor="transparent"
                borderRadius="control"
                outline="none"
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ bg: "bg.soft" }}
                _focus={{ bg: "bg.soft", borderColor: "border.focus" }}
                _placeholder={{ color: "fg.subtle" }}
              />
            </chakra.h1>
            <Text fontSize="13px" color="fg.muted">
              {mode === "create" ? "Styles apply when you import a video." : "Changes apply to new projects only."}
            </Text>
          </Stack>
        </Flex>
        <Flex gap="2">
          <Button variant="subtle" asChild>
            <Link href={cancelHref}>Cancel</Link>
          </Button>
          <Button loading={pending} onClick={handleSubmit}>
            {mode === "create" ? "Create style" : "Save changes"}
          </Button>
        </Flex>
      </Flex>

      <Grid
        templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 340px" }}
        gap={{ base: "8", lg: "10" }}
        alignItems="start"
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <Stack gap="5" minW="0">
          <Panel title="Look" action={<Text fontSize="12px" color={matched ? "fg.muted" : "accent.fg"} fontWeight="500">{matched ? matched.name : "Custom"}</Text>}>
            <LookRail value={matched?.id ?? null} onChange={applyLook} />
          </Panel>

          <Panel title="Text">
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5">
              <FontField preset={preset} onChange={(next) => update("captionPreset", next)} />
              <Select
                label="Animation"
                items={ANIMATION_OPTIONS}
                value={preset.animation}
                onValueChange={(value) => {
                  if (value) updateCaption("animation", value as CaptionAnimation);
                }}
              />
            </Grid>
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5">
              <Slider
                label="Font size"
                showValueText
                min={16}
                max={200}
                value={preset.fontSize}
                onValueChange={(value) =>
                  updateCaption(
                    "fontSize",
                    Array.isArray(value) ? (value[0] ?? 16) : value,
                  )
                }
              />
              <Slider
                label="Outline"
                showValueText
                min={0}
                max={16}
                value={preset.outlineWidth}
                onValueChange={(value) =>
                  updateCaption(
                    "outlineWidth",
                    Array.isArray(value) ? (value[0] ?? 0) : value,
                  )
                }
              />
            </Grid>
            <Flex gap="5" wrap="wrap">
              <FieldGroup label="Position">
                <SegmentedControl
                  aria-label="Caption position"
                  items={[{ label: "Top", value: "top" }, { label: "Center", value: "center" }, { label: "Bottom", value: "bottom" }]}
                  value={preset.position}
                  onValueChange={(value) =>
                    updateCaption("position", value as "top" | "center" | "bottom")
                  }
                />
              </FieldGroup>
              <FieldGroup label="Shadow">
                <SegmentedControl
                  aria-label="Caption shadow"
                  items={SHADOW_OPTIONS}
                  value={preset.shadow}
                  onValueChange={(value) => updateCaption("shadow", value as CaptionShadow)}
                />
              </FieldGroup>
              <FieldGroup label="Case">
                <SegmentedControl
                  aria-label="Text transform"
                  items={[{ label: "Aa", value: "none" }, { label: "AA", value: "uppercase" }, { label: "aa", value: "lowercase" }, { label: "Aa Bb", value: "capitalize" }]}
                  value={preset.textTransform ?? "none"}
                  onValueChange={(value) =>
                    updateCaption(
                      "textTransform",
                      value as "none" | "uppercase" | "lowercase" | "capitalize",
                    )
                  }
                />
              </FieldGroup>
            </Flex>
          </Panel>

          <Panel title="Colors">
            <Flex gap="5" wrap="wrap">
              <ColorSwatchField
                label="Text"
                value={state.primaryColor}
                swatches={BRAND_SWATCHES}
                onChange={(value) => update("primaryColor", value.toUpperCase())}
              />
              <ColorSwatchField
                label="Highlight"
                value={state.secondaryColor}
                swatches={BRAND_SWATCHES}
                onChange={(value) => update("secondaryColor", value.toUpperCase())}
              />
              <ColorSwatchField
                label="Accent"
                value={state.accentColor ?? "#000000"}
                swatches={BRAND_SWATCHES}
                onChange={(value) => update("accentColor", value.toUpperCase())}
              />
            </Flex>
          </Panel>

          <Panel title="Logo">
            <Grid templateColumns={{ base: "1fr", md: "minmax(0, 1fr) auto" }} gap="6" alignItems="start">
              <Stack gap="3">
                <Box
                  as="label"
                  display="flex"
                  alignItems="center"
                  gap="4"
                  bg="bg.soft"
                  borderRadius="l2"
                  p="4"
                  cursor={logoUploading ? "not-allowed" : "pointer"}
                  transition="background 120ms ease"
                  _hover={logoUploading ? undefined : { bg: "bg.softHover" }}
                >
                  <chakra.input
                    type="file"
                    accept="image/png,image/svg+xml,image/jpeg,image/webp"
                    disabled={logoUploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void handleLogoUpload(file);
                    }}
                    srOnly
                  />
                  <Flex boxSize="14" flexShrink={0} align="center" justify="center" borderRadius="l2" bg="studio.subtle" overflow="hidden" color="studio.fgMuted">
                    {logoUploading ? <Spinner size="sm" /> : logoPreviewUrl ? <chakra.img src={logoPreviewUrl} alt="Logo" w="80%" h="80%" objectFit="contain" /> : state.logoStorageKey ? <ImageIcon size={18} /> : <UploadIcon size={18} />}
                  </Flex>
                  <Stack gap="0.5" minW="0">
                    <Text fontSize="13px" fontWeight="500">
                      {logoUploading ? "Uploading…" : state.logoStorageKey ? "Replace logo" : "Upload a logo"}
                    </Text>
                    <Text fontSize="12px" color="fg.muted" truncate>
                      {state.logoStorageKey ? state.logoStorageKey.split("/").pop() : "PNG or SVG with a transparent background"}
                    </Text>
                  </Stack>
                </Box>
                {state.logoStorageKey ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    alignSelf="flex-start"
                    onClick={() => {
                      update("logoStorageKey", null);
                      setLogoPreview(null);
                    }}
                  >
                    <X size={13} /> Remove logo
                  </Button>
                ) : null}
                <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5" opacity={state.logoStorageKey ? 1 : 0.5} transition="opacity 150ms ease">
                  <Slider
                    label="Opacity"
                    showValueText
                    min={10}
                    max={100}
                    disabled={!state.logoStorageKey}
                    value={state.logoOpacity}
                    onValueChange={(value) =>
                      update("logoOpacity", Array.isArray(value) ? (value[0] ?? 10) : value)
                    }
                  />
                  <Slider
                    label="Size"
                    showValueText
                    min={5}
                    max={40}
                    disabled={!state.logoStorageKey}
                    value={state.logoScalePct}
                    onValueChange={(value) =>
                      update("logoScalePct", Array.isArray(value) ? (value[0] ?? 5) : value)
                    }
                  />
                </Grid>
              </Stack>
              <FieldGroup label="Placement">
                <Grid
                  role="radiogroup"
                  aria-label="Logo position"
                  templateColumns="repeat(3, 1fr)"
                  gap="1"
                  p="1"
                  w="108px"
                  h="192px"
                  borderRadius="l2"
                  bg="bg.soft"
                >
                  {POSITION_GRID.flat().map((position) => {
                    const selected = state.logoPosition === position;
                    return (
                      <chakra.button
                        key={position}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={position}
                        onClick={() => update("logoPosition", position)}
                        borderRadius="6px"
                        bg={selected ? "accent.subtle" : "transparent"}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        cursor="pointer"
                        transition="background 120ms ease"
                        _hover={{ bg: selected ? "accent.subtle" : "bg.softHover" }}
                      >
                        <Box
                          boxSize={selected ? "2.5" : "1.5"}
                          borderRadius={selected ? "3px" : "full"}
                          bg={selected ? "accent.solid" : "fg.subtle"}
                          transition="all 120ms ease"
                        />
                      </chakra.button>
                    );
                  })}
                </Grid>
              </FieldGroup>
            </Grid>
          </Panel>

          {error && (
            <Flex align="center" gap="2" color="danger.fg" role="alert">
              <AlertCircle size={15} />
              <Text fontSize="13px" fontWeight="500">
                {error}
              </Text>
            </Flex>
          )}
        </Stack>

        {/* The live phone preview, sticky beside the controls */}
        <Box position={{ base: "static", lg: "sticky" }} top={{ lg: "6" }} justifySelf="center" w="full" maxW="340px">
          <TemplatePreview input={state} logoUrl={logoPreviewUrl} backdrop={backdrop} onBackdrop={setBackdrop} />
        </Box>
      </Grid>
    </Stack>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Stack gap="1.5" align="flex-start">
      <Text fontSize="13px" fontWeight="500" color="fg">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** Every catalog look playing its sample; choosing one restyles the caption and its colors. */
function LookRail({ value, onChange }: { value: string | null; onChange: (named: NamedCaptionPreset) => void }) {
  const rail = useRef<HTMLDivElement>(null);
  function scroll(direction: -1 | 1) {
    rail.current?.scrollBy({
      left: direction * 320,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }
  return (
    <Box position="relative">
      <Flex
        ref={rail}
        gap="2.5"
        overflowX="auto"
        pb="1"
        pt="1"
        px="1"
        mx="-1"
        css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" }, scrollSnapType: "x proximity" }}
      >
        {CAPTION_PRESETS.map((named) => {
          const selected = value === named.id;
          return (
            <chakra.button
              key={named.id}
              type="button"
              aria-label={named.name}
              aria-pressed={selected}
              onClick={() => onChange(named)}
              flexShrink={0}
              w="84px"
              textAlign="left"
              cursor="pointer"
              scrollSnapAlign="start"
              className="group"
            >
              <Box
                position="relative"
                borderRadius="10px"
                overflow="hidden"
                outline="2px solid"
                outlineColor={selected ? "accent.solid" : "transparent"}
                outlineOffset="2px"
                transition="outline-color 150ms ease"
              >
                <CaptionPresetPreview
                  namedPreset={named}
                  aspectRatio="9 / 16"
                  captionTopPct={named.preset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[named.preset.position]}
                  boost={1.35}
                  imageSizes="84px"
                />
                {selected ? (
                  <Flex position="absolute" top="1.5" right="1.5" boxSize="4.5" borderRadius="full" bg="accent.solid" color="accent.contrast" align="center" justify="center">
                    <Check size={11} strokeWidth={3} />
                  </Flex>
                ) : null}
              </Box>
              <Text mt="1.5" fontSize="12px" fontWeight="500" color={selected ? "fg" : "fg.muted"} _groupHover={{ color: "fg" }} truncate>
                {named.name}
              </Text>
            </chakra.button>
          );
        })}
      </Flex>
      {([-1, 1] as const).map((direction) => (
        <IconButton
          key={direction}
          size="xs"
          variant="subtle"
          borderRadius="full"
          aria-label={direction === -1 ? "Previous looks" : "Next looks"}
          position="absolute"
          top="calc(50% - 22px)"
          {...(direction === -1 ? { left: "-3" } : { right: "-3" })}
          bg="bg.raised"
          _hover={{ bg: "bg.raised", color: "fg" }}
          display={{ base: "none", md: "inline-flex" }}
          onClick={() => scroll(direction)}
        >
          {direction === -1 ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </IconButton>
      ))}
    </Box>
  );
}

const BUILT_IN = "builtin:";
const BRAND = "brand:";

/** One font picker: the built-in faces and the workspace's uploaded fonts together. */
function FontField({ preset, onChange }: { preset: CaptionPreset; onChange: (next: CaptionPreset) => void }) {
  const { fonts, requirement, upgrade } = useBrandFontLibrary();
  const choices = requirement ? [] : fonts.filter((font) => font.insertable !== false && font.accessUrl && font.face);
  const current = preset.fontAsset ? fonts.find((font) => font.id === preset.fontAsset?.id && font.fingerprint === preset.fontAsset.fingerprint) : undefined;
  const retained = preset.fontAsset && !choices.some((font) => font.id === preset.fontAsset?.id);
  const items = [
    ...CAPTION_FONT_NAMES.map((name) => ({ label: name, value: `${BUILT_IN}${name}` })),
    ...(retained && preset.fontAsset ? [{ label: `${current?.family ?? "Retained font"} · saved in this style`, value: `${BRAND}${preset.fontAsset.id}`, icon: <Palette size={13} /> }] : []),
    ...choices.map((font) => ({ label: `${font.family} · ${font.style}`, value: `${BRAND}${font.id}`, icon: <Palette size={13} /> })),
  ];
  return (
    <Stack gap="1.5">
      <Select
        label="Font"
        items={items}
        value={preset.fontAsset ? `${BRAND}${preset.fontAsset.id}` : `${BUILT_IN}${preset.fontName}`}
        onValueChange={(value) => {
          if (value.startsWith(BUILT_IN)) {
            onChange({ ...preset, fontName: value.slice(BUILT_IN.length) as CaptionFontName, fontAsset: null });
            return;
          }
          const font = choices.find((choice) => `${BRAND}${choice.id}` === value);
          if (font) onChange({ ...preset, fontName: "Montserrat", fontAsset: brandFontReference(font) });
        }}
      />
      {requirement ? (
        <PlanLimitNotice message={requirement} upgrade={upgrade} />
      ) : preset.fontAsset && !current?.accessUrl ? (
        <Text fontSize="12px" color="fg.muted">Font file unavailable. The built-in font is used in preview and export.</Text>
      ) : choices.length === 0 ? (
        <Text fontSize="12px" color="fg.muted">
          <Link href="/brand-kit?tab=fonts"><Text as="span" color="fg" fontWeight="500" textDecoration="underline" textUnderlineOffset="3px">Upload a font</Text></Link> to use your own.
        </Text>
      ) : null}
    </Stack>
  );
}

function TemplatePreview({
  input,
  logoUrl,
  backdrop,
  onBackdrop,
}: {
  input: BrandTemplateInput;
  logoUrl: string | null;
  backdrop: CaptionBackdrop | null;
  onBackdrop: (backdrop: CaptionBackdrop) => void;
}) {
  const { captionPreset } = input;
  const placement = LOGO_PLACEMENT[input.logoPosition];
  const frame = backdrop ?? captionStyleBackdrop(captionPreset, input.name);

  return (
    <Stack gap="4" align="center">
      <PhoneFrame width="100%" maxW="300px">
        <Box position="absolute" inset="0">
          <CaptionSamplePreview
            preset={captionPreset}
            backdropSrc={captionBackdropSrc(frame)}
            aspectRatio="9 / 16"
            captionTopPct={captionPreset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[captionPreset.position]}
            boost={1}
            imageSizes="300px"
          >
            {/* Logo composited at its chosen position / opacity / scale */}
            {input.logoStorageKey ? (
              <Flex position="absolute" inset="0" p="3" pt="7" align={placement.align} justify={placement.justify} pointerEvents="none">
                <Box w={`${input.logoScalePct}%`} opacity={input.logoOpacity / 100} flexShrink={0} transition="width 120ms ease, opacity 120ms ease">
                  {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <chakra.img src={logoUrl} alt="Logo preview" w="full" h="auto" objectFit="contain" />
                  ) : (
                    <Flex aspectRatio={1} w="full" align="center" justify="center" borderRadius="l1" bg="studio.scrim">
                      <Text color="studio.fgMuted" fontSize="8px" fontWeight="500">
                        Logo
                      </Text>
                    </Flex>
                  )}
                </Box>
              </Flex>
            ) : null}
          </CaptionSamplePreview>
        </Box>
      </PhoneFrame>

      <Stack gap="2" align="center">
        <Flex role="radiogroup" aria-label="Preview background" gap="1.5">
          {CAPTION_BACKDROPS.slice(0, 6).map((item) => {
            const selected = item === frame;
            return (
              <chakra.button
                key={item}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`Preview over ${item.replace("-", " ")}`}
                boxSize="7"
                borderRadius="full"
                overflow="hidden"
                cursor="pointer"
                outline="2px solid"
                outlineColor={selected ? "accent.solid" : "transparent"}
                outlineOffset="2px"
                transition="outline-color 120ms ease, transform 120ms ease"
                _hover={{ transform: "scale(1.08)" }}
                onClick={() => onBackdrop(item)}
              >
                <chakra.img src={captionBackdropSrc(item)} alt="" w="full" h="full" objectFit="cover" />
              </chakra.button>
            );
          })}
        </Flex>
        <Text fontSize="12px" color="fg.subtle">
          {CAPTION_MOTIONS[captionPreset.animation].label} · {captionPreset.position} · {captionPreset.fontAsset ? "custom font" : captionPreset.fontName}
          {input.logoStorageKey ? " · with logo" : ""}
        </Text>
      </Stack>
    </Stack>
  );
}
