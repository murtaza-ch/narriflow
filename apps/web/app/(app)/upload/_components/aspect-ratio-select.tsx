"use client";

import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { clipAspectRatioOptions, type ContentPack } from "@narriflow/validators";

type DefaultAspectRatio = ContentPack["defaultAspectRatio"];

const items = clipAspectRatioOptions.map((option) => ({
  label: option.value,
  value: option.value,
}));

export function AspectRatioSelect({
  value,
  onChange,
}: {
  value: DefaultAspectRatio;
  onChange: (value: DefaultAspectRatio) => void;
}) {
  return (
    <SegmentedControl
      items={items}
      value={value}
      onValueChange={(next) => onChange(next as DefaultAspectRatio)}
      size="sm"
    />
  );
}
