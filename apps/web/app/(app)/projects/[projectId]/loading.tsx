import { AspectRatio, Box, Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";

/**
 * Mirrors the project workspace layout 1:1: breadcrumb + header band
 * (eyebrow, 1.5px rule, 30px title, meta chips) → 232px source well +
 * 18px-node pipeline stepper → tab rail → toolbar row → AI Clips band
 * (eyebrow, rule, caption row, filter row) → 3-col clip grid.
 */
export default function ProjectDetailLoading() {
  return (
    <Stack gap="8" maxW="1080px" mx="auto" w="full">
      {/* Breadcrumb + header — one unit, matching the page's gap="3" */}
      <Stack gap="3">
        <Flex align="center" gap="1.5">
          <Skeleton variant="pulse" bg="bg.muted" height="12px" width="60px" borderRadius="l1" />
          <Skeleton variant="pulse" bg="bg.muted" height="12px" width="140px" borderRadius="l1" />
        </Flex>

        <Box>
          <Skeleton variant="pulse" bg="bg.muted" height="11px" width="52px" borderRadius="l1" mb="2" />
          <Box h="1.5px" bg="border.strong" animation="rule-in" />
          <Stack gap="1.5" pt="4">
            <Skeleton variant="pulse" bg="bg.muted" height="30px" width="320px" maxW="70%" borderRadius="l1" />
            {/* Meta row: status badge, duration, source type, date */}
            <Flex align="center" gap="3" pt="1">
              <Skeleton variant="pulse" bg="bg.muted" height="16px" width="72px" borderRadius="l1" />
              <Skeleton variant="pulse" bg="bg.muted" height="12px" width="48px" borderRadius="l1" />
              <Skeleton variant="pulse" bg="bg.muted" height="11px" width="52px" borderRadius="l1" />
              <Skeleton variant="pulse" bg="bg.muted" height="12px" width="72px" borderRadius="l1" />
            </Flex>
          </Stack>
        </Box>
      </Stack>

      {/* Source thumb well (232px, 16:9) + pipeline stepper (18px nodes) */}
      <Flex gap="5" align={{ base: "stretch", md: "center" }} direction={{ base: "column", md: "row" }}>
        <Box
          w={{ base: "full", md: "232px" }}
          flexShrink={0}
          layerStyle="well"
          bg="studio.subtle"
        >
          <AspectRatio ratio={16 / 9}>
            <Box />
          </AspectRatio>
        </Box>
        <Flex flex="1" align="center" wrap="wrap" rowGap="2.5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Flex key={index} align="center" flex={index < 4 ? "1 1 auto" : "0 0 auto"} minW="0">
              <Flex align="center" gap="2" flexShrink={0}>
                <Skeleton variant="pulse" bg="bg.muted" height="18px" width="18px" borderRadius="full" />
                <Skeleton variant="pulse" bg="bg.muted" height="11px" width="52px" borderRadius="l1" />
              </Flex>
              {index < 4 && <Box flex="1" h="1px" bg="border" mx="3" minW="12px" />}
            </Flex>
          ))}
        </Flex>
      </Flex>

      {/* Tab rail */}
      <Stack gap="6">
        <Flex gap="5" borderBottomWidth="1px" borderColor="border" pb="2.5">
          {[48, 72, 76, 58, 54, 66, 56].map((width, index) => (
            <Skeleton
              key={index}
              variant="pulse"
              bg="bg.muted"
              height="13px"
              width={`${width}px`}
              borderRadius="l1"
              display={index > 3 ? { base: "none", md: "block" } : undefined}
            />
          ))}
        </Flex>

        <Stack gap="5">
          {/* Toolbar row — render/regenerate buttons + settings chips */}
          <Flex align="center" gap="2" wrap="wrap">
            <Skeleton variant="pulse" bg="bg.muted" height="36px" width="128px" borderRadius="l2" />
            <Skeleton variant="pulse" bg="bg.muted" height="36px" width="136px" borderRadius="l2" />
            {[92, 76, 58, 84].map((width, index) => (
              <Skeleton
                key={index}
                variant="pulse"
                bg="bg.muted"
                height="22px"
                width={`${width}px`}
                borderRadius="l1"
              />
            ))}
          </Flex>

          {/* AI Clips band — eyebrow, 1.5px rule, caption row, filter row */}
          <Box>
            <Skeleton variant="pulse" bg="bg.muted" height="11px" width="56px" borderRadius="l1" mb="2" />
            <Box layerStyle="band">
              <Flex align="baseline" justify="space-between" gap="3" wrap="wrap" mb="4">
                <Skeleton variant="pulse" bg="bg.muted" height="12px" width="280px" maxW="60%" borderRadius="l1" />
                <Skeleton variant="pulse" bg="bg.muted" height="11px" width="140px" borderRadius="l1" />
              </Flex>
              <Flex
                gap="2"
                wrap="wrap"
                align="center"
                pb="3"
                mb="5"
                borderBottomWidth="1px"
                borderColor="border.subtle"
              >
                {[132, 118, 106, 136].map((width, index) => (
                  <Skeleton
                    key={index}
                    variant="pulse"
                    bg="bg.muted"
                    height="32px"
                    width={`${width}px`}
                    borderRadius="l2"
                  />
                ))}
                <Skeleton variant="pulse" bg="bg.muted" height="11px" width="72px" borderRadius="l1" ms="auto" />
              </Flex>

              {/* Clip grid — 9:16 wells + card body matching ClipCard */}
              <Grid
                templateColumns={{
                  base: "1fr",
                  sm: "repeat(2, minmax(0, 1fr))",
                  lg: "repeat(3, minmax(0, 1fr))",
                }}
                gap="4"
              >
                {Array.from({ length: 6 }).map((_, index) => (
                  <Box
                    key={index}
                    borderWidth="1px"
                    borderColor="border"
                    borderRadius="l2"
                    overflow="hidden"
                    animation="fade-up"
                    animationFillMode="backwards"
                    style={{ animationDelay: `${index * 60}ms` }}
                  >
                    <Box
                      bg="studio.subtle"
                      borderBottomWidth="1px"
                      borderColor="border"
                      css={{ aspectRatio: "9 / 16", maxHeight: "420px" }}
                    />
                    <Stack gap="2.5" p="3">
                      <Skeleton variant="pulse" bg="bg.muted" height="10px" width="56px" borderRadius="l1" />
                      <Skeleton variant="pulse" bg="bg.muted" height="14px" width="85%" borderRadius="l1" />
                      <Skeleton variant="pulse" bg="bg.muted" height="11px" width="120px" borderRadius="l1" />
                      <Flex gap="1.5">
                        {[44, 38, 44, 40].map((width, pillIndex) => (
                          <Skeleton
                            key={pillIndex}
                            variant="pulse"
                            bg="bg.muted"
                            height="26px"
                            width={`${width}px`}
                            borderRadius="l1"
                          />
                        ))}
                      </Flex>
                      <Flex gap="1.5">
                        <Skeleton variant="pulse" bg="bg.muted" height="32px" flex="1" borderRadius="l2" />
                        <Skeleton variant="pulse" bg="bg.muted" height="32px" flex="1" borderRadius="l2" />
                      </Flex>
                      <Flex gap="1" align="center">
                        <Skeleton variant="pulse" bg="bg.muted" height="12px" width="56px" borderRadius="l1" />
                        <Skeleton variant="pulse" bg="bg.muted" height="12px" width="52px" borderRadius="l1" />
                        <Skeleton variant="pulse" bg="bg.muted" height="12px" width="56px" borderRadius="l1" ms="auto" />
                      </Flex>
                    </Stack>
                  </Box>
                ))}
              </Grid>
            </Box>
          </Box>
        </Stack>
      </Stack>
    </Stack>
  );
}
