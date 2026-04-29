"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Check, Copy, Pencil, Trash2 } from "lucide-react";
import type { BrandTemplateSummary } from "@narriflow/validators";
import {
  deleteBrandTemplateAction,
  duplicateBrandTemplateAction,
  setDefaultBrandTemplateAction,
} from "../actions";

interface TemplateGalleryProps {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  defaultId: string | null;
}

export function TemplateGallery({
  builtIns,
  mine,
  defaultId,
}: TemplateGalleryProps) {
  return (
    <Stack gap="36px">
      <Section
        title="Your templates"
        emptyHint="No saved templates yet. Duplicate a built-in or create a new one to get started."
        templates={mine}
        defaultId={defaultId}
        ownership="mine"
      />
      <Section
        title="Built-in"
        templates={builtIns}
        defaultId={defaultId}
        ownership="built-in"
      />
    </Stack>
  );
}

interface SectionProps {
  title: string;
  templates: BrandTemplateSummary[];
  defaultId: string | null;
  ownership: "mine" | "built-in";
  emptyHint?: string;
}

function Section({
  title,
  templates,
  defaultId,
  ownership,
  emptyHint,
}: SectionProps) {
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
      {templates.length === 0 ? (
        <Box
          p="20px"
          borderRadius="12px"
          borderWidth="1px"
          borderStyle="dashed"
          borderColor="border"
          bg="bg.subtle"
        >
          <Text fontSize="13px" color="fg.muted">
            {emptyHint ?? ""}
          </Text>
        </Box>
      ) : (
        <Grid
          templateColumns={{
            base: "1fr",
            md: "repeat(2, 1fr)",
            lg: "repeat(3, 1fr)",
          }}
          gap="14px"
        >
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isDefault={defaultId === template.id}
              ownership={ownership}
            />
          ))}
        </Grid>
      )}
    </Box>
  );
}

interface TemplateCardProps {
  template: BrandTemplateSummary;
  isDefault: boolean;
  ownership: "mine" | "built-in";
}

function TemplateCard({ template, isDefault, ownership }: TemplateCardProps) {
  const [pending, startTransition] = useTransition();

  function handleSetDefault() {
    startTransition(async () => {
      await setDefaultBrandTemplateAction(template.id);
    });
  }

  function handleDuplicate() {
    startTransition(async () => {
      await duplicateBrandTemplateAction(template.id);
    });
  }

  function handleDelete() {
    if (!confirm(`Delete "${template.name}"? This can't be undone.`)) return;
    startTransition(async () => {
      await deleteBrandTemplateAction(template.id);
    });
  }

  return (
    <Box
      borderRadius="14px"
      borderWidth="1px"
      borderColor={isDefault ? "border.accent" : "border"}
      bg="bg"
      overflow="hidden"
      transition="border-color 150ms ease"
      _hover={{ borderColor: "border.accent" }}
    >
      <Box
        h="120px"
        position="relative"
        overflow="hidden"
        style={{
          background: `linear-gradient(135deg, ${template.primaryColor} 0%, ${template.secondaryColor} 100%)`,
        }}
      >
        <Flex
          position="absolute"
          inset="0"
          align="center"
          justify="center"
          px="20px"
        >
          <Text
            fontSize="22px"
            fontWeight="800"
            color="white"
            textAlign="center"
            style={{
              fontFamily: template.captionPreset.fontName,
              textShadow: "0 2px 8px rgba(0,0,0,0.5)",
              letterSpacing: `${(template.captionPreset.letterSpacing ?? 0) * 1}em`,
              textTransform: template.captionPreset.textTransform === "uppercase"
                ? "uppercase"
                : template.captionPreset.textTransform === "lowercase"
                  ? "lowercase"
                  : template.captionPreset.textTransform === "capitalize"
                    ? "capitalize"
                    : "none",
            }}
          >
            Aa Bb Cc
          </Text>
        </Flex>
        {isDefault && (
          <Flex
            position="absolute"
            top="8px"
            right="8px"
            align="center"
            gap="4px"
            px="8px"
            py="3px"
            borderRadius="full"
            bg="rgba(0,0,0,0.55)"
            color="white"
            fontSize="10px"
            fontWeight="600"
          >
            <Check size={11} />
            Default
          </Flex>
        )}
      </Box>

      <Stack gap="10px" p="14px">
        <Flex align="center" justify="space-between" gap="6px">
          <Text fontSize="14px" fontWeight="600" color="fg" truncate>
            {template.name}
          </Text>
          {ownership === "built-in" && (
            <Text fontSize="10px" color="fg.subtle">
              Built-in
            </Text>
          )}
        </Flex>

        <Flex gap="6px" flexWrap="wrap">
          {!isDefault && (
            <button
              type="button"
              disabled={pending}
              onClick={handleSetDefault}
              style={buttonStyle("primary", pending)}
            >
              Set as default
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={handleDuplicate}
            style={buttonStyle("ghost", pending)}
          >
            <Copy size={11} style={{ marginRight: 4 }} />
            Duplicate
          </button>
          {ownership === "mine" && (
            <Link
              href={`/settings/brand-templates/${template.id}`}
              style={{ ...buttonStyle("ghost", pending), textDecoration: "none" }}
            >
              <Pencil size={11} style={{ marginRight: 4 }} />
              Edit
            </Link>
          )}
          {ownership === "mine" && (
            <button
              type="button"
              disabled={pending}
              onClick={handleDelete}
              style={buttonStyle("danger", pending)}
              aria-label="Delete template"
            >
              <Trash2 size={11} />
            </button>
          )}
        </Flex>
      </Stack>
    </Box>
  );
}

function buttonStyle(
  variant: "primary" | "ghost" | "danger",
  pending: boolean,
): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    height: 26,
    padding: "0 10px",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 6,
    cursor: pending ? "not-allowed" : "pointer",
    opacity: pending ? 0.5 : 1,
    transition: "background 120ms ease",
    border: "1px solid var(--chakra-colors-border)",
  };
  if (variant === "primary") {
    return {
      ...base,
      background: "var(--chakra-colors-fg)",
      color: "var(--chakra-colors-bg)",
      borderColor: "transparent",
    };
  }
  if (variant === "danger") {
    return {
      ...base,
      background: "transparent",
      color: "#ef4444",
      borderColor: "#ef444422",
    };
  }
  return {
    ...base,
    background: "transparent",
    color: "var(--chakra-colors-fg-muted)",
  };
}
