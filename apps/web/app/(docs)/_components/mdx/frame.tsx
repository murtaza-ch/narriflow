import type { ReactNode } from "react";
import { Box, Flex } from "@chakra-ui/react";

/** `<Frame caption>`: media on a soft panel, with an optional caption below. */
export function Frame({ caption, children }: { caption?: ReactNode; children?: ReactNode }) {
  return (
    <Box as="figure" my="5" p="3" bg="bg.subtle" borderRadius="14px">
      <Flex justify="center" overflow="hidden" borderRadius="10px" css={{ "& img": { borderRadius: "10px" } }}>
        {children}
      </Flex>
      {caption ? (
        <Box as="figcaption" mt="3" px="4" pb="1" textAlign="center" fontSize="13px" lineHeight="1.5" color="fg.muted">
          {caption}
        </Box>
      ) : null}
    </Box>
  );
}
