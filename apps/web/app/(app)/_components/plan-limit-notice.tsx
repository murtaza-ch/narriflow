import { Box, Flex, Text } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

/**
 * Inline plan-limit warning shown next to a disabled primary action. The
 * message is computed server-side (see `planFeatureRequirement`) so the
 * specific limit copy survives production Server-Action error redaction.
 * Only the owner can change the plan; everyone else is told whom to ask.
 */
export function PlanLimitNotice({
  message,
  actionLabel = "Upgrade to keep generating.",
  canManageBilling = true,
}: {
  message: string | null;
  actionLabel?: string;
  canManageBilling?: boolean;
}) {
  if (!message) return null;
  if (!canManageBilling) {
    return (
      <Flex align="flex-start" gap="1.5" mt="1.5" color="warning.fg">
        <Box mt="0.5" flexShrink={0}>
          <AlertTriangle size={13} aria-hidden />
        </Box>
        <Text fontSize="xs">{message} Ask the workspace owner to upgrade.</Text>
      </Flex>
    );
  }
  return (
    <Flex align="flex-start" gap="1.5" mt="1.5" color="warning.fg">
      <Box mt="0.5" flexShrink={0}>
        <AlertTriangle size={13} aria-hidden />
      </Box>
      <Text fontSize="xs">
        {message}{" "}
        <Link href="/settings/billing">
          <Text
            as="span"
            color="fg"
            textDecoration="underline"
            textDecorationColor="border.emphasized"
            textUnderlineOffset="3px"
            transition="text-decoration-color 120ms ease"
            _hover={{ textDecorationColor: "fg" }}
          >
            {actionLabel}
          </Text>
        </Link>
      </Text>
    </Flex>
  );
}
