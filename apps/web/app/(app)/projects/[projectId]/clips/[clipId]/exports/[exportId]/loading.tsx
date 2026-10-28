import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Film } from "lucide-react";
import { Bone } from "@narriflow/ui/components/page-loading";

const FIELDS = ["Version", "Created", "Resolution", "Watermark"];

/**
 * Export delivery page: it renders full-bleed (no app chrome under /clips/), as three
 * 8px-apart panels on the bg.sidebar frame — header, the 9:16 preview, and the 380px side panel.
 */
export default function ExportDeliveryLoading() {
  return (
    <Flex direction="column" minH="100dvh" bg="bg.sidebar" p={{ base: "0", md: "2" }} gap="2" aria-busy="true" aria-label="Loading export">
      <Flex as="header" h="56px" flexShrink={0} align="center" gap="3" px="3" bg="bg" borderRadius={{ base: "0", md: "12px" }}>
        <Bone h="9" w="24" borderRadius="control" />
        <Bone h="4" w="56" maxW="50%" />
      </Flex>

      <Flex flex="1" minH="0" gap="2" direction={{ base: "column", lg: "row" }}>
        <Flex
          flex="1"
          minW="0"
          direction="column"
          align="center"
          justify="center"
          gap="4"
          p={{ base: "4", md: "6" }}
          bg="bg"
          borderRadius={{ base: "0", md: "12px" }}
        >
          <Bone
            aspectRatio={9 / 16}
            h={{ base: "auto", lg: "min(calc(100dvh - 200px), 820px)" }}
            w={{ base: "full", lg: "auto" }}
            maxW="full"
            borderRadius="l2"
            bg="studio.subtle"
          />
          <Flex gap="2" wrap="wrap" justify="center">
            <Bone h="9" w="20" borderRadius="control" />
            <Bone h="9" w="20" borderRadius="control" />
          </Flex>
        </Flex>

        <Stack w={{ base: "full", lg: "380px" }} flexShrink={0} gap="6" p="5" bg="bg" borderRadius={{ base: "0", md: "12px" }}>
          <Stack gap="3">
            <Flex align="center" justify="space-between" gap="3">
              <Bone h="6" w="24" />
              <Bone h="3.5" w="8" />
            </Flex>
            <Bone h="3px" borderRadius="full" />
            <Bone h="3.5" w="80%" />
          </Stack>

          <Grid templateColumns="1fr 1fr" columnGap="4" rowGap="4">
            {FIELDS.map((label) => (
              <Box key={label}>
                <Text textStyle="eyebrow" color="fg.muted">
                  {label}
                </Text>
                <Flex h="5" mt="0.5" align="center">
                  <Bone h="3.5" w="20" />
                </Flex>
              </Box>
            ))}
          </Grid>

          <Stack gap="2">
            <Bone h="10" borderRadius="control" />
            <Flex gap="2">
              <Bone h="10" flex="1" borderRadius="control" />
              <Bone h="10" flex="1" borderRadius="control" />
            </Flex>
            <Bone h="10" borderRadius="control" />
            <Bone h="10" borderRadius="control" />
            <Stack gap="2" mt="2">
              <Text textStyle="eyebrow" color="fg.muted">
                Edit in your own editor
              </Text>
              <Flex gap="2">
                {[0, 1, 2].map((index) => (
                  <Bone key={index} h="10" flex="1" borderRadius="control" />
                ))}
              </Flex>
              <Bone h="10" borderRadius="control" />
              <Text fontSize="12px" color="fg.muted">
                Cuts the original video at the clip&apos;s current edit. Put the video beside the timeline before opening it. Scenes and overlays are not
                included; the ZIP has the captions as SRT.
              </Text>
            </Stack>
          </Stack>

          <Flex gap="2.5" align="flex-start" mt="auto" color="fg.subtle">
            <Box flexShrink={0} mt="0.5">
              <Film size={14} />
            </Box>
            <Text fontSize="12px" lineHeight="1.5">
              Immutable delivery: later edits create a new version, so this export and its links never silently change.
            </Text>
          </Flex>
        </Stack>
      </Flex>
    </Flex>
  );
}
