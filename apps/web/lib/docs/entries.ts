import { docsNavigation, type NavItem } from "./navigation";
import { findOperation, type HttpMethod } from "./openapi";
import { slugOf } from "./site";
import { docsSource } from "./source";

/** One page or API endpoint, in sidebar order. */
export interface DocsEntry {
  href: string;
  title: string;
  description?: string;
  /** Tab, group and nested group titles above the entry, as search and llms.txt show them. */
  trail: string[];
  /** Set for API endpoints. */
  method?: HttpMethod;
}

function entriesOf(items: NavItem[], trail: string[]): DocsEntry[] {
  return items.flatMap((item): DocsEntry[] => {
    if (item.type === "group") return entriesOf(item.items, [...trail, item.title]);
    if (item.type === "endpoint") {
      const operation = findOperation(item.href);
      return operation
        ? [{ href: item.href, title: operation.title, description: operation.description, trail, method: operation.method }]
        : [];
    }
    const page = docsSource.getPage(slugOf(item.href));
    return page ? [{ href: item.href, title: page.data.title, description: page.data.description, trail }] : [];
  });
}

export const docsEntries: DocsEntry[] = docsNavigation.flatMap((tab) =>
  tab.groups.flatMap((group) => entriesOf(group.items, [tab.title, group.title])),
);

export function findEntry(href: string): DocsEntry | undefined {
  return docsEntries.find((entry) => entry.href === href);
}

/** Route params for every page and endpoint, for the routes that prerender them. */
export function docsStaticParams(): Array<{ slug: string[] }> {
  return docsEntries.map(({ href }) => ({ slug: slugOf(href) }));
}
