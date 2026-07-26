"use client";

import { Select } from "@narriflow/ui/components/select";
import { LANGUAGE_OPTIONS } from "../../_shared/languages";

const languageItems = LANGUAGE_OPTIONS.map((option) => ({
  label: option.label,
  value: option.code,
}));

interface LanguageSelectProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Speech-language picker on the kit Select. The section eyebrow is drawn by
 * the surrounding settings band in the upload shell.
 */
export function LanguageSelect({ value, onChange }: LanguageSelectProps) {
  return (
    <Select
      items={languageItems}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      placeholder="Select language"
      size="sm"
    />
  );
}
