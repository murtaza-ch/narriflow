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
  profiles?: Array<{
    id: string;
    name: string;
    defaultTemplateId: string | null;
    templates: Array<{ id: string; name: string }>;
  }>;
  profileValue?: string | null;
  onProfileChange?: (id: string | null) => void;
}

export function BrandTemplatePicker({
  builtIns,
  mine,
  value,
  onChange,
  profiles = [],
  profileValue = null,
  onProfileChange = () => undefined,
}: BrandTemplatePickerProps) {
  const activeProfile = profiles.find((profile) => profile.id === profileValue) ?? null;
  const profileTemplateIds = new Set(activeProfile?.templates.map((template) => template.id) ?? []);
  const compatibleMine = activeProfile ? mine.filter((template) => profileTemplateIds.has(template.id)) : mine;
  const allOptions = [...compatibleMine, ...builtIns];
  const items = [
    { label: "System default", value: SYSTEM_DEFAULT_VALUE },
    ...compatibleMine.map((template) => ({ label: template.name, value: template.id })),
    ...(!activeProfile ? builtIns : []).map((template) => ({
      label: `${template.name} · built-in`,
      value: template.id,
    })),
  ];

  return (
    <Box>
      <Flex align="center" justify="space-between" mb="2">
        <Text textStyle="eyebrow" color="fg.subtle">
          Brand selection
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

      <Flex direction={{ base: "column", sm: "row" }} gap="2">
        <Select
          items={[
            { label: "No Brand Profile", value: SYSTEM_DEFAULT_VALUE },
            ...profiles.map((profile) => ({ label: profile.name, value: profile.id })),
          ]}
          value={profileValue ?? SYSTEM_DEFAULT_VALUE}
          onValueChange={(next) => {
            const profileId = next && next !== SYSTEM_DEFAULT_VALUE ? next : null;
            onProfileChange(profileId);
            const profile = profiles.find((candidate) => candidate.id === profileId);
            onChange(profile?.defaultTemplateId ?? null);
          }}
          ariaLabel="Brand profile"
          placeholder="Select Brand Profile"
          size="sm"
        />
        <Select
          items={items}
          value={value ?? SYSTEM_DEFAULT_VALUE}
          onValueChange={(next) =>
            onChange(next && next !== SYSTEM_DEFAULT_VALUE ? next : null)
          }
          ariaLabel="Brand template"
          placeholder="Select style preset"
          size="sm"
        />
      </Flex>

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
