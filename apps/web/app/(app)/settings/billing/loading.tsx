import { Box, Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";

export default function BillingLoading() {
  return (
    <Stack gap="8">
      {/* PageHeader: eyebrow · rule · title · description */}
      <Box>
        <Skeleton variant="shine" height="11px" width="60px" mb="2" />
        <Box h="1.5px" bg="border.strong" />
        <Stack gap="2" pt="4">
          <Skeleton variant="shine" height="30px" width="220px" />
          <Skeleton variant="shine" height="14px" width="360px" maxW="full" />
        </Stack>
      </Box>

      {/* StatBand: plan / usage (meter) / remaining — hairline column dividers */}
      <Grid
        layerStyle="band"
        templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }}
        columnGap="0"
        rowGap="0"
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <Stack
            key={index}
            gap="1"
            minW="0"
            paddingInlineStart={{ base: "0", md: index === 0 ? "0" : "5" }}
            paddingInlineEnd={{ base: "0", md: "5" }}
            borderInlineStartWidth={{ base: "0", md: index === 0 ? "0" : "1px" }}
            borderTopWidth={{ base: index === 0 ? "0" : "1px", md: "0" }}
            borderColor="border"
            pt={{ base: index === 0 ? "0" : "4", md: "0" }}
            mt={{ base: index === 0 ? "0" : "4", md: "0" }}
          >
            <Skeleton variant="shine" height="11px" width="90px" />
            <Skeleton variant="shine" height="28px" width="110px" mt="1" />
            {index === 1 ? (
              <Skeleton variant="shine" height="3px" width="120px" mt="2" />
            ) : null}
          </Stack>
        ))}
      </Grid>

      {/* Plans: eyebrow + interval toggle, then rule-band columns */}
      <Stack gap="5">
        <Flex align="center" justify="space-between" gap="3">
          <Skeleton variant="shine" height="11px" width="40px" />
          <Skeleton variant="shine" height="30px" width="210px" borderRadius="l2" />
        </Flex>
        <Grid
          layerStyle="band"
          templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }}
          columnGap="0"
          rowGap={{ base: "6", md: "0" }}
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <Stack
              key={index}
              gap="3"
              minW="0"
              paddingInlineStart={{ base: "0", md: index === 0 ? "0" : "5" }}
              paddingInlineEnd={{ base: "0", md: "5" }}
              borderInlineStartWidth={{ base: "0", md: index === 0 ? "0" : "1px" }}
              borderTopWidth={{ base: index === 0 ? "0" : "1px", md: "0" }}
              borderColor="border"
              pt={{ base: index === 0 ? "0" : "5", md: "1" }}
            >
              {/* Stripe + eyebrow slot */}
              <Box>
                <Skeleton variant="shine" height="3px" width="40px" mb="1.5" />
                <Skeleton variant="shine" height="11px" width="80px" />
              </Box>
              {/* Plan name */}
              <Skeleton variant="shine" height="16px" width="90px" />
              {/* Price + billing note */}
              <Stack gap="1">
                <Skeleton variant="shine" height="28px" width="110px" />
                <Skeleton variant="shine" height="12px" width="140px" />
              </Stack>
              {/* Two hairline feature rows */}
              <Stack gap="0" mt="2">
                {Array.from({ length: 2 }).map((_, row) => (
                  <Flex
                    key={row}
                    justify="space-between"
                    align="center"
                    gap="3"
                    py="2"
                    borderTopWidth="1px"
                    borderColor="border.subtle"
                  >
                    <Skeleton variant="shine" height="13px" width="70px" />
                    <Skeleton variant="shine" height="13px" width="60px" />
                  </Flex>
                ))}
              </Stack>
              {/* CTA */}
              <Skeleton
                variant="shine"
                height="32px"
                width="100%"
                borderRadius="l2"
                mt="1"
              />
            </Stack>
          ))}
        </Grid>
      </Stack>
    </Stack>
  );
}
