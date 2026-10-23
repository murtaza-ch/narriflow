import type { ReactNode } from "react";
import { Box, Flex, Heading } from "@chakra-ui/react";

/** A titled block of an endpoint page: Authorization, Headers, Body, Response. */
export function Section({ title, aside, subtitle, children }: { title: string; aside?: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <Box as="section" aria-label={title}>
      <Flex align="center" justify="space-between" gap="3" minH="8">
        <Heading as="h2" textStyle="title" fontSize="20px">
          {title}
        </Heading>
        {aside}
      </Flex>
      {subtitle ? (
        <Box mt="1" fontSize="14px" color="fg.muted">
          {subtitle}
        </Box>
      ) : null}
      <Box mt="4">{children}</Box>
    </Box>
  );
}
