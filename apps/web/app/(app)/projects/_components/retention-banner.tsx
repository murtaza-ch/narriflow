import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Clock3 } from "lucide-react";
import { lowestTier, planLimits } from "@narriflow/validators";
import { UpgradeButton } from "../../_components/upgrade";

const RETENTION_DAYS = (planLimits("free").projectRetentionHours ?? 0) / 24;
const DAYS_LABEL = `${RETENTION_DAYS} day${RETENTION_DAYS === 1 ? "" : "s"}`;

export function RetentionBanner({ canManageBilling }: { canManageBilling: boolean }) {
  return (
    <Flex
      as="aside"
      aria-label="Project retention"
      align={{ base: "flex-start", sm: "center" }}
      justify="space-between"
      direction={{ base: "column", sm: "row" }}
      gap="4"
      borderWidth="1px"
      borderColor="border.card"
      borderRadius="l3"
      py="4"
      px={{ base: "4", md: "5" }}
      bg="bg.panel"
    >
      <Flex gap="3" align="flex-start">
        <Box color="accent.fg" pt="0.5" flexShrink={0}>
          <Clock3 size={18} strokeWidth={1.75} aria-hidden="true" />
        </Box>
        <Stack gap="1">
          <Text fontSize="14px" fontWeight="500" color="fg">
            Projects on this plan are kept for {DAYS_LABEL}
          </Text>
          <Text fontSize="13px" color="fg.muted" lineHeight="1.55">
            Each project shows its own deletion deadline. Projects from a plan
            that ended get a short grace period instead. Upgrade before a
            deadline to keep them.
          </Text>
        </Stack>
      </Flex>
      {canManageBilling ? (
        <UpgradeButton tier={lowestTier((plan) => plan.limits.projectRetentionHours === null)} flexShrink={0}>
          Keep my projects
        </UpgradeButton>
      ) : (
        <Text fontSize="12.5px" color="fg.muted" flexShrink={0}>Ask the workspace owner to upgrade.</Text>
      )}
    </Flex>
  );
}
