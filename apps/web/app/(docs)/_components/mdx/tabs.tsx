import { Children, isValidElement, type ReactNode } from "react";
import { Icon } from "./icon";
import { type TabItem, TabsClient } from "./tabs-client";

export interface TabProps {
  title: string;
  icon?: string;
  children?: ReactNode;
}

/** A `<Tab>` is read by its `<Tabs>` parent; it renders nothing on its own. */
export function Tab(_props: TabProps) {
  return null;
}

/** `<Tabs>`: tabs that share a title switch together across the page. */
export function Tabs({ children, defaultTabIndex = 0 }: { children?: ReactNode; defaultTabIndex?: number }) {
  const items: TabItem[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<TabProps>(child)) continue;
    const { title, icon, children: content } = child.props;
    items.push({ title, icon: icon ? <Icon icon={icon} size={14} /> : null, content });
  }
  return items.length ? <TabsClient items={items} defaultIndex={defaultTabIndex} /> : null;
}
