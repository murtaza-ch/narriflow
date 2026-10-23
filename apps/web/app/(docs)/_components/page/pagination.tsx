import Link from "next/link";
import { Box, Flex, Grid, Text } from "@chakra-ui/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { NavLink } from "@/lib/docs/navigation";

function Tile({ link, direction }: { link: NavLink; direction: "prev" | "next" }) {
  const next = direction === "next";
  return (
    <Box asChild gridColumn={{ sm: next ? "2" : "1" }}>
      <Link href={link.href} rel={direction} aria-label={`${next ? "Next" : "Previous"}: ${link.title}`} style={{ textDecoration: "none" }}>
        <Flex
          h="full"
          direction="column"
          gap="1"
          align={next ? "flex-end" : "flex-start"}
          px="4"
          py="3.5"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="border.card"
          borderRadius="l3"
          transition="background 120ms ease"
          _hover={{ bg: "bg.muted" }}
        >
          <Flex align="center" gap="1.5" fontSize="13px" color="fg.subtle" flexDirection={next ? "row-reverse" : "row"}>
            {next ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
            {next ? "Next" : "Previous"}
          </Flex>
          <Text fontSize="15px" fontWeight="500" color="fg" textAlign={next ? "end" : "start"}>
            {link.title}
          </Text>
        </Flex>
      </Link>
    </Box>
  );
}

/** Previous and next page as soft tiles; a lone "next" stays on the right. */
export function Pagination({ prev, next }: { prev?: NavLink; next?: NavLink }) {
  if (!prev && !next) return null;
  return (
    <Grid as="nav" aria-label="Pagination" templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="3">
      {prev ? <Tile link={prev} direction="prev" /> : null}
      {next ? <Tile link={next} direction="next" /> : null}
    </Grid>
  );
}
