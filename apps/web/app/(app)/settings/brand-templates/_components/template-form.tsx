"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Upload as UploadIcon } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
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

const POSITION_OPTIONS: ("top" | "center" | "bottom")[] = ["top", "center", "bottom"];

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
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
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
          router.push(`/settings/brand-templates/${created.id}`);
        } else if (initialTemplate) {
          await updateBrandTemplateAction(initialTemplate.id, parsed.data);
          router.refresh();
        }
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "Save failed");
      }
    });
  }

  return (
    <Grid templateColumns={{ base: "1fr", lg: "1.4fr 1fr" }} gap="24px">
      {/* LEFT: form */}
      <Stack
        gap="24px"
        p="20px"
        borderRadius="14px"
        borderWidth="1px"
        borderColor="border"
        bg="bg"
      >
        <FieldGroup label="Name">
          <Input
            value={state.name}
            onChange={(event) => update("name", event.target.value)}
            placeholder="My brand"
          />
        </FieldGroup>

        <Section title="Brand colors">
          <Flex gap="14px" wrap="wrap">
            <ColorField
              label="Primary"
              value={state.primaryColor}
              onChange={(value) => update("primaryColor", value)}
            />
            <ColorField
              label="Secondary"
              value={state.secondaryColor}
              onChange={(value) => update("secondaryColor", value)}
            />
            <ColorField
              label="Accent"
              value={state.accentColor ?? "#000000"}
              onChange={(value) => update("accentColor", value)}
            />
          </Flex>
          <Text fontSize="11px" color="fg.subtle" mt="8px">
            Primary fills caption text. Secondary fills caption highlights.
          </Text>
        </Section>

        <Section title="Captions">
          <Stack gap="14px">
            <FieldGroup label="Font">
              <select
                value={state.captionPreset.fontName}
                onChange={(event) =>
                  updateCaption("fontName", event.target.value)
                }
                style={selectStyle}
              >
                {FONT_OPTIONS.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </FieldGroup>

            <Grid templateColumns="1fr 1fr" gap="14px">
              <FieldGroup label="Animation">
                <select
                  value={state.captionPreset.animation}
                  onChange={(event) =>
                    updateCaption("animation", event.target.value as CaptionAnimation)
                  }
                  style={selectStyle}
                >
                  {ANIMATION_OPTIONS.map((animation) => (
                    <option key={animation} value={animation}>
                      {animation}
                    </option>
                  ))}
                </select>
              </FieldGroup>
              <FieldGroup label="Position">
                <select
                  value={state.captionPreset.position}
                  onChange={(event) =>
                    updateCaption(
                      "position",
                      event.target.value as "top" | "center" | "bottom",
                    )
                  }
                  style={selectStyle}
                >
                  {POSITION_OPTIONS.map((position) => (
                    <option key={position} value={position}>
                      {position}
                    </option>
                  ))}
                </select>
              </FieldGroup>
            </Grid>

            <Grid templateColumns="1fr 1fr" gap="14px">
              <FieldGroup label={`Font size · ${state.captionPreset.fontSize}px`}>
                <input
                  type="range"
                  min={16}
                  max={80}
                  value={state.captionPreset.fontSize}
                  onChange={(event) =>
                    updateCaption("fontSize", Number(event.target.value))
                  }
                  style={{ width: "100%" }}
                />
              </FieldGroup>
              <FieldGroup
                label={`Outline · ${state.captionPreset.outlineWidth}`}
              >
                <input
                  type="range"
                  min={0}
                  max={4}
                  value={state.captionPreset.outlineWidth}
                  onChange={(event) =>
                    updateCaption("outlineWidth", Number(event.target.value))
                  }
                  style={{ width: "100%" }}
                />
              </FieldGroup>
            </Grid>

            <FieldGroup label="Text transform">
              <select
                value={state.captionPreset.textTransform ?? "none"}
                onChange={(event) =>
                  updateCaption(
                    "textTransform",
                    event.target.value as
                      | "none"
                      | "uppercase"
                      | "lowercase"
                      | "capitalize",
                  )
                }
                style={selectStyle}
              >
                <option value="none">none</option>
                <option value="uppercase">uppercase</option>
                <option value="lowercase">lowercase</option>
                <option value="capitalize">capitalize</option>
              </select>
            </FieldGroup>

            <Flex gap="14px" align="center">
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={state.captionPreset.bold}
                  onChange={(event) =>
                    updateCaption("bold", event.target.checked)
                  }
                />
                <Text fontSize="12px">Bold</Text>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={state.captionPreset.shadow === 1}
                  onChange={(event) =>
                    updateCaption("shadow", event.target.checked ? 1 : 0)
                  }
                />
                <Text fontSize="12px">Shadow</Text>
              </label>
            </Flex>
          </Stack>
        </Section>

        <Section title="Logo / watermark">
          <Stack gap="14px">
            <Box
              as="label"
              display="block"
              borderRadius="10px"
              borderWidth="2px"
              borderStyle="dashed"
              borderColor="border"
              bg="bg.subtle"
              p="20px"
              textAlign="center"
              cursor={logoUploading ? "not-allowed" : "pointer"}
              opacity={logoUploading ? 0.6 : 1}
            >
              <input
                type="file"
                accept="image/png,image/svg+xml,image/jpeg,image/webp"
                disabled={logoUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleLogoUpload(file);
                }}
                style={{ display: "none" }}
              />
              <Flex direction="column" align="center" gap="6px">
                <UploadIcon size={18} />
                <Text fontSize="12px" color="fg.muted">
                  {state.logoStorageKey
                    ? "Replace logo"
                    : logoUploading
                      ? "Uploading..."
                      : "Upload PNG or SVG"}
                </Text>
                {state.logoStorageKey && (
                  <Text fontSize="10px" color="fg.subtle">
                    {state.logoStorageKey.split("/").pop()}
                  </Text>
                )}
              </Flex>
            </Box>

            {state.logoStorageKey && (
              <button
                type="button"
                onClick={() => update("logoStorageKey", null)}
                style={{
                  alignSelf: "flex-start",
                  fontSize: 11,
                  color: "#ef4444",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Remove logo
              </button>
            )}

            <FieldGroup label="Position">
              <Box display="inline-grid" style={{ gridTemplateColumns: "repeat(3, 32px)", gap: 4 }}>
                {POSITION_GRID.flat().map((position) => {
                  const selected = state.logoPosition === position;
                  return (
                    <button
                      key={position}
                      type="button"
                      onClick={() => update("logoPosition", position)}
                      aria-label={position}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 5,
                        background: selected
                          ? "var(--chakra-colors-bg-accent)"
                          : "var(--chakra-colors-bg-subtle)",
                        border: selected
                          ? "1px solid var(--chakra-colors-border-accent)"
                          : "1px solid var(--chakra-colors-border)",
                        cursor: "pointer",
                      }}
                    />
                  );
                })}
              </Box>
            </FieldGroup>

            <Grid templateColumns="1fr 1fr" gap="14px">
              <FieldGroup label={`Opacity · ${state.logoOpacity}%`}>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={state.logoOpacity}
                  onChange={(event) =>
                    update("logoOpacity", Number(event.target.value))
                  }
                  style={{ width: "100%" }}
                />
              </FieldGroup>
              <FieldGroup label={`Size · ${state.logoScalePct}%`}>
                <input
                  type="range"
                  min={5}
                  max={40}
                  value={state.logoScalePct}
                  onChange={(event) =>
                    update("logoScalePct", Number(event.target.value))
                  }
                  style={{ width: "100%" }}
                />
              </FieldGroup>
            </Grid>
          </Stack>
        </Section>

        {error && (
          <Text fontSize="12px" color="#ef4444">
            {error}
          </Text>
        )}

        <Flex gap="10px" justify="flex-end">
          <Button
            disabled={pending}
            onClick={handleSubmit}
          >
            {pending ? "Saving..." : mode === "create" ? "Create template" : "Save changes"}
          </Button>
        </Flex>
      </Stack>

      {/* RIGHT: live preview */}
      <Box
        position={{ base: "static", lg: "sticky" }}
        top={{ lg: "24px" }}
        alignSelf="start"
      >
        <PreviewCard input={state} />
      </Box>
    </Grid>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--chakra-colors-border)",
  background: "var(--chakra-colors-bg)",
  color: "var(--chakra-colors-fg)",
  fontSize: 13,
};

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="6px">
      <Text fontSize="11px" color="fg.muted">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text
        fontSize="11px"
        fontWeight="600"
        textTransform="uppercase"
        letterSpacing="0.07em"
        color="fg.muted"
        mb="12px"
      >
        {title}
      </Text>
      {children}
    </Box>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Stack gap="4px">
      <Text fontSize="10px" color="fg.subtle">
        {label}
      </Text>
      <Flex align="center" gap="6px">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          style={{
            width: 32,
            height: 32,
            border: "1px solid var(--chakra-colors-border)",
            borderRadius: 6,
            background: "transparent",
            padding: 0,
            cursor: "pointer",
          }}
        />
        <Text fontSize="11px" color="fg.muted" fontFamily="mono">
          {value.toUpperCase()}
        </Text>
      </Flex>
    </Stack>
  );
}

function PreviewCard({ input }: { input: BrandTemplateInput }) {
  const { captionPreset, primaryColor, secondaryColor } = input;
  return (
    <Box
      borderRadius="14px"
      borderWidth="1px"
      borderColor="border"
      overflow="hidden"
      bg="bg"
    >
      <Box
        position="relative"
        h="320px"
        style={{
          background: `linear-gradient(135deg, ${primaryColor}33 0%, ${secondaryColor}33 100%), #0a0a0a`,
        }}
      >
        <Flex
          position="absolute"
          inset="0"
          align="center"
          justify="center"
          px="24px"
        >
          <Text
            fontSize={`${captionPreset.fontSize}px`}
            fontWeight={captionPreset.bold ? 800 : 500}
            color={captionPreset.primaryColor}
            textAlign="center"
            lineHeight="1.1"
            style={{
              fontFamily: captionPreset.fontName,
              textShadow:
                captionPreset.shadow === 1
                  ? "0 4px 14px rgba(0,0,0,0.65)"
                  : "none",
              WebkitTextStroke:
                captionPreset.outlineWidth > 0
                  ? `${captionPreset.outlineWidth}px ${captionPreset.outlineColor}`
                  : "none",
              letterSpacing: `${captionPreset.letterSpacing ?? 0}em`,
              textTransform:
                captionPreset.textTransform === "uppercase"
                  ? "uppercase"
                  : captionPreset.textTransform === "lowercase"
                    ? "lowercase"
                    : captionPreset.textTransform === "capitalize"
                      ? "capitalize"
                      : "none",
            }}
          >
            This is{" "}
            <span style={{ color: captionPreset.highlightColor }}>your</span>{" "}
            brand
          </Text>
        </Flex>
      </Box>
      <Stack p="14px" gap="6px">
        <Text fontSize="13px" fontWeight="600">
          {input.name}
        </Text>
        <Text fontSize="11px" color="fg.muted">
          {captionPreset.animation} · {captionPreset.position} · {captionPreset.fontName}
          {input.logoStorageKey ? " · with logo" : ""}
        </Text>
      </Stack>
    </Box>
  );
}
