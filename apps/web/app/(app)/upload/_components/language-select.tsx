"use client";

import { Box, Text } from "@chakra-ui/react";
import { Select } from "@narriflow/ui/components/select";
import { getAssemblyAiLanguage } from "@narriflow/validators";
import { Globe, Sparkles } from "lucide-react";
import { LANGUAGE_OPTIONS } from "../../_shared/languages";

/** Only a language that transcribes below "high" says so in the list. */
const ACCURACY_NOTE = {
  good: "Good accuracy",
  moderate: "Moderate accuracy",
  fair: "Fair accuracy",
} as const;

/** The language's own code in a small tile (the region for a variant: US, UK, AU), so a long list scans quickly. */
function LanguageMark({ code }: { code: string }) {
  const [language = code, region] = code.split("_");
  return (
    <Box w="32px" display="flex" justifyContent="center">
      <Text
        as="span"
        textStyle="data"
        fontSize="11px"
        fontWeight="600"
        color="fg.muted"
        bg="bg.muted"
        borderRadius="5px"
        minW="28px"
        py="0.5"
        textAlign="center"
        textTransform="uppercase"
      >
        {region ?? language}
      </Text>
    </Box>
  );
}

const languageItems = LANGUAGE_OPTIONS.map((option) => {
  const label = option.label.split(" · ")[0] ?? option.label;
  if (option.code === "auto") {
    return {
      label,
      value: option.code,
      description: "Recommended",
      icon: (
        <Box w="32px" display="flex" justifyContent="center" color="accent.fg">
          <Sparkles size={15} />
        </Box>
      ),
    };
  }
  const band = getAssemblyAiLanguage(option.code).accuracyBand;
  return {
    label,
    value: option.code,
    description: band && band !== "high" ? ACCURACY_NOTE[band] : undefined,
    icon: <LanguageMark code={option.code} />,
  };
});

interface LanguageSelectProps {
  value: string;
  onChange: (value: string) => void;
}

/** Speech-language picker with an accessible name and leading language icon. */
export function LanguageSelect({ value, onChange }: LanguageSelectProps) {
  return (
    <Select
      ariaLabel="Speech language"
      startElement={<Globe size={16} strokeWidth={1.75} />}
      items={languageItems}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      placeholder="Select language"
      size="md"
    />
  );
}
