import Link from "next/link";
import type { ReactNode } from "react";
import { Box, Flex, Grid, Image, Text } from "@chakra-ui/react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Icon } from "./icon";
import { isInternalPath, isWebLink } from "./utils";

export interface CardProps {
  title?: string;
  icon?: string;
  /** Icon colour as a hex code. */
  color?: string;
  href?: string;
  horizontal?: boolean;
  /** An image across the top. */
  img?: string;
  /** A text link at the foot of the card. */
  cta?: string;
  /** The corner arrow; on by default for web links. */
  arrow?: boolean;
  children?: ReactNode;
}

/** A tile like the app's integration tiles; the whole card is the link when `href` is set. */
export function Card({ title, icon, color, href, horizontal, img, cta, arrow, children }: CardProps) {
  const showArrow = Boolean(href) && (arrow ?? isWebLink(href ?? ""));
  const content = (
    <>
      {img ? (
        <Image src={img} alt="" w="full" display="block" />
      ) : null}
      <Flex direction={horizontal ? "row" : "column"} align={horizontal ? "center" : "flex-start"} gap="3.5" p="5" position="relative">
        {icon ? (
          <Flex boxSize="36px" borderRadius="10px" bg="bg.soft" color={color ?? "fg"} align="center" justify="center" flexShrink={0}>
            <Icon icon={icon} size={18} />
          </Flex>
        ) : null}
        <Box minW="0" flex="1" pe={showArrow ? "5" : "0"}>
          {title ? (
            <Text as="h3" fontSize="15px" fontWeight="600" lineHeight="1.4" color="fg" m="0">
              {title}
            </Text>
          ) : null}
          {children ? (
            <Box
              mt={title ? "1" : "0"}
              fontSize="14px"
              lineHeight="1.6"
              color="fg.muted"
              css={{ "& p": { m: 0 }, "& p + p": { mt: 2 }, "& a": { color: "inherit", textDecoration: "underline" } }}
            >
              {children}
            </Box>
          ) : null}
          {cta ? (
            <Flex mt="4" align="center" gap="0.5" fontSize="13px" fontWeight="500" color="fg.muted" _groupHover={{ color: "fg" }}>
              {cta}
              <ChevronRight size={14} aria-hidden="true" />
            </Flex>
          ) : null}
        </Box>
        {showArrow ? (
          <Box position="absolute" top="5" right="5" color="fg.subtle" aria-hidden="true">
            <ArrowUpRight size={16} />
          </Box>
        ) : null}
      </Flex>
    </>
  );

  const root = {
    "data-card": "",
    className: "group",
    bg: "bg.subtle",
    borderRadius: "12px",
    borderWidth: "1px",
    borderColor: "border.card",
    overflow: "hidden",
    display: "block",
    my: "3",
    color: "fg",
    textDecoration: "none",
    transition: "background 120ms ease",
  } as const;

  if (!href) return <Box {...root}>{content}</Box>;
  const linked = { ...root, _hover: { bg: "bg.muted", textDecoration: "none" } };
  if (isInternalPath(href))
    return (
      <Box asChild {...linked}>
        <Link href={href}>{content}</Link>
      </Box>
    );
  return (
    <Box asChild {...linked}>
      {isWebLink(href) ? (
        <a href={href} target="_blank" rel="noreferrer">
          {content}
        </a>
      ) : (
        <a href={href}>{content}</a>
      )}
    </Box>
  );
}

/** `<CardGroup cols>` and `<Columns cols>`: a grid that drops to fewer columns on narrow screens. */
export function CardGroup({ cols = 2, children }: { cols?: number; children?: ReactNode }) {
  return (
    <Grid
      my="5"
      gap="3"
      templateColumns={{ base: "1fr", sm: `repeat(${Math.min(cols, 2)}, minmax(0, 1fr))`, md: `repeat(${cols}, minmax(0, 1fr))` }}
      css={{ "& > [data-card]": { my: 0 } }}
    >
      {children}
    </Grid>
  );
}
