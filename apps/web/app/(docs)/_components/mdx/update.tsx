import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { slugify } from "./utils";

export interface UpdateProps {
  label: string;
  description?: string;
  tags?: string[];
  children?: ReactNode;
}

/** `<Update>`: a changelog entry, its label column pinned beside the notes on wide screens. */
export function Update({ label, description, tags, children }: UpdateProps) {
  return (
    <Flex id={slugify(label)} direction={{ base: "column", lg: "row" }} gap={{ base: "3", lg: "8" }} py="8" scrollMarginTop="24">
      <Box flexShrink={0} w={{ lg: "40" }} alignSelf="flex-start" position={{ lg: "sticky" }} top={{ lg: "6" }}>
        <Text as="span" display="inline-block" px="2.5" py="1" bg="bg.soft" borderRadius="8px" fontSize="13px" fontWeight="500" color="fg">
          {label}
        </Text>
        {tags?.length ? (
          <Flex mt="3" gap="x" wrap="wrap" columnGap="2" rowGap="1" fontSize="13px" color="fg.muted">
            {tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </Flex>
        ) : null}
        {description ? (
          <Text mt="3" mb="0" fontSize="13px" lineHeight="1.5" color="fg.muted">
            {description}
          </Text>
        ) : null}
      </Box>
      <Box minW="0" flex="1" css={{ "& > :first-child": { mt: 0 }, "& > :last-child": { mb: 0 } }}>
        {children}
      </Box>
    </Flex>
  );
}
