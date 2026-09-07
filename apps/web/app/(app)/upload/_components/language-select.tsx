"use client";

import { Select } from "@narriflow/ui/components/select";
import { Globe } from "lucide-react";
import { LANGUAGE_OPTIONS } from "../../_shared/languages";

const languageItems = LANGUAGE_OPTIONS.map((option) => ({
  label: option.label.split(" · ")[0] ?? option.label,
  value: option.code,
}));

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
      css={{
        "& [data-part=trigger]": {
          background: "var(--chakra-colors-bg-panel)",
          borderColor: "var(--chakra-colors-border)",
        },
      }}
    />
  );
}
