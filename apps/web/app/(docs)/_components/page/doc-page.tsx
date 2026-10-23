import type { TOCItemType } from "fumadocs-core/toc";
import { Box, Flex } from "@chakra-ui/react";
import type { PageNavigation } from "@/lib/docs/navigation";
import { DocsProse } from "../mdx/prose";
import { PageHeader } from "./page-header";
import { Pagination } from "./pagination";
import { TableOfContents } from "./toc";

export interface DocPageProps {
  href: string;
  navigation?: PageNavigation;
  title: string;
  description?: string;
  toc: TOCItemType[];
  children: React.ReactNode;
}

// The panel header scrolls away, so headings only clear the mobile bar (48px)
// plus air. The TOC's scroll-spy reads this margin back from the heading.
const ANCHOR_OFFSET = { base: "72px", lg: "24px" };

/**
 * An article column with its "On this page" list beside it on wide screens.
 * The list's column is reserved even when a page has no headings, so the text
 * never shifts between pages.
 */
export function DocPage({ href, navigation, title, description, toc, children }: DocPageProps) {
  return (
    <Flex justify="center" gap="12">
      <Box as="article" flex="1" minW="0" maxW="720px">
        <PageHeader href={href} title={title} description={description} />
        <Box mt="8" css={{ "& :is(h2, h3, h4)[id]": { scrollMarginTop: ANCHOR_OFFSET } }}>
          <DocsProse>{children}</DocsProse>
        </Box>
        <Box mt="14">
          <Pagination prev={navigation?.prev} next={navigation?.next} />
        </Box>
      </Box>
      <Box display={{ base: "none", xl: "block" }} w="208px" flexShrink={0}>
        {toc.length ? <TableOfContents items={toc} /> : null}
      </Box>
    </Flex>
  );
}
