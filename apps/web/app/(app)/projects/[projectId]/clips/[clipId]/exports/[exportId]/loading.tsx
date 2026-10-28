import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Bone } from "@narriflow/ui/components/page-loading";

/** The side panel's action groups and how many tiles each holds. */
const SECTIONS = [
  ["Share", 2],
  ["Subtitles", 2],
  ["Edit in your own editor", 4],
] as const;

/**
 * Export delivery page: it renders full-bleed (no app chrome under /clips/), as three
 * 8px-apart panels on the bg.sidebar frame — header, the 9:16 preview, and the 380px
 * side panel (status, fact chips, Download, then the tile groups).
 */
export default function ExportDeliveryLoading() {
  return (
    <Flex
      direction="column"
      minH="100dvh"
      h={{ lg: "100dvh" }}
      bg="bg.sidebar"
      p={{ base: "0", md: "2" }}
      gap="2"
      aria-busy="true"
      aria-label="Loading export"
    >
      <Flex as="header" h="56px" flexShrink={0} align="center" gap="3" px="3" bg="bg" borderRadius={{ base: "0", md: "12px" }}>
        <Bone h="8" w="20" borderRadius="control" />
        <Bone h="4" w="56" maxW="50%" />
      </Flex>

      <Flex flex="1" minH="0" gap="2" direction={{ base: "column", lg: "row" }}>
        <Flex
          flex="1"
          minW="0"
          direction="column"
          align="center"
          justify="center"
          p={{ base: "4", md: "8" }}
          bg="bg"
          borderRadius={{ base: "0", md: "12px" }}
        >
          <Flex flex={{ lg: "1" }} minH="0" w="full" maxH="820px" justify="center">
            <Bone
              aspectRatio={9 / 16}
              h={{ base: "auto", lg: "full" }}
              w={{ base: "full", lg: "auto" }}
              maxW={{ base: "420px", lg: "full" }}
              borderRadius="l3"
              bg="studio.subtle"
            />
          </Flex>
        </Flex>

        <Stack w={{ base: "full", lg: "380px" }} flexShrink={0} gap="6" p="5" bg="bg" borderRadius={{ base: "0", md: "12px" }}>
          <Stack gap="4">
            <Flex align="center" gap="3">
              <Bone boxSize="10" borderRadius="full" flexShrink={0} />
              <Stack gap="1.5" flex="1">
                <Bone h="4" w="20" />
                <Bone h="3" w="32" />
              </Stack>
            </Flex>
            <Flex gap="1.5" wrap="wrap">
              {[12, 11, 12, 10, 14].map((width, index) => (
                <Bone key={index} h="6" w={width} borderRadius="full" />
              ))}
            </Flex>
          </Stack>

          <Bone h="11" borderRadius="control" />

          {SECTIONS.map(([title, tiles]) => (
            <Box key={title}>
              <Text textStyle="eyebrow" color="fg.muted" mb="2.5">
                {title}
              </Text>
              <Grid templateColumns="1fr 1fr" gap="2">
                {Array.from({ length: tiles }, (_, index) => (
                  <Bone key={index} h="14" borderRadius="l2" />
                ))}
              </Grid>
            </Box>
          ))}
        </Stack>
      </Flex>
    </Flex>
  );
}
