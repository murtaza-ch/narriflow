import { apiOperations, type HttpMethod } from "./openapi";
import { docsSource } from "./source";

/**
 * The docs navigation: tabs hold groups, groups hold pages (paths under
 * content/docs) or the API reference, which expands into one nested group
 * per OpenAPI tag. Every page must be listed here to appear in the sidebar.
 */
type GroupConfig = { group: string; pages: string[] } | { group: string; apiReference: true };

const TABS: Array<{ tab: string; icon: string; groups: GroupConfig[] }> = [
  {
    tab: "Guides",
    icon: "book-open",
    groups: [
      { group: "Get started", pages: ["index", "quickstart"] },
      { group: "Features", pages: ["search", "recipes", "publishing-queue", "standing-grants", "editor-timelines"] },
    ],
  },
  {
    tab: "AI assistants",
    icon: "sparkles",
    groups: [
      { group: "Get started", pages: ["ai/overview", "ai/permissions"] },
      {
        group: "Connect",
        pages: ["ai/claude", "ai/chatgpt", "ai/claude-code", "ai/codex", "ai/cursor", "ai/other-clients"],
      },
      { group: "Use it", pages: ["ai/example-prompts", "ai/upload-local-files"] },
      { group: "Reference", pages: ["ai/tools", "ai/troubleshooting"] },
    ],
  },
  {
    tab: "API",
    icon: "code",
    groups: [
      { group: "Get started", pages: ["api/introduction", "api/quickstart"] },
      { group: "Guides", pages: ["api/uploads", "api/caption-ai-shorts", "api/callbacks", "api/events", "api/webhooks", "api/n8n", "api/zapier", "api/make"] },
      { group: "API reference", apiReference: true },
    ],
  },
];

export type NavItem =
  /** `title` is the sidebar label; `pageTitle` is the page's own title. */
  | { type: "page"; href: string; title: string; pageTitle: string }
  | { type: "endpoint"; href: string; title: string; method: HttpMethod }
  | { type: "group"; title: string; items: NavItem[] };

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface NavTab {
  title: string;
  icon: string;
  /** The tab's first page. */
  href: string;
  groups: NavGroup[];
}

export interface NavLink {
  href: string;
  title: string;
}

export interface PageNavigation {
  tab: string;
  /** The sidebar group (or API tag) holding the page. */
  group: string;
  prev?: NavLink;
  next?: NavLink;
}

export function pageHref(page: string): string {
  return page === "index" ? "/docs" : `/docs/${page}`;
}

function pageItem(page: string): NavItem {
  const doc = docsSource.getPage(page === "index" ? [] : page.split("/"));
  if (!doc) throw new Error(`The docs navigation lists "${page}", but content/docs/${page}.mdx does not exist.`);
  return { type: "page", href: pageHref(page), title: doc.data.sidebarTitle ?? doc.data.title, pageTitle: doc.data.title };
}

function apiReferenceItems(): NavItem[] {
  const tags = new Map<string, NavItem[]>();
  for (const operation of apiOperations) {
    const items = tags.get(operation.tag) ?? [];
    items.push({ type: "endpoint", href: operation.href, title: operation.title, method: operation.method });
    tags.set(operation.tag, items);
  }
  return [...tags].map(([title, items]) => ({ type: "group", title, items }));
}

function flatten(items: NavItem[]): NavLink[] {
  return items.flatMap((item) => (item.type === "group" ? flatten(item.items) : [{ href: item.href, title: item.title }]));
}

export const docsNavigation: NavTab[] = TABS.map(({ tab, icon, groups: configs }) => {
  const groups = configs.map((config) => ({
    title: config.group,
    items: "apiReference" in config ? apiReferenceItems() : config.pages.map(pageItem),
  }));
  const first = groups.flatMap((group) => flatten(group.items))[0];
  if (!first) throw new Error(`The "${tab}" docs tab has no pages.`);
  return { title: tab, icon, href: first.href, groups };
});

const listed = docsNavigation.flatMap((tab) => tab.groups.flatMap((group) => flatten(group.items)));
for (const page of docsSource.getPages()) {
  if (!listed.some((link) => link.href === page.url)) {
    throw new Error(`content/docs has ${page.url}, but the docs navigation does not list it.`);
  }
}

/** Every page and endpoint, in sidebar order. */
export const docsLinks: NavLink[] = listed;

export function findPageNavigation(href: string): PageNavigation | undefined {
  for (const tab of docsNavigation) {
    const links = tab.groups.flatMap((group) => flatten(group.items).map((link) => ({ link, group })));
    const index = links.findIndex(({ link }) => link.href === href);
    const entry = links[index];
    if (!entry) continue;
    const operation = apiOperations.find((op) => op.href === href);
    return {
      tab: tab.title,
      group: operation?.tag ?? entry.group.title,
      prev: links[index - 1]?.link,
      next: links[index + 1]?.link,
    };
  }
  return undefined;
}
