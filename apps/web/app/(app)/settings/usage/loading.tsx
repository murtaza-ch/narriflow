import { Box, Flex, Grid, Stack } from "@chakra-ui/react";
import { Coins, Film, Gauge, HelpCircle } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { SettingsCard } from "../_components/settings-ui";
import { StatTileSkeleton, TextBone } from "../_components/settings-skeleton";

/** Usage: header (the plan and renewal line is data), three stat tiles, then the How credits work card. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading usage" gap="6">
      <PageHeader title="Usage" description={<Bone as="span" display="block" h="3.5" my="0.75" w="72" maxW="full" />} />
      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
        <StatTileSkeleton icon={<Gauge size={14} />} label="Credits used" meter />
        <StatTileSkeleton icon={<Coins size={14} />} label="Credits left" />
        <StatTileSkeleton icon={<Film size={14} />} label="Videos processing" />
      </Grid>
      <SettingsCard icon={<HelpCircle size={16} />} title="How credits work">
        <Stack gap="2.5">
          {[0, 1, 2, 3].map((line) => (
            <Flex key={line} gap="2.5" align="flex-start">
              <Bone boxSize="3.5" borderRadius="full" mt="0.5" flexShrink={0} />
              <Box flex="1" minW="0">
                <TextBone w={line % 2 ? "70%" : "90%"} line="20px" />
              </Box>
            </Flex>
          ))}
        </Stack>
      </SettingsCard>
    </LoadingScreen>
  );
}
