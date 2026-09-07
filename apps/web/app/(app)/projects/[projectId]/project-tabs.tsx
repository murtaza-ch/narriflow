"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, Tabs } from "@chakra-ui/react";
import { projectTabFromSearchParam } from "./project-tab";

/**
 * Phase 3: project tabs become URL-driven (`?tab=`) — row-Publish (clip-row)
 * navigates straight to the Publish tab, and refresh/share preserves the
 * active tab. defaultValue stays "clips" when the param is absent or
 * unrecognized.
 */
export function ProjectTabs({
  clipsCountBadge,
  children,
}: {
  clipsCountBadge: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = projectTabFromSearchParam(searchParams.get("tab"));

  function handleValueChange(details: { value: string }) {
    const params = new URLSearchParams(searchParams.toString());
    if (details.value === "clips") {
      params.delete("tab");
    } else {
      params.set("tab", details.value);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <Tabs.Root
      value={value}
      onValueChange={handleValueChange}
      variant="line"
      size="sm"
      colorPalette="accent"
      w="full"
      minW="0"
      maxW="full"
      animation="fade-up"
      animationFillMode="backwards"
      style={{ animationDelay: "180ms" }}
    >
      <Tabs.List
        w="full"
        minW="0"
        maxW="full"
        overflowX="auto"
        overflowY="hidden"
        css={{
          scrollbarWidth: "thin",
          scrollbarColor: "var(--chakra-colors-border-emphasized) transparent",
          "&::-webkit-scrollbar": { height: "4px" },
          "&::-webkit-scrollbar-thumb": {
            background: "var(--chakra-colors-border-emphasized)",
            borderRadius: "full",
          },
          "--indicator-thickness": "2px",
        }}
      >
        <Tabs.Trigger
          value="clips"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Clips
          {clipsCountBadge}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="transcript"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Transcript
        </Tabs.Trigger>
        <Tabs.Trigger
          value="repurpose"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Repurpose
        </Tabs.Trigger>
        <Tabs.Trigger
          value="dubbing"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Dubbing
        </Tabs.Trigger>
        <Tabs.Trigger
          value="review"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Review
        </Tabs.Trigger>
        <Tabs.Trigger
          value="publish"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Publish
        </Tabs.Trigger>
        <Tabs.Trigger
          value="analytics"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Analytics
        </Tabs.Trigger>
        <Tabs.Trigger
          value="activity"
          color="fg.muted"
          flexShrink={0}
          whiteSpace="nowrap"
          _selected={{ color: "fg" }}
        >
          Activity
        </Tabs.Trigger>
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}

/** Small mono count badge next to the Clips tab trigger — pulled out so
 *  page.tsx can compute it server-side and pass it through as a node. */
export function TabCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Box
      as="span"
      ms="1.5"
      px="1"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l1"
      display="inline-block"
      fontFamily="mono"
      fontWeight="500"
      fontSize="10px"
      lineHeight="1.5"
      color="fg.muted"
    >
      {count}
    </Box>
  );
}
