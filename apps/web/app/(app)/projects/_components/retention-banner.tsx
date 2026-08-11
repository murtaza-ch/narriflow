import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Clock3 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";

export function RetentionBanner() {
  return (
    <Flex
      as="aside"
      aria-label="Free-plan project retention"
      align={{ base: "flex-start", sm: "center" }}
      justify="space-between"
      direction={{ base: "column", sm: "row" }}
      gap="4"
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="border"
      borderInlineStartWidth="3px"
      borderInlineStartColor="accent.solid"
      py="4"
      px={{ base: "4", md: "5" }}
      bg="bg.subtle"
    >
      <Flex gap="3" align="flex-start">
        <Box color="accent.fg" pt="0.5" flexShrink={0}>
          <Clock3 size={17} strokeWidth={1.75} aria-hidden="true" />
        </Box>
        <Stack gap="1">
          <Text textStyle="eyebrow" color="fg">
            Free storage · 3 days
          </Text>
          <Text fontSize="13px" color="fg.muted" lineHeight="1.55">
            Free projects are permanently deleted three days after creation.
            Upgrade before the deadline to keep every active project.
          </Text>
        </Stack>
      </Flex>
      <Button size="sm" variant="outline" asChild flexShrink={0}>
        <Link href="/settings/billing">Keep my projects</Link>
      </Button>
    </Flex>
  );
}
