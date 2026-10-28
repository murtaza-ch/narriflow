import { Box, Flex, Grid, Stack } from "@chakra-ui/react";
import { BadgeCheck, CalendarClock, Coins } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { StatTileSkeleton, TextBone } from "../_components/settings-skeleton";

/** Billing & plans: three stat tiles, the plan status card, then the plan picker (interval toggle and three plan cards). */
export default function Loading() {
  return (
    <LoadingScreen label="Loading billing" gap="8">
      <PageHeader title="Billing & plans" description="Your plan, credits, and subscription." />
      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
        <StatTileSkeleton icon={<BadgeCheck size={14} />} label="Current plan" />
        <StatTileSkeleton icon={<Coins size={14} />} label="Credits used this month" meter hint={false} />
        <StatTileSkeleton icon={<CalendarClock size={14} />} label="Credits remaining" />
      </Grid>
      <Stack gap="6">
        <Flex
          justify="space-between"
          align={{ base: "flex-start", md: "center" }}
          gap="5"
          direction={{ base: "column", md: "row" }}
          bg="bg.subtle"
          borderRadius="l3"
          p={{ base: "5", md: "6" }}
        >
          <Flex gap="3" align="flex-start" minW="0" flex="1">
            <Bone boxSize="9" borderRadius="10px" flexShrink={0} />
            <Stack gap="1.5" maxW="680px" minW="0" flex="1">
              <TextBone w="56" line="23px" h="3.5" />
              <TextBone w="96" line="20px" />
              <TextBone w="40" line="18px" h="2.5" />
            </Stack>
          </Flex>
          <Bone h="9" w="36" borderRadius="control" flexShrink={0} />
        </Flex>
        <Stack gap="4" pt="2">
          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
            <TextBone w="32" line="23px" h="3.5" />
            <Bone h="9" w="64" borderRadius="control" />
          </Flex>
          <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
            {[0, 1, 2].map((plan) => (
              <Stack key={plan} gap="5" p="6" bg="bg.subtle" borderRadius="l3">
                <Flex align="center" minH="6">
                  <TextBone w="20" line="20px" h="3.5" />
                </Flex>
                <Stack gap="1">
                  <Flex align="baseline" h="34px">
                    <Bone h="7" w="28" />
                  </Flex>
                  <TextBone w="32" line="18px" h="2.5" />
                </Stack>
                <Stack gap="2.5" flex="1">
                  {[0, 1, 2, 3, 4, 5, 6].map((bullet) => (
                    <Flex key={bullet} gap="2.5" align="flex-start">
                      <Box mt="0.5" flexShrink={0}>
                        <Bone boxSize="3.5" borderRadius="full" />
                      </Box>
                      <Box flex="1" minW="0">
                        <TextBone w={bullet % 3 === 2 ? "60%" : "90%"} line="20px" h="2.5" />
                      </Box>
                    </Flex>
                  ))}
                </Stack>
                <Bone h="10" w="full" borderRadius="control" />
              </Stack>
            ))}
          </Grid>
        </Stack>
      </Stack>
    </LoadingScreen>
  );
}
