"use client";

import { Select } from "@narriflow/ui/components/select";

export interface RecipeBrandProfile {
  id: string;
  name: string;
  isDefault: boolean;
}

/** The kit Select needs a non-empty value for its "no profile" option. */
const NO_BRAND_PROFILE = "__none__";

export function BrandProfileSelect({
  profiles,
  value,
  onChange,
}: {
  profiles: RecipeBrandProfile[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  if (profiles.length === 0 && value === null) return null;
  const unavailable = value !== null && !profiles.some((profile) => profile.id === value);
  return (
    <Select
      label="Brand Profile"
      items={[
        { label: "No Brand Profile", value: NO_BRAND_PROFILE },
        ...(unavailable ? [{ label: "Unavailable Brand Profile", value }] : []),
        ...profiles.map((profile) => ({ label: profile.name, value: profile.id })),
      ]}
      value={value ?? NO_BRAND_PROFILE}
      onValueChange={(next) => onChange(next === NO_BRAND_PROFILE ? null : next)}
      size="sm"
    />
  );
}
