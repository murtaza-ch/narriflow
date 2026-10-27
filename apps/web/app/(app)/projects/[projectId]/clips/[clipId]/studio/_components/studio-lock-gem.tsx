"use client";

import { Box, chakra } from "@chakra-ui/react";
import { Gem } from "lucide-react";
import { PLAN_CATALOG, type PricingTier } from "@narriflow/validators";

/** Gold gem on a Studio control the plan doesn't include; clicking the control opens the upgrade dialog. */
export function StudioLockGem({ tier, size = 13 }: { tier: PricingTier; size?: number }) {
  return (
    <>
      <Box as="span" color="upgrade.fg" display="inline-flex" flexShrink={0}>
        <Gem size={size} aria-hidden />
      </Box>
      <chakra.span srOnly>(needs {PLAN_CATALOG[tier].name})</chakra.span>
    </>
  );
}
