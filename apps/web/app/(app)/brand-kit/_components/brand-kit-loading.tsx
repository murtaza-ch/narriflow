import { Box, Flex, Grid, Heading, Stack, Text } from "@chakra-ui/react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { Panel } from "./brand-kit-ui";

/** Loading twins of the Brand kit pieces that more than one route renders. */

/** The tab bar of `BrandTabs`: real labels, the first one current, bones for the counts. */
export function BrandTabsLoading({ labels, counted = [] }: { labels: string[]; counted?: string[] }) {
  return (
    <Flex gap="6" borderBottomWidth="1px" borderColor="border.subtle" overflow="hidden">
      {labels.map((label, index) => (
        <Flex
          key={label}
          position="relative"
          align="center"
          gap="1.5"
          py="3"
          fontSize="14px"
          fontWeight="500"
          whiteSpace="nowrap"
          color={index === 0 ? "fg" : "fg.muted"}
        >
          {label}
          {counted.includes(label) ? <Bone h="4" w="5" borderRadius="full" /> : null}
          {index === 0 ? <Box position="absolute" left="0" right="0" bottom="-1px" h="2px" borderRadius="full" bg="accent.solid" /> : null}
        </Flex>
      ))}
    </Flex>
  );
}

/** A real field label over a bone the size of its control. */
export function FieldLoading({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <Stack gap="1.5">
      <Stack gap="0.5">
        <Text fontSize="13px" fontWeight="500">
          {label}
        </Text>
        {hint ? (
          <Text fontSize="12px" color="fg.subtle">
            {hint}
          </Text>
        ) : null}
      </Stack>
      {children}
    </Stack>
  );
}

/** `BrandColorTiles` and `BrandColorPreview`: three swatch tiles, then the palette applied to a title card. */
export function BrandColorsLoading({ roles = ["Primary", "Secondary", "Signal"] }: { roles?: string[] }) {
  return (
    <>
      <Grid templateColumns="repeat(3, minmax(0, 1fr))" gap={{ base: "3", md: "4" }}>
        {roles.map((role) => (
          <Box key={role}>
            <Bone h={{ base: "20", md: "24" }} borderRadius="l2" />
            <Stack gap="0" mt="2.5">
              <Text fontSize="13px" fontWeight="500">
                {role}
              </Text>
              <Flex h="4.5" align="center">
                <Bone h="3" w="16" />
              </Flex>
            </Stack>
          </Box>
        ))}
      </Grid>
      <Bone h="20" borderRadius="l2" />
    </>
  );
}

function SliderLoading({ label }: { label: string }) {
  return (
    <Stack gap="0">
      <Flex align="center" justify="space-between" mb="1.5" fontSize="13px" fontWeight="500">
        {label}
        <Bone h="3" w="8" />
      </Flex>
      <Flex h="3.5" align="center">
        <Bone h="3px" w="full" borderRadius="full" />
      </Flex>
    </Stack>
  );
}

/**
 * The caption style editor (`TemplateForm`) shared by /brand-kit/styles/new and
 * /brand-kit/styles/[id]: title row, the Look/Text/Colors/Logo panels, and the phone preview.
 */
export function StyleEditorLoading({ mode }: { mode: "create" | "edit" }) {
  const create = mode === "create";
  return (
    <LoadingScreen label={create ? "Loading new style" : "Loading style"}>
      <Flex align="center" justify="space-between" gap="4" wrap="wrap">
        <Flex align="center" gap="3" minW="0" flex="1">
          <Bone boxSize="9" borderRadius="control" ms="-2" />
          <Stack gap="0.5" minW="0" flex="1">
            <Flex h="11" align="center">
              {create ? (
                <Heading as="h1" textStyle="title" fontSize={{ base: "22px", md: "28px" }}>
                  Untitled style
                </Heading>
              ) : (
                <Bone h="7" w="64" maxW="full" />
              )}
            </Flex>
            <Text fontSize="13px" color="fg.muted">
              {create ? "Styles apply when you import a video." : "Changes apply to new projects only."}
            </Text>
          </Stack>
        </Flex>
        <Flex gap="2">
          <Bone h="9" w="16" borderRadius="control" />
          <Bone h="9" w={create ? "96px" : "104px"} borderRadius="control" />
        </Flex>
      </Flex>

      <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 340px" }} gap={{ base: "8", lg: "10" }} alignItems="start">
        <Stack gap="5" minW="0">
          <Panel title="Look" action={<Bone h="3" w="16" />}>
            <Flex gap="2.5" overflow="hidden" py="1">
              {Array.from({ length: 10 }, (_, index) => (
                <Box key={index} flexShrink={0} w="84px">
                  <Bone aspectRatio={9 / 16} borderRadius="10px" />
                  <Flex h="4.5" mt="1.5" align="center">
                    <Bone h="3" w="12" />
                  </Flex>
                </Box>
              ))}
            </Flex>
          </Panel>

          <Panel title="Text">
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5">
              <FieldLoading label="Font">
                <Bone h="9" borderRadius="control" />
              </FieldLoading>
              <FieldLoading label="Animation">
                <Bone h="9" borderRadius="control" />
              </FieldLoading>
            </Grid>
            <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5">
              <SliderLoading label="Font size" />
              <SliderLoading label="Outline" />
            </Grid>
            <Flex gap="5" wrap="wrap">
              <FieldLoading label="Position">
                <Bone h="9" w="48" borderRadius="control" />
              </FieldLoading>
              <FieldLoading label="Shadow">
                <Bone h="9" w="52" borderRadius="control" />
              </FieldLoading>
              <FieldLoading label="Case">
                <Bone h="9" w="52" borderRadius="control" />
              </FieldLoading>
            </Flex>
          </Panel>

          <Panel title="Colors">
            <Flex gap="5" wrap="wrap">
              {["Text", "Highlight", "Accent"].map((label) => (
                <FieldLoading key={label} label={label}>
                  <Bone h="9" w="32" borderRadius="control" />
                </FieldLoading>
              ))}
            </Flex>
          </Panel>

          <Panel title="Logo">
            <Grid templateColumns={{ base: "1fr", md: "minmax(0, 1fr) auto" }} gap="6" alignItems="start">
              <Stack gap="3">
                <Flex align="center" gap="4" bg="bg.soft" borderRadius="l2" p="4">
                  <Bone boxSize="14" borderRadius="l2" flexShrink={0} />
                  <Stack gap="1.5" minW="0">
                    <Bone h="4" w="28" />
                    <Bone h="3" w="56" maxW="full" />
                  </Stack>
                </Flex>
                <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="5">
                  <SliderLoading label="Opacity" />
                  <SliderLoading label="Size" />
                </Grid>
              </Stack>
              <FieldLoading label="Placement">
                <Bone w="108px" h="192px" borderRadius="l2" />
              </FieldLoading>
            </Grid>
          </Panel>
        </Stack>

        <Stack gap="4" align="center" justifySelf="center" w="full" maxW="340px">
          <Bone w="full" maxW="300px" aspectRatio={9 / 16} borderRadius="18px" bg="studio.subtle" />
          <Stack gap="2" align="center">
            <Flex gap="1.5">
              {Array.from({ length: 6 }, (_, index) => (
                <Bone key={index} boxSize="7" borderRadius="full" />
              ))}
            </Flex>
            <Flex h="4.5" align="center">
              <Bone h="3" w="44" />
            </Flex>
          </Stack>
        </Stack>
      </Grid>
    </LoadingScreen>
  );
}
