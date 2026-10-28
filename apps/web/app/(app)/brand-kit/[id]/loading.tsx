import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { BrandColorsLoading, BrandTabsLoading } from "../_components/brand-kit-loading";
import { Panel } from "../_components/brand-kit-ui";

const ROLES = ["Display", "Body", "Caption", "Fallback"];

/** Brand Profile, Identity section: mark + name header, the six section tabs, then Colors/Publishing beside Typography. */
export default function BrandProfileLoading() {
  return (
    <LoadingScreen label="Loading Brand Profile">
      <Flex align="center" justify="space-between" gap="4" wrap="wrap">
        <Flex align="center" gap={{ base: "3", md: "4" }} minW="0">
          <Bone boxSize="9" borderRadius="control" ms="-2" />
          <Bone boxSize="14" borderRadius="14px" flexShrink={0} />
          <Stack gap="1.5" minW="0">
            <Bone h="7" w="56" maxW="full" />
            <Bone h="4" w="64" maxW="full" />
          </Stack>
        </Flex>
        <Flex gap="2">
          <Bone h="9" w="28" borderRadius="control" />
          <Bone h="9" w="24" borderRadius="control" />
        </Flex>
      </Flex>

      <Stack gap="6">
        <BrandTabsLoading
          labels={["Identity", "Styles", "Assets", "Scenes", "Audio", "Voice"]}
          counted={["Styles", "Assets", "Audio"]}
        />
        <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1.3fr) minmax(0, 1fr)" }} gap="5" alignItems="start">
          <Stack gap="5">
            <Panel title="Colors">
              <BrandColorsLoading />
            </Panel>
            <Panel title="Publishing">
              <Stack gap="3">
                <Bone h="9" w="60" borderRadius="control" />
                <Bone h="3.5" w="90%" maxW="xl" />
              </Stack>
            </Panel>
          </Stack>
          <Panel title="Typography">
            <Stack gap="4">
              {ROLES.map((role) => (
                <Flex key={role} align="center" gap="4" minW="0">
                  <Text w="16" flexShrink={0} fontSize="12px" fontWeight="500" color="fg.muted">
                    {role}
                  </Text>
                  <Stack gap="0" minW="0" flex="1">
                    <Flex h="7" align="center">
                      <Bone h="5" w="24" />
                    </Flex>
                    <Flex h="4.5" align="center">
                      <Bone h="3" w="20" />
                    </Flex>
                  </Stack>
                  <Bone h="9" w={{ base: "36", md: "44" }} borderRadius="control" flexShrink={0} />
                </Flex>
              ))}
            </Stack>
            <Text fontSize="12px" color="fg.subtle">
              Roles make fonts available to this profile&apos;s scenes.
            </Text>
          </Panel>
        </Grid>
      </Stack>
    </LoadingScreen>
  );
}
