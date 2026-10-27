"use client";

import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { Gem } from "lucide-react";
import Link from "next/link";
import { useUpgrade, type UpgradePrompt } from "./upgrade";

const actionStyle = {
  color: "upgrade.fg",
  fontWeight: "600",
  textDecoration: "underline",
  textDecorationColor: "transparent",
  textUnderlineOffset: "3px",
  transition: "text-decoration-color 120ms ease",
  _hover: { textDecorationColor: "currentColor" },
} as const;

/**
 * Inline plan-limit prompt shown next to an action the plan doesn't allow.
 * The message is computed server-side (see `planFeatureRequirement`) so the
 * specific limit copy survives production Server-Action error redaction.
 * It's an upgrade prompt, not an error: gold gem, muted copy, gold action.
 *
 * - `upgrade` with a tier: the action opens the shared upgrade dialog.
 * - `upgrade` null (no plan lifts this limit): explanation only, no action.
 * - `upgrade` omitted: the action links to billing.
 * Only the owner can change the plan; everyone else is told whom to ask.
 */
export function PlanLimitNotice({
  message,
  actionLabel = "Upgrade",
  canManageBilling: canManageBillingProp,
  upgrade,
}: {
  message: string | null;
  actionLabel?: string;
  canManageBilling?: boolean;
  upgrade?: UpgradePrompt | null;
}) {
  const context = useUpgrade();
  if (!message) return null;
  const canManageBilling = canManageBillingProp ?? context.canManageBilling;
  const upgradable = upgrade === undefined || Boolean(upgrade?.tier);
  return (
    <Flex align="flex-start" gap="1.5" mt="1.5">
      <Box mt="0.5" flexShrink={0} color="upgrade.fg">
        <Gem size={13} aria-hidden />
      </Box>
      <Text fontSize="xs" color="fg.muted">
        {message}
        {!upgradable ? null : canManageBilling ? (
          <>
            {" "}
            {upgrade ? (
              <chakra.button type="button" aria-haspopup="dialog" onClick={() => context.openUpgrade(upgrade)} {...actionStyle}>
                {actionLabel}
              </chakra.button>
            ) : (
              <Link href="/settings/billing#plans">
                <Text as="span" {...actionStyle}>{actionLabel}</Text>
              </Link>
            )}
          </>
        ) : (
          " Ask the workspace owner to upgrade."
        )}
      </Text>
    </Flex>
  );
}
