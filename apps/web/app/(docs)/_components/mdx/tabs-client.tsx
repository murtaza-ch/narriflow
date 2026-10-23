"use client";

import { type ReactNode, useSyncExternalStore } from "react";
import { Tabs } from "@chakra-ui/react";

export interface TabItem {
  title: string;
  icon: ReactNode;
  content: ReactNode;
}

// Tabs that share a title follow each other, on this page only (a reload starts over).
const listeners = new Set<() => void>();
let lastPick = "";

function pick(title: string) {
  lastPick = title;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function TabsClient({ items, defaultIndex }: { items: TabItem[]; defaultIndex: number }) {
  const picked = useSyncExternalStore(subscribe, () => lastPick, () => "");
  const value = items.some((item) => item.title === picked) ? picked : (items[defaultIndex] ?? items[0])?.title;

  return (
    <Tabs.Root value={value} onValueChange={(details) => pick(details.value)} variant="line" size="sm" my="5">
      <Tabs.List overflowX="auto" overflowY="hidden" css={{ scrollbarWidth: "none" }}>
        {items.map((item) => (
          <Tabs.Trigger key={item.title} value={item.title} flexShrink={0} whiteSpace="nowrap" gap="1.5">
            {item.icon}
            {item.title}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {items.map((item) => (
        <Tabs.Content key={item.title} value={item.title} pt="4" pb="0" css={{ "& > :first-child": { mt: 0 }, "& > :last-child": { mb: 0 } }}>
          {item.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
