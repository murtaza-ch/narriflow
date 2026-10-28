"use client";

import { Box, Flex, Grid, Stack, TagsInput, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { ColorSwatchField } from "@narriflow/ui/components/color-swatch-field";
import { Textarea } from "@narriflow/ui/components/textarea";
import type { BrandColors } from "./brand-kit-ui";

/** Quick picks; user color values stay literal. */
export const BRAND_SWATCHES = ["#FFFFFF", "#000000", "#111522", "#5B6CFF", "#2438E8", "#00C2FF", "#00FF88", "#FFD400", "#FF8A00", "#FF3355", "#B46BFF", "#E5E5E5"];

export const COLOR_ROLES = [
  { key: "primaryColor", label: "Primary" },
  { key: "secondaryColor", label: "Secondary" },
  { key: "accentColor", label: "Signal" },
] as const;

/** The three brand colors as large tiles, each opening a picker. */
export function BrandColorTiles({ colors, onChange, disabled }: { colors: BrandColors; onChange?: (next: BrandColors) => void; disabled?: boolean }) {
  return (
    <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap={{ base: "3", md: "4" }}>
      {COLOR_ROLES.map((role) => (
        <ColorSwatchField
          key={role.key}
          variant="tile"
          label={role.label}
          value={colors[role.key] ?? "#000000"}
          swatches={BRAND_SWATCHES}
          disabled={disabled || !onChange}
          onChange={(hex) => onChange?.({ ...colors, [role.key]: hex.toUpperCase() })}
        />
      ))}
    </Grid>
  );
}

/** The palette applied: a title card in the secondary color with primary text and a signal button. */
export function BrandColorPreview({ colors, name }: { colors: BrandColors; name: string }) {
  return (
    <Flex
      align="center"
      justify="space-between"
      gap="4"
      px={{ base: "4", md: "5" }}
      py="4"
      borderRadius="l2"
      transition="background 160ms ease"
      style={{ background: colors.secondaryColor }}
    >
      <Stack gap="0.5" minW="0">
        <Text fontFamily="display" fontWeight="600" fontSize={{ base: "17px", md: "20px" }} letterSpacing="-0.02em" truncate style={{ color: colors.primaryColor }}>
          {name || "Your brand"}
        </Text>
        <Text fontSize="12px" opacity={0.7} truncate style={{ color: colors.primaryColor }}>
          New episode out now
        </Text>
      </Stack>
      <Box flexShrink={0} px="3" py="1.5" borderRadius="full" fontSize="12px" fontWeight="600" style={{ background: colors.accentColor ?? colors.primaryColor, color: colors.secondaryColor }}>
        Watch
      </Box>
    </Flex>
  );
}

export interface VoiceDraft {
  audience: string;
  tone: string[];
  preferredTerms: string[];
  blockedTerms: string[];
  hashtagGuidance: string;
}

export const EMPTY_VOICE: VoiceDraft = { audience: "", tone: [], preferredTerms: [], blockedTerms: [], hashtagGuidance: "" };

function FieldRow({ label, hint, stacked, children }: { label: string; hint: string; stacked: boolean; children: ReactNode }) {
  return (
    <Grid templateColumns={stacked ? "1fr" : { base: "1fr", md: "200px minmax(0, 1fr)" }} gap={stacked ? "2" : { base: "2", md: "6" }} alignItems="start">
      <Stack gap="0.5" pt={stacked ? "0" : { md: "2" }}>
        <Text fontSize="13px" fontWeight="500">
          {label}
        </Text>
        <Text fontSize="12px" color="fg.subtle">
          {hint}
        </Text>
      </Stack>
      {children}
    </Grid>
  );
}

/** Terms as removable chips; Enter, comma or paste adds them. */
export function TermsInput({ label, value, onChange, placeholder, tone = "neutral" }: { label: string; value: string[]; onChange: (next: string[]) => void; placeholder: string; tone?: "neutral" | "blocked" }) {
  return (
    <TagsInput.Root
      value={value}
      onValueChange={(details) => onChange(details.value)}
      delimiter={/[,\n]/}
      addOnPaste
      blurBehavior="add"
      max={50}
      validate={(details) => details.inputValue.trim().length > 0 && details.inputValue.trim().length <= 80 && !details.value.includes(details.inputValue.trim())}
      sanitizeValue={(input) => input.trim()}
      size="sm"
    >
      <TagsInput.Control
        minH="10"
        px="2"
        py="1.5"
        gap="1.5"
        bg="bg.soft"
        borderWidth="1px"
        borderColor="transparent"
        borderRadius="control"
        transition="background 120ms ease, border-color 120ms ease"
        _hover={{ bg: "bg.softHover" }}
        _focusWithin={{ borderColor: "border.focus", outline: "none", boxShadow: "none" }}
      >
        <TagsInput.Context>
          {({ value: tags }) =>
            tags.map((tag, index) => (
              <TagsInput.Item key={`${tag}-${index}`} index={index} value={tag}>
                <TagsInput.ItemPreview
                  h="6"
                  px="2"
                  gap="1"
                  borderRadius="6px"
                  borderWidth="0"
                  bg={tone === "blocked" ? "danger.subtle" : "bg.panel"}
                  color={tone === "blocked" ? "danger.fg" : "fg"}
                  fontSize="12.5px"
                  fontWeight="500"
                  _highlighted={{ bg: tone === "blocked" ? "danger.muted" : "bg.muted" }}
                >
                  <TagsInput.ItemText>{tag}</TagsInput.ItemText>
                  <TagsInput.ItemDeleteTrigger color="fg.muted" _hover={{ color: "fg" }} aria-label={`Remove ${tag}`} />
                </TagsInput.ItemPreview>
                <TagsInput.ItemInput />
              </TagsInput.Item>
            ))
          }
        </TagsInput.Context>
        <TagsInput.Input aria-label={label} placeholder={value.length ? "" : placeholder} fontSize="13px" px="1" minW="24" _placeholder={{ color: "fg.subtle" }} />
      </TagsInput.Control>
    </TagsInput.Root>
  );
}

/** Audience, tone, terms and hashtag guidance; captions and posts follow it. */
export function VoiceFields({ value, onChange, stacked = false }: { value: VoiceDraft; onChange: (next: VoiceDraft) => void; /** Labels above fields, for narrow columns. */ stacked?: boolean }) {
  const set = <K extends keyof VoiceDraft>(key: K, next: VoiceDraft[K]) => onChange({ ...value, [key]: next });
  return (
    <Stack gap="6">
      <FieldRow stacked={stacked} label="Audience" hint="Who the brand speaks to">
        <Textarea aria-label="Audience" value={value.audience} onChange={(event) => set("audience", event.currentTarget.value)} maxLength={500} rows={2} resize="vertical" placeholder="e.g. Independent coffee lovers in their 20s and 30s" />
      </FieldRow>
      <FieldRow stacked={stacked} label="Tone" hint="How it sounds">
        <TermsInput label="Tone" value={value.tone} onChange={(next) => set("tone", next)} placeholder="e.g. warm, specific, practical" />
      </FieldRow>
      <FieldRow stacked={stacked} label="Preferred terms" hint="Words to use">
        <TermsInput label="Preferred terms" value={value.preferredTerms} onChange={(next) => set("preferredTerms", next)} placeholder="e.g. coffee bar, seasonal menu" />
      </FieldRow>
      <FieldRow stacked={stacked} label="Blocked terms" hint="Words to never use">
        <TermsInput label="Blocked terms" tone="blocked" value={value.blockedTerms} onChange={(next) => set("blockedTerms", next)} placeholder="e.g. cheap, viral hack" />
      </FieldRow>
      <FieldRow stacked={stacked} label="Hashtags" hint="How to tag posts">
        <Textarea aria-label="Hashtag guidance" value={value.hashtagGuidance} onChange={(event) => set("hashtagGuidance", event.currentTarget.value)} maxLength={500} rows={2} resize="vertical" placeholder="e.g. Use two local tags and one campaign tag." />
      </FieldRow>
    </Stack>
  );
}
