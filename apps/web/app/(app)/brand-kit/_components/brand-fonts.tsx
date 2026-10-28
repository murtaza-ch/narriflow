"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Box, NativeSelect, Stack, Text } from "@chakra-ui/react";
import type { CaptionFontFace, CaptionPreset } from "@narriflow/validators";
import { PlanLimitNotice } from "../../_components/plan-limit-notice";
import type { UpgradePrompt } from "../../_components/upgrade";

export type FontReference = NonNullable<CaptionPreset["fontAsset"]>;
export interface BrandFontChoice {
  id: string;
  family: string;
  style: string;
  weight: number;
  fingerprint: string;
  accessUrl: string | null;
  face: CaptionFontFace | null;
  insertable?: boolean;
}

export function brandFontFamily(
  font: Pick<BrandFontChoice, "id" | "fingerprint">,
) {
  return `NarriflowFont_${font.id.replaceAll("-", "_")}_${font.fingerprint}`;
}
export function brandFontReference(font: BrandFontChoice): FontReference {
  return { kind: "brand_font", id: font.id, fingerprint: font.fingerprint };
}

const FontContext = createContext<{
  fonts: readonly BrandFontChoice[];
  loaded: ReadonlySet<string>;
  requirement: string | null;
  upgrade: UpgradePrompt | null;
}>({ fonts: [], loaded: new Set(), requirement: null, upgrade: null });

export function BrandFontsProvider({
  fonts,
  requirement = null,
  upgrade = null,
  children,
}: {
  fonts: readonly BrandFontChoice[];
  requirement?: string | null;
  upgrade?: UpgradePrompt | null;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const faces: FontFace[] = [];
    setLoaded(new Set());
    for (const font of fonts) {
      if (!font.accessUrl || !font.face) continue;
      const metrics = font.face;
      const family = brandFontFamily(font);
      const face = new FontFace(
        family,
        `url(${JSON.stringify(font.accessUrl)})`,
        {
          weight: String(metrics.weight),
          style: metrics.style,
          ascentOverride: `${metrics.ascent * 100}%`,
          descentOverride: `${metrics.descent * 100}%`,
          lineGapOverride: "0%",
        },
      );
      void face
        .load()
        .then(() => {
          if (cancelled) return;
          document.fonts.add(face);
          faces.push(face);
          setLoaded((prior) => new Set([...prior, family]));
        })
        .catch(() => {
          /* Missing font uses the document's built-in fallback. */
        });
    }
    return () => {
      cancelled = true;
      for (const face of faces) document.fonts.delete(face);
    };
  }, [fonts]);
  const value = useMemo(
    () => ({ fonts, loaded, requirement, upgrade }),
    [fonts, loaded, requirement, upgrade],
  );
  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}

/** The provider's fonts and the plan's custom-font gate. */
export function useBrandFontLibrary() {
  const { fonts, requirement, upgrade } = useContext(FontContext);
  return { fonts, requirement, upgrade };
}

export function useBrandFont(reference: FontReference | null | undefined) {
  const { fonts, loaded } = useContext(FontContext);
  return (
    fonts.find(
      (font) =>
        font.id === reference?.id &&
        font.fingerprint === reference.fingerprint &&
        loaded.has(brandFontFamily(font)),
    ) ?? null
  );
}

export function brandFontStyle(font: BrandFontChoice): CSSProperties {
  return {
    fontFamily: `"${brandFontFamily(font)}", sans-serif`,
    fontWeight: font.weight,
    fontStyle: font.face?.style ?? "normal",
    fontSynthesis: "none",
  };
}

export function BrandFontPicker({
  value,
  onChange,
  studio = false,
}: {
  value: FontReference | null | undefined;
  onChange: (font: BrandFontChoice | null) => void;
  studio?: boolean;
}) {
  const { fonts, requirement, upgrade } = useContext(FontContext);
  const choices = fonts.filter(
    (font) => font.insertable !== false && font.accessUrl && font.face,
  );
  const selected = fonts.find(
    (font) => font.id === value?.id && font.fingerprint === value.fingerprint,
  );
  return (
    <Stack gap="2">
      <Text fontSize="12px" color={studio ? "studio.fgMuted" : "fg.muted"}>
        Custom font
      </Text>
      {requirement ? (
        <PlanLimitNotice message={requirement} upgrade={upgrade} />
      ) : (
        <>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
              aria-label="Custom font"
              value={value?.id ?? ""}
              onChange={(event) =>
                onChange(
                  choices.find(
                    (font) => font.id === event.currentTarget.value,
                  ) ?? null,
                )
              }
              bg={studio ? "studio.subtle" : "bg.soft"}
              borderWidth="0"
              borderRadius="l2"
              _focusVisible={{
                bg: studio ? "studio.raised" : "bg.muted",
                outline: "none",
              }}
            >
              <option value="">Use built-in font</option>
              {value && !choices.some((font) => font.id === value.id) ? (
                <option value={value.id}>
                  {selected?.family ?? "Retained font"} · saved in this clip
                </option>
              ) : null}
              {choices.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.family} · {font.style}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          {!choices.length ? (
            <Box
              bg={studio ? "studio.subtle" : "bg.soft"}
              borderRadius="l2"
              p="3"
            >
              <Text
                fontSize="12px"
                color={studio ? "studio.fgMuted" : "fg.muted"}
              >
                Upload fonts in Brand kit to use them here.
              </Text>
            </Box>
          ) : null}
        </>
      )}
      {value && !selected?.accessUrl ? (
        <Text fontSize="12px" color={studio ? "studio.fgMuted" : "fg.muted"}>
          Font file unavailable. The built-in font is used in preview and
          export.
        </Text>
      ) : null}
    </Stack>
  );
}
