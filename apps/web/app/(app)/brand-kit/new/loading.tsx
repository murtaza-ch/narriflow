import { Flex, Grid, Heading, Stack, Text } from "@chakra-ui/react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { BrandColorsLoading, FieldLoading } from "../_components/brand-kit-loading";
import { Panel } from "../_components/brand-kit-ui";

const VOICE_FIELDS = [
  { label: "Audience", hint: "Who the brand speaks to", height: "16" },
  { label: "Tone", hint: "How it sounds", height: "10" },
  { label: "Preferred terms", hint: "Words to use", height: "10" },
  { label: "Blocked terms", hint: "Words to never use", height: "10" },
  { label: "Hashtags", hint: "How to tag posts", height: "16" },
];

/** New Brand Profile form: title row, Identity/Colors/Publishing beside the stacked Voice panel. */
export default function NewBrandProfileLoading() {
  return (
    <LoadingScreen label="Loading new Brand Profile">
      <Flex align="center" justify="space-between" gap="4" wrap="wrap">
        <Flex align="center" gap="3" minW="0">
          <Bone boxSize="9" borderRadius="control" ms="-2" />
          <Bone boxSize="12" borderRadius="14px" flexShrink={0} />
          <Stack gap="1" minW="0">
            <Heading as="h1" textStyle="title" fontSize={{ base: "22px", md: "28px" }} truncate>
              Build a Brand Profile
            </Heading>
            <Text fontSize="13px" color="fg.muted">
              Applies to new projects. Add styles and media next.
            </Text>
          </Stack>
        </Flex>
        <Flex gap="2">
          <Bone h="9" w="16" borderRadius="control" />
          <Bone h="9" w="28" borderRadius="control" />
        </Flex>
      </Flex>

      <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1.3fr) minmax(0, 1fr)" }} gap="5" alignItems="start">
        <Stack gap="5">
          <Panel title="Identity">
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="4">
              <FieldLoading label="Profile name">
                <Bone h="9" borderRadius="control" />
              </FieldLoading>
              <FieldLoading label="URL slug">
                <Bone h="9" borderRadius="control" />
              </FieldLoading>
            </Grid>
          </Panel>
          <Panel title="Colors" action={<Bone h="3.5" w="50px" borderRadius="full" />}>
            <BrandColorsLoading />
          </Panel>
          <Panel title="Publishing">
            <Bone h="9" w="60" borderRadius="control" />
            <Bone h="3.5" w="90%" maxW="xl" />
          </Panel>
        </Stack>
        <Panel title="Voice">
          <Stack gap="6">
            {VOICE_FIELDS.map(({ label, hint, height }) => (
              <FieldLoading key={label} label={label} hint={hint}>
                <Bone h={height} borderRadius="control" />
              </FieldLoading>
            ))}
          </Stack>
        </Panel>
      </Grid>
    </LoadingScreen>
  );
}
