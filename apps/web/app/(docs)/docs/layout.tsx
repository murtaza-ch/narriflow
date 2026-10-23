import type { Metadata } from "next";
import { Box, Flex } from "@chakra-ui/react";
import { ShellPanel } from "@/app/(app)/_components/shell-panel";
import { docsNavigation } from "@/lib/docs/navigation";
import { DOCS_DESCRIPTION } from "@/lib/docs/site";
import { DocsHeader } from "../_components/docs-header";
import { DocsMobileNav } from "../_components/docs-mobile-nav";
import { DocsSidebar } from "../_components/docs-sidebar";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Narriflow docs" },
  description: DOCS_DESCRIPTION,
};

/** The docs shell: the app's frame and inset panel, with the docs tree in the sidebar (a drawer below lg). */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box minH="100dvh" bg="bg.sidebar" color="fg">
      <DocsSidebar navigation={docsNavigation} />
      <DocsMobileNav navigation={docsNavigation} />
      <Flex direction="column" ps={{ base: "0", lg: "272px" }} pt={{ base: "48px", lg: "2" }} pe={{ base: "0", lg: "2" }} pb={{ base: "0", lg: "2" }} minH="100dvh">
        <ShellPanel>
          <DocsHeader navigation={docsNavigation} />
          <Box as="main" flex="1" w="full" maxW="1240px" mx="auto" px={{ base: "4", md: "10" }} pt={{ base: "6", md: "10" }} pb="16">
            {children}
          </Box>
        </ShellPanel>
      </Flex>
    </Box>
  );
}
