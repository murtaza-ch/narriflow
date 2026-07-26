import { Box, Flex, Skeleton, Stack } from "@chakra-ui/react";

/** Mirrors the upload workspace 1:1 — page-header band, then the centered step-1 source picker. */
export default function UploadLoading() {
  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      {/* PageHeader mirror — eyebrow, 1.5px rule, 30px title line, 14px description */}
      <Box>
        <Skeleton variant="shine" height="11px" width="60px" mb="2" />
        <Box h="1.5px" bg="border.strong" animation="rule-in" />
        <Stack gap="1.5" pt="4">
          <Skeleton variant="shine" height="36px" width="240px" />
          <Skeleton variant="shine" height="20px" width="360px" />
        </Stack>
      </Box>

      {/* Step-1 mirror — dashed dropzone well + paste field + guidance band */}
      <Stack gap="8" maxW="780px" mx="auto" w="full">
        {/* Dropzone: single dashed well, 96px vertical padding ≈ 324px tall */}
        <Skeleton variant="shine" width="100%" height="324px" borderRadius="l3" />

        {/* Paste section: quiet divider, 40px attached field+button bar, treat-as row */}
        <Stack gap="3">
          <Flex align="center" gap="4">
            <Box flex="1" h="1px" bg="border" />
            <Skeleton variant="shine" height="11px" width="90px" />
            <Box flex="1" h="1px" bg="border" />
          </Flex>
          <Skeleton variant="shine" height="40px" width="100%" borderRadius="l2" />
          <Flex justify="space-between" align="center" gap="3">
            <Skeleton variant="shine" height="30px" width="210px" borderRadius="l2" />
            <Skeleton variant="shine" height="11px" width="120px" />
          </Flex>
        </Stack>

        {/* Source guidance band: eyebrow + 1.5px rule + two 13px-row columns */}
        <Box>
          <Skeleton variant="shine" height="11px" width="110px" mb="2" />
          <Box h="1.5px" bg="border.strong" />
          <Flex gap="6" pt="4">
            <Stack gap="1.5" flex="1">
              <Skeleton variant="shine" height="13px" width="100px" mb="2.5" />
              <Skeleton variant="shine" height="13px" width="75%" />
              <Skeleton variant="shine" height="13px" width="65%" />
              <Skeleton variant="shine" height="13px" width="70%" />
              <Skeleton variant="shine" height="13px" width="72%" />
              <Skeleton variant="shine" height="13px" width="68%" />
            </Stack>
            <Stack gap="1.5" flex="1">
              <Skeleton variant="shine" height="13px" width="100px" mb="2.5" />
              <Skeleton variant="shine" height="13px" width="70%" />
              <Skeleton variant="shine" height="13px" width="60%" />
              <Skeleton variant="shine" height="13px" width="72%" />
              <Skeleton variant="shine" height="13px" width="66%" />
              <Skeleton variant="shine" height="13px" width="62%" />
            </Stack>
          </Flex>
        </Box>
      </Stack>
    </Stack>
  );
}
