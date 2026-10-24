"use client";

import { useState } from "react";
import Link from "next/link";
import { Stack, Text } from "@chakra-ui/react";
import { Switch } from "@narriflow/ui/components/switch";

/** "Use my performance data to pick clips", with what turning it on means. */
export function PerformanceGuidanceField({
  enabled,
  qualifies,
  minimumClips,
  canManage,
}: {
  enabled: boolean;
  qualifies: boolean;
  minimumClips: number;
  canManage: boolean;
}) {
  const [checked, setChecked] = useState(enabled);
  return (
    <Stack gap="3">
      <Switch inputProps={{ name: "enabled" }} checked={checked} onCheckedChange={setChecked} disabled={!canManage}>
        Use my performance data to pick clips
      </Switch>
      <Text fontSize="12px" color="fg.subtle">
        Only clips you posted from Narriflow to TikTok and YouTube Shorts count, and what Narriflow has learned is refreshed
        daily.
        {checked
          ? qualifies
            ? " It nudges which moments are found and which clips are exported first."
            : ` It takes effect once ${minimumClips} clips have a 7-day reading.`
          : " Clips are picked on their own score."}{" "}
        <Link href="/performance">
          <Text as="span" color="fg.accent" textDecoration="underline" textUnderlineOffset="3px">
            See what worked
          </Text>
        </Link>
      </Text>
    </Stack>
  );
}
