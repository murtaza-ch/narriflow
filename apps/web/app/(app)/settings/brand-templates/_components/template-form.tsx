"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text, chakra } from "@chakra-ui/react";
import { AlertCircle, Upload as UploadIcon } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { Slider } from "@narriflow/ui/components/slider";
import { Switch } from "@narriflow/ui/components/switch";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { ColorSwatchField } from "@narriflow/ui/components/color-swatch-field";
import { PhoneFrame } from "@narriflow/ui/components/phone-frame";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  brandTemplateInputSchema,
  captionPresetSchema,
  type BrandTemplateInput,
  type BrandTemplateSummary,
  type CaptionAnimation,
  type CaptionPreset,
  type LogoPosition,
} from "@narriflow/validators";
import {
  createBrandTemplateAction,
  updateBrandTemplateAction,
} from "../actions";

const POSITION_GRID: LogoPosition[][] = [
  ["top-left", "top-center", "top-right"],
  ["mid-left", "center", "mid-right"],
  ["bot-left", "bot-center", "bot-right"],
];

const ANIMATION_OPTIONS: CaptionAnimation[] = [
  "none",
  "word-by-word",
  "karaoke",
  "bounce",
  "blur-in",
  "grow",
  "breathe",
  "soft-landing",
  "glitch",
  "seamless-bounce",
];

const FONT_OPTIONS = [
  "Bebas Neue",
  "Montserrat",
  "Roboto",
  "Open Sans",
  "Oswald",
  "Impact",
];

// Quick-pick swatches for brand colors — user color VALUES stay literal.
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
}

function defaultCaption(): CaptionPreset {
  return captionPresetSchema.parse({});
}

function defaultInput(): BrandTemplateInput {
  return {
    name: "Untitled template",
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

export function TemplateForm({ mode, initialTemplate }: TemplateFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);

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
      setError(parsed.error.issues[0]?.message ?? "Invalid template");
      return;
    }
    startTransition(async () => {
      try {
        if (mode === "create") {
          const created = await createBrandTemplateAction(parsed.data);
          toaster.create({ type: "success", title: "Template created" });
          router.push(`/brand-kit/${created.id}`);
        } else if (initialTemplate) {
          await updateBrandTemplateAction(initialTemplate.id, parsed.data);
          toaster.create({ type: "success", title: "Template saved" });
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

  const preset = state.captionPreset;

  return (
    <Grid
      templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 320px" }}
      gap={{ base: "8", lg: "12" }}
      alignItems="start"
    >
      {/* LEFT: rule-band sections — structure drawn, not boxed */}
      <Stack gap="8" minW="0">
        <FormSection title="Identity">
          <FieldGroup label="Name">
            <Input
              value={state.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="My brand"
              maxW="360px"
            />
          </FieldGroup>
        </FormSection>

        <FormSection title="Colors">
          <Flex gap="5" wrap="wrap">
            <ColorSwatchField
              label="Primary"
              value={state.primaryColor}
              swatches={BRAND_SWATCHES}
              onChange={(value) => update("primaryColor", value.toUpperCase())}
            />
            <ColorSwatchField
              label="Secondary"
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
          <Text fontSize="12px" color="fg.muted" mt="3">
            Primary fills caption text. Secondary fills caption highlights.
          </Text>
        </FormSection>

        <FormSection title="Logo / watermark">
          <Stack gap="4">
            <Box
              as="label"
              display="block"
              layerStyle="well"
              borderStyle="dashed"
              borderColor="border.control"
              p="5"
              textAlign="center"
              cursor={logoUploading ? "not-allowed" : "pointer"}
              transition="border-color 120ms ease, background 120ms ease"
              _hover={
                logoUploading
                  ? undefined
                  : { borderColor: "border.emphasized", bg: "bg.muted" }
              }
            >
              <chakra.input
                type="file"
                accept="image/png,image/svg+xml,image/jpeg,image/webp"
                disabled={logoUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleLogoUpload(file);
                }}
                srOnly
              />
              <Flex direction="column" align="center" gap="1.5">
                {logoUploading ? <Spinner size="sm" /> : <UploadIcon size={18} />}
                <Text fontSize="12.5px" color={logoUploading ? "fg.disabled" : "fg.muted"}>
                  {logoUploading
                    ? "Uploading…"
                    : state.logoStorageKey
                      ? "Replace logo"
                      : "Upload PNG or SVG"}
                </Text>
                {state.logoStorageKey && (
                  <Text textStyle="data" fontSize="10px" color="fg.subtle">
                    {state.logoStorageKey.split("/").pop()}
                  </Text>
                )}
              </Flex>
            </Box>

            {state.logoStorageKey && (
              <Button
                size="xs"
                variant="ghost"
                colorPalette="danger"
                alignSelf="flex-start"
                onClick={() => {
                  update("logoStorageKey", null);
                  setLogoPreview(null);
                }}
              >
                Remove logo
              </Button>
            )}

            <FieldGroup label="Position">
              <Grid
                role="radiogroup"
                aria-label="Logo position"
                display="inline-grid"
                templateColumns="repeat(3, 32px)"
                gap="1"
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
                      w="8"
                      h="8"
                      borderRadius="l2"
                      borderWidth="1px"
                      borderColor={selected ? "border.accent" : "border.control"}
                      bg={selected ? "bg.accent" : "bg.subtle"}
                      display="inline-flex"
                      alignItems="center"
                      justifyContent="center"
                      cursor="pointer"
                      transition="background 120ms ease, border-color 120ms ease"
                      _hover={{ borderColor: "border.emphasized" }}
                    >
                      <Box
                        boxSize="1.5"
                        borderRadius="full"
                        bg={selected ? "accent.solid" : "border.emphasized"}
                      />
                    </chakra.button>
                  );
                })}
              </Grid>
            </FieldGroup>

            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5" maxW="480px">
              <Slider
                label="Opacity"
                showValueText
                min={10}
                max={100}
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
                value={state.logoScalePct}
                onValueChange={(value) =>
                  update("logoScalePct", Array.isArray(value) ? (value[0] ?? 5) : value)
                }
              />
            </Grid>
          </Stack>
        </FormSection>

        <FormSection title="Captions">
          <Stack gap="5">
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5">
              <Select
                label="Font"
                items={FONT_OPTIONS.map((font) => ({ label: font, value: font }))}
                value={preset.fontName}
                onValueChange={(value) => {
                  if (value) updateCaption("fontName", value);
                }}
              />
              <Select
                label="Animation"
                items={ANIMATION_OPTIONS.map((animation) => ({
                  label: animation,
                  value: animation,
                }))}
                value={preset.animation}
                onValueChange={(value) => {
                  if (value) updateCaption("animation", value as CaptionAnimation);
                }}
              />
            </Grid>

            <FieldGroup label="Position">
              <SegmentedControl
                size="sm"
                aria-label="Caption position"
                items={["top", "center", "bottom"]}
                value={preset.position}
                onValueChange={(value) =>
                  updateCaption("position", value as "top" | "center" | "bottom")
                }
              />
            </FieldGroup>

            <FieldGroup label="Text transform">
              <SegmentedControl
                size="sm"
                aria-label="Text transform"
                items={["none", "uppercase", "lowercase", "capitalize"]}
                value={preset.textTransform ?? "none"}
                onValueChange={(value) =>
                  updateCaption(
                    "textTransform",
                    value as "none" | "uppercase" | "lowercase" | "capitalize",
                  )
                }
              />
            </FieldGroup>

            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5" maxW="480px">
              <Slider
                label="Font size"
                showValueText
                min={16}
                max={80}
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
                max={4}
                value={preset.outlineWidth}
                onValueChange={(value) =>
                  updateCaption(
                    "outlineWidth",
                    Array.isArray(value) ? (value[0] ?? 0) : value,
                  )
                }
              />
            </Grid>

            <Flex gap="6" align="center">
              <Switch
                checked={preset.bold}
                onCheckedChange={(checked) => updateCaption("bold", checked)}
              >
                Bold
              </Switch>
              <Switch
                checked={preset.shadow === 1}
                onCheckedChange={(checked) =>
                  updateCaption("shadow", checked ? 1 : 0)
                }
              >
                Shadow
              </Switch>
            </Flex>
          </Stack>
        </FormSection>

        {error && (
          <Flex align="center" gap="2" color="danger.fg" role="alert">
            <AlertCircle size={15} />
            <Text fontSize="13px" fontWeight="500">
              {error}
            </Text>
          </Flex>
        )}

        <Flex
          gap="2.5"
          justify="flex-end"
          borderTopWidth="1px"
          borderColor="border"
          pt="5"
        >
          <Button loading={pending} onClick={handleSubmit}>
            {mode === "create" ? "Create template" : "Save changes"}
          </Button>
        </Flex>
      </Stack>

      {/* RIGHT: the hero — live phone preview, sticky and centered */}
      <Box
        position={{ base: "static", lg: "sticky" }}
        top={{ lg: "20" }}
        justifySelf="center"
      >
        <TemplatePreview input={state} logoUrl={logoPreviewUrl} />
      </Box>
    </Grid>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
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

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box as="section">
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        {title}
      </Text>
      <Box layerStyle="band">{children}</Box>
    </Box>
  );
}

function TemplatePreview({
  input,
  logoUrl,
}: {
  input: BrandTemplateInput;
  logoUrl: string | null;
}) {
  const { captionPreset, primaryColor, secondaryColor } = input;
  const placement = LOGO_PLACEMENT[input.logoPosition];
  // Scale the burn-in font size down to phone-frame proportions.
  const previewFontSize = Math.max(10, Math.round(captionPreset.fontSize * 0.45));

  return (
    <Stack gap="3" align={{ base: "center", lg: "flex-start" }}>
      <PhoneFrame width={{ base: "240px", lg: "280px" }}>
        {/* Brand-color tint over the frame's graphite — user colors literal */}
        <Box
          position="absolute"
          inset="0"
          style={{
            background: `linear-gradient(135deg, ${primaryColor}33 0%, ${secondaryColor}33 100%)`,
          }}
        />

        {/* Caption cue at its configured position */}
        <Flex
          position="absolute"
          inset="0"
          px="4"
          py="10"
          align={
            captionPreset.position === "top"
              ? "flex-start"
              : captionPreset.position === "center"
                ? "center"
                : "flex-end"
          }
          justify="center"
        >
          <Text
            fontSize={`${previewFontSize}px`}
            fontWeight={captionPreset.bold ? 800 : 500}
            textAlign="center"
            lineHeight="1.15"
            style={{
              // User caption styling — values intentionally literal.
              fontFamily: captionPreset.fontName,
              color: captionPreset.primaryColor,
              letterSpacing: `${captionPreset.letterSpacing ?? 0}em`,
              textTransform: captionPreset.textTransform ?? "none",
              textShadow:
                captionPreset.shadow === 1
                  ? "0 3px 10px rgba(14, 16, 19, 0.65)"
                  : "none",
              WebkitTextStroke:
                captionPreset.outlineWidth > 0
                  ? `${Math.min(1.5, captionPreset.outlineWidth * 0.5)}px ${captionPreset.outlineColor}`
                  : undefined,
            }}
          >
            This is{" "}
            <span style={{ color: captionPreset.highlightColor }}>your</span>{" "}
            brand
          </Text>
        </Flex>

        {/* Logo composited at its chosen position / opacity / scale */}
        {input.logoStorageKey ? (
          <Flex
            position="absolute"
            inset="0"
            p="3"
            align={placement.align}
            justify={placement.justify}
            pointerEvents="none"
          >
            <Box
              w={`${input.logoScalePct}%`}
              opacity={input.logoOpacity / 100}
              flexShrink={0}
            >
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <chakra.img
                  src={logoUrl}
                  alt="Logo preview"
                  w="full"
                  h="auto"
                  objectFit="contain"
                />
              ) : (
                <Flex
                  aspectRatio={1}
                  w="full"
                  align="center"
                  justify="center"
                  borderWidth="1px"
                  borderStyle="dashed"
                  borderColor="studio.borderStrong"
                  borderRadius="l1"
                >
                  <Text textStyle="eyebrow" color="studio.fgMuted" fontSize="8px">
                    Logo
                  </Text>
                </Flex>
              )}
            </Box>
          </Flex>
        ) : null}
      </PhoneFrame>

      <Stack gap="0.5" px="1" maxW="280px" w="full">
        <Text textStyle="eyebrow" color="fg.subtle">
          Live preview
        </Text>
        <Text fontSize="13px" fontWeight="600" color="fg" truncate>
          {input.name}
        </Text>
        <Text textStyle="data" fontSize="11px" color="fg.muted">
          {captionPreset.animation} · {captionPreset.position} · {captionPreset.fontName}
          {input.logoStorageKey ? " · with logo" : ""}
        </Text>
      </Stack>
    </Stack>
  );
}
