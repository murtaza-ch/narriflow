import Link from "next/link";
import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";

/** `<Tile href title description>`: a preview on a soft panel with its caption below. */
export function Tile({ href, title, description, children }: { href: string; title?: string; description?: string; children?: ReactNode }) {
  return (
    <Box asChild display="block" my="3" color="fg" textDecoration="none" _hover={{ textDecoration: "none" }} className="group">
      <Link href={href}>
        <Flex h="170px" align="center" justify="center" p="8" bg="bg.subtle" borderRadius="14px" overflow="hidden" transition="background 120ms ease" _groupHover={{ bg: "bg.muted" }} css={{ "& svg": { maxH: "full", maxW: "full" } }}>
          {children}
        </Flex>
        {title || description ? (
          <Box px="2" pt="3" textAlign="center">
            {title ? (
              <Text m="0" fontSize="15px" fontWeight="500" lineHeight="1.4" truncate>
                {title}
              </Text>
            ) : null}
            {description ? (
              <Text m="0" fontSize="13px" lineHeight="1.5" color="fg.muted" truncate>
                {description}
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Link>
    </Box>
  );
}
