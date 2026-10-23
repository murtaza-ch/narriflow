"use client";

import type { TOCItemType } from "fumadocs-core/toc";
import { useEffect, useState } from "react";
import { chakra, Stack, Text } from "@chakra-ui/react";

/** Indent only under an h2: pages whose headings all start at h3 stay flat. */
function depths(items: TOCItemType[]): number[] {
  const nested = items.some((item) => item.depth <= 2);
  return items.map((item) => (nested ? Math.max(item.depth - 2, 0) : 0));
}

/**
 * The heading the reader is in: the last one scrolled to its anchor line, or
 * the last heading once the page bottoms out (a short final section never
 * reaches the line on its own).
 */
function currentHeading(ids: string[]): number {
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) return ids.length - 1;
  let current = 0;
  for (const [index, id] of ids.entries()) {
    const heading = document.getElementById(id);
    if (heading && heading.getBoundingClientRect().top <= Number.parseFloat(getComputedStyle(heading).scrollMarginTop) + 1) {
      current = index;
    }
  }
  return current;
}

/** "On this page": the headings of the article, the one being read marked with the accent. */
export function TableOfContents({ items }: { items: TOCItemType[] }) {
  const [current, setCurrent] = useState(0);
  const levels = depths(items);

  useEffect(() => {
    const ids = items.map((item) => item.url.slice(1));
    let frame = 0;
    const update = () => {
      frame = 0;
      setCurrent(currentHeading(ids));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [items]);

  return (
    <chakra.nav aria-labelledby="on-this-page" position="sticky" top="6" maxH="calc(100dvh - 48px)" overflowY="auto" pb="2">
      <Text id="on-this-page" textStyle="eyebrow" color="fg.subtle" px="3" pb="2">
        On this page
      </Text>
      <Stack as="ul" gap="0.5" listStyleType="none" m="0" p="0">
        {items.map((item, index) => {
          const active = index === current;
          return (
            <li key={item.url}>
              <chakra.a
                href={item.url}
                aria-current={active ? "location" : undefined}
                display="block"
                position="relative"
                ps={String(3 + (levels[index] ?? 0) * 3)}
                pe="3"
                py="1"
                borderRadius="8px"
                fontSize="13px"
                lineHeight="1.45"
                overflowWrap="anywhere"
                color={active ? "accent.fg" : "fg.muted"}
                fontWeight={active ? "500" : "400"}
                transition="background 120ms ease, color 120ms ease"
                _hover={{ bg: "bg.soft", color: active ? "accent.fg" : "fg" }}
              >
                {item.title}
              </chakra.a>
            </li>
          );
        })}
      </Stack>
    </chakra.nav>
  );
}
