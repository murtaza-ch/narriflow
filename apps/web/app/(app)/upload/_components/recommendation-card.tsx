"use client";

import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Check, X } from "lucide-react";

const recommended = [
  "Video podcasts",
  "Educational videos",
  "Commentaries",
  "Product reviews",
  "Motivational talks",
];

const notRecommended = [
  "HDR videos",
  "Vlogs",
  "Gaming videos",
  "Music videos",
  "Live streams",
];

/**
 * Source guidance — de-carded to a Blueline band: eyebrow + 1.5px ink rule,
 * two hairline columns. No wrapper box.
 */
export function RecommendationCard() {
  return (
    <Box w="full">
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        Source guidance
      </Text>
      <Grid
        layerStyle="band"
        templateColumns={{ base: "1fr", sm: "1fr 1fr" }}
        gap="6"
      >
        <Box>
          <Text fontSize="13px" fontWeight="600" color="fg" mb="2.5">
            Works best with
          </Text>
          <Stack gap="1.5">
            {recommended.map((item) => (
              <Flex key={item} align="center" gap="2">
                <Box color="success.fg" flexShrink={0}>
                  <Check size={13} strokeWidth={2} />
                </Box>
                <Text fontSize="13px" color="fg.muted">
                  {item}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>

        <Box>
          <Text fontSize="13px" fontWeight="600" color="fg" mb="2.5">
            Not recommended
          </Text>
          <Stack gap="1.5">
            {notRecommended.map((item) => (
              <Flex key={item} align="center" gap="2">
                <Box color="danger.fg" flexShrink={0}>
                  <X size={13} strokeWidth={2} />
                </Box>
                <Text fontSize="13px" color="fg.muted">
                  {item}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>
      </Grid>
    </Box>
  );
}
