"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
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

export function RecommendationCard() {
  return (
    <Box
      borderRadius="14px"
      borderWidth="1px"
      borderColor="border"
      bg="bg.subtle"
      p="18px"
      width="100%"
    >
      <Stack gap="14px">
        <Box>
          <Text fontSize="13px" fontWeight="600" color="fg" mb="8px">
            Recommended videos
          </Text>
          <Stack gap="6px">
            {recommended.map((item) => (
              <Flex key={item} align="center" gap="8px">
                <Box color="success.fg">
                  <Check size={13} strokeWidth={2.5} />
                </Box>
                <Text fontSize="12px" color="fg.muted">
                  {item}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>

        <Box height="1px" bg="border" />

        <Box>
          <Text fontSize="13px" fontWeight="600" color="fg" mb="8px">
            Not recommended
          </Text>
          <Stack gap="6px">
            {notRecommended.map((item) => (
              <Flex key={item} align="center" gap="8px">
                <Box color="fg.subtle">
                  <X size={13} strokeWidth={2.5} />
                </Box>
                <Text fontSize="12px" color="fg.muted">
                  {item}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
