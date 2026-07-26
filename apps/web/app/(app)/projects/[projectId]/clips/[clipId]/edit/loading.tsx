import { Box, Flex, Grid, Stack, type BoxProps } from "@chakra-ui/react";
import { PhoneFrame } from "@narriflow/ui/components/phone-frame";

/** Shimmer bone matching the final layout's footprint. */
function Bone(props: BoxProps) {
  return (
    <Box
      borderRadius="l1"
      bgImage="linear-gradient(90deg, {colors.bg.muted} 25%, {colors.bg.subtle} 50%, {colors.bg.muted} 75%)"
      backgroundSize="200% 100%"
      animation="shimmer"
      {...props}
    />
  );
}

/** One control-band skeleton: eyebrow + 1.5px rule + control rows. */
function BandBone({ rows }: { rows: number }) {
  return (
    <Box>
      <Bone h="10px" w="88px" mb="2" />
      <Box layerStyle="band">
        <Stack gap="5">
          {Array.from({ length: rows }).map((_, i) => (
            <Stack key={i} gap="1.5">
              <Bone h="12px" w="72px" />
              <Bone h="8" w={{ base: "full", sm: "280px" }} borderRadius="l2" />
            </Stack>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}

export default function ClipEditLoading() {
  return (
    <Stack gap="8" maxW="1120px" mx="auto" w="full">
      {/* Breadcrumb */}
      <Flex align="center" gap="1.5">
        <Bone h="13px" w="56px" />
        <Bone h="13px" w="52px" />
        <Bone h="13px" w="60px" />
      </Flex>

      {/* Header: eyebrow + rule + title/meta */}
      <Box>
        <Bone h="10px" w="34px" mb="2" />
        <Box h="1.5px" bg="border.strong" animation="rule-in" />
        <Stack gap="1.5" pt="4">
          <Bone h="30px" w="180px" />
          <Bone h="14px" w="min(420px, 80%)" />
          <Flex gap="3" pt="1">
            <Bone h="12px" w="130px" />
            <Bone h="12px" w="40px" />
          </Flex>
        </Stack>
      </Box>

      {/* Two-pane: control bands + sticky phone preview */}
      <Grid
        templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 320px" }}
        gap={{ base: "8", lg: "12" }}
        alignItems="start"
      >
        <Box order={{ base: 1, lg: 2 }} justifySelf={{ base: "center", lg: "end" }}>
          <Stack gap="3" align="center">
            <PhoneFrame width={{ base: "240px", lg: "300px" }} />
            <Bone h="11px" w="90px" />
          </Stack>
        </Box>
        <Stack gap="8" order={{ base: 2, lg: 1 }} minW="0">
          <BandBone rows={4} />
          <BandBone rows={3} />
          <BandBone rows={1} />
          <BandBone rows={1} />
          <Flex gap="2" pt="1">
            <Bone h="8" w="110px" borderRadius="l2" />
            <Bone h="8" w="140px" borderRadius="l2" />
          </Flex>
        </Stack>
      </Grid>
    </Stack>
  );
}
