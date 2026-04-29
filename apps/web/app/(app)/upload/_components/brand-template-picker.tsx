"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import Link from "next/link";
import type { BrandTemplateSummary } from "@narriflow/validators";
import { ExternalLink } from "lucide-react";

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

  return (
    <Box>
      <Flex align="center" justify="space-between" mb="8px">
        <Text fontSize="13px" fontWeight="500" color="fg">
          Brand template
        </Text>
        <Link
          href="/settings/brand-templates"
          style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
        >
          <Text
            as="span"
            fontSize="11px"
            color="fg.muted"
            _hover={{ color: "fg" }}
          >
            Manage
          </Text>
          <ExternalLink size={11} />
        </Link>
      </Flex>

      <Box position="relative">
        <select
          value={value ?? ""}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next || null);
          }}
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--chakra-colors-border)",
            background: "var(--chakra-colors-bg)",
            color: "var(--chakra-colors-fg)",
            fontSize: 13,
            appearance: "none",
            cursor: "pointer",
          }}
        >
          <option value="">System default</option>
          {mine.length > 0 && (
            <optgroup label="Your templates">
              {mine.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Built-in">
            {builtIns.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </optgroup>
        </select>
      </Box>

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
    <Box
      mt="8px"
      p="10px"
      borderRadius="8px"
      borderWidth="1px"
      borderColor="border"
      bg="bg.subtle"
    >
      <Flex align="center" gap="8px">
        <Box
          w="14px"
          h="14px"
          borderRadius="3px"
          bg={template.primaryColor}
          borderWidth="1px"
          borderColor="border"
        />
        <Box
          w="14px"
          h="14px"
          borderRadius="3px"
          bg={template.secondaryColor}
          borderWidth="1px"
          borderColor="border"
        />
        <Text
          fontSize="11px"
          color="fg.muted"
          fontFamily={captionPreset.fontName ? "inherit" : undefined}
        >
          {captionPreset.fontName} · {captionPreset.animation}
          {template.logoStorageKey ? " · with logo" : ""}
        </Text>
      </Flex>
    </Box>
  );
}
