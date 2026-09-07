import { Box, Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";

/**
 * Mirrors the project workspace layout 1:1: slim workspace bar (back
 * arrow, title, meta chips, action) → 232px source well + 18px-node
 * pipeline stepper → tab rail → toolbar row → AI Clips band → clip rows.
 */
export default function ProjectDetailLoading() {
  return (
    <Stack gap="8" maxW="1240px" mx="auto" w="full">
      {/* Workspace bar: back arrow + title + status meta left, action right */}
      <Flex align="center" gap="3">
        <Skeleton variant="pulse" bg="bg.muted" height="30px" width="30px" borderRadius="l1" />
        <Skeleton variant="pulse" bg="bg.muted" height="20px" width="280px" maxW="40%" borderRadius="l1" />
        <Skeleton variant="pulse" bg="bg.muted" height="16px" width="72px" borderRadius="l1" />
        <Skeleton variant="pulse" bg="bg.muted" height="12px" width="48px" borderRadius="l1" />
        <Skeleton variant="pulse" bg="bg.muted" height="11px" width="52px" borderRadius="l1" />
        <Box flex="1" />
        <Skeleton variant="pulse" bg="bg.muted" height="30px" width="110px" borderRadius="l1" />
      </Flex>

      {/* Source thumb well (232px, 16:9) + pipeline stepper (18px nodes) */}
      <Flex gap="5" align={{ base: "stretch", md: "center" }} direction={{ base: "column", md: "row" }}>
        <Box
          w={{ base: "full", md: "232px" }}
          flexShrink={0}
          layerStyle="well"
          bg="studio.subtle"
        >
          <Box css={{ aspectRatio: "16 / 9" }} />
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
          {/* AI Clips band — eyebrow, 1.5px rule, toolbar (sort/density/filter), ranked rows */}
          <Box>
            <Skeleton variant="pulse" bg="bg.muted" height="11px" width="56px" borderRadius="l1" mb="2" />
            <Box layerStyle="band">
              <Flex
                align="center"
                justify="space-between"
                gap="3"
                wrap="wrap"
                pb="3"
                mb="1"
                borderBottomWidth="1px"
                borderColor="border.subtle"
              >
                <Flex align="center" gap="3" wrap="wrap">
                  <Skeleton variant="pulse" bg="bg.muted" height="12px" width="48px" borderRadius="l1" />
                  <Skeleton variant="pulse" bg="bg.muted" height="32px" width="152px" borderRadius="l2" />
                  <Skeleton variant="pulse" bg="bg.muted" height="28px" width="140px" borderRadius="l2" />
                  <Skeleton variant="pulse" bg="bg.muted" height="32px" width="88px" borderRadius="l2" />
                </Flex>
                <Skeleton variant="pulse" bg="bg.muted" height="32px" width="168px" borderRadius="l2" />
              </Flex>

              {/* Ranked rows — hairline separators, media well + content */}
              <Grid templateColumns={{ base: "1fr", xl: "56px 1fr" }} gap="4" pt="3">
                <Box display={{ base: "none", xl: "block" }} />
                <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Flex
                      key={index}
                      gap="3"
                      py="4"
                      borderBottomWidth="1px"
                      borderColor="border.subtle"
                      animation="fade-up"
                      animationFillMode="backwards"
                      style={{ animationDelay: `${index * 60}ms` }}
                    >
                      <Box
                        flexShrink={0}
                        w="108px"
                        bg="studio.subtle"
                        borderWidth="1px"
                        borderColor="border"
                        borderRadius="l2"
                        css={{ aspectRatio: "9 / 16" }}
                      />
                      <Stack flex="1" gap="2" pt="1">
                        <Skeleton variant="pulse" bg="bg.muted" height="10px" width="80px" borderRadius="l1" />
                        <Skeleton variant="pulse" bg="bg.muted" height="14px" width="70%" borderRadius="l1" />
                        <Skeleton variant="pulse" bg="bg.muted" height="11px" width="120px" borderRadius="l1" />
                        <Skeleton variant="pulse" bg="bg.muted" height="24px" width="90%" borderRadius="l1" />
                        <Flex gap="1.5" pt="1">
                          {[64, 76, 60, 60].map((width, pillIndex) => (
                            <Skeleton
                              key={pillIndex}
                              variant="pulse"
                              bg="bg.muted"
                              height="26px"
                              width={`${width}px`}
                              borderRadius="l2"
                            />
                          ))}
                        </Flex>
                      </Stack>
                    </Flex>
                  ))}
                </Stack>
              </Grid>
            </Box>
          </Box>
        </Stack>
      </Stack>
    </Stack>
  );
}
