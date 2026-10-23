import Link from "next/link";
import { Box, Flex } from "@chakra-ui/react";
import { SearchX } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { DocsSearchButton } from "../_components/search/docs-search";

/** A missing docs page, kept inside the shell so the sidebar still offers the way on. */
export default function DocsNotFound() {
  return (
    <Box maxW="720px" mx="auto">
      <EmptyState
        icon={<SearchX />}
        title="Page not found"
        description="This page may have moved or never existed. Head back to the docs, or search for what you need."
        action={
          <Flex direction={{ base: "column", sm: "row" }} align="center" gap="3" w="full" justify="center">
            <Button asChild>
              <Link href="/docs">Back to docs</Link>
            </Button>
            <Box w={{ base: "full", sm: "220px" }}>
              <DocsSearchButton />
            </Box>
          </Flex>
        }
      />
    </Box>
  );
}
