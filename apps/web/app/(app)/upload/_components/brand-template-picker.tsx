"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import Link from "next/link";
import type { BrandTemplateSummary } from "@narriflow/validators";
import { ExternalLink } from "lucide-react";
import { Select } from "@narriflow/ui/components/select";

/** Sentinel for the "no template" option — the kit Select needs a non-empty value. */
const SYSTEM_DEFAULT_VALUE = "__system_default__";

interface BrandTemplatePickerProps {
  builtIns: BrandTemplateSummary[];
  mine: BrandTemplateSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
}

export function BrandTemplatePicker({
  builtIns,
  mine,
  value,
  onChange,
}: BrandTemplatePickerProps) {
  const allOptions = [...mine, ...builtIns];
  const items = [
    { label: "System default", value: SYSTEM_DEFAULT_VALUE },
    ...mine.map((template) => ({ label: template.name, value: template.id })),
    ...builtIns.map((template) => ({
      label: `${template.name} · built-in`,
      value: template.id,
    })),
  ];

  return (
    <Box>
      <Flex align="center" justify="space-between" mb="2">
        <Text textStyle="eyebrow" color="fg.subtle">
          Brand template
        </Text>
        <Link href="/brand-kit">
          <Text
            as="span"
            display="inline-flex"
            alignItems="center"
            gap="1"
            fontSize="11px"
            color="fg"
            textDecoration="underline"
            textUnderlineOffset="2px"
            transition="color 120ms ease"
            _hover={{ color: "fg.muted" }}
          >
            Manage
            <ExternalLink size={11} />
          </Text>
        </Link>
      </Flex>

      <Select
        items={items}
        value={value ?? SYSTEM_DEFAULT_VALUE}
        onValueChange={(next) =>
          onChange(next && next !== SYSTEM_DEFAULT_VALUE ? next : null)
        }
        placeholder="Select brand template"
        size="sm"
      />

      {value && (
        <BrandTemplatePreview
          template={allOptions.find((t) => t.id === value) ?? null}
        />
      )}
    </Box>
  );
}

function BrandTemplatePreview({
  template,
}: {
  template: BrandTemplateSummary | null;
}) {
  if (!template) return null;
  const { captionPreset } = template;
  return (
    <Flex
      align="center"
      gap="2"
      mt="2"
      pt="2"
      borderTopWidth="1px"
      borderTopColor="border.subtle"
      animation="fade-up"
    >
      {/* User-chosen brand color values stay literal by design. */}
      <Box
        w="14px"
        h="14px"
        borderRadius="l1"
        bg={template.primaryColor}
        borderWidth="1px"
        borderColor="border"
      />
      <Box
        w="14px"
        h="14px"
        borderRadius="l1"
        bg={template.secondaryColor}
        borderWidth="1px"
        borderColor="border"
      />
      <Text textStyle="data" fontSize="11px" color="fg.muted">
        {captionPreset.fontName} · {captionPreset.animation}
        {template.logoStorageKey ? " · with logo" : ""}
      </Text>
    </Flex>
  );
}
