export const DOCS_NAME = "Narriflow docs";
export const DOCS_DESCRIPTION = "Guides, AI assistant setup and the REST API reference for Narriflow.";

/** The app's origin, for the absolute links in llms.txt, the sitemap and Markdown pages. */
const ORIGIN = (process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");

export function absoluteUrl(href: string): string {
  return `${ORIGIN}${href}`;
}

/** The Markdown twin of a page: `/docs/ai/claude` → `/docs/ai/claude.md`, `/docs` → `/docs.md`. */
export function markdownHref(href: string): string {
  return `${href}.md`;
}

/** The social image of a page: `/docs/ai/claude` → `/docs-og/ai/claude`. */
export function ogImageHref(href: string): string {
  return `/docs-og${href.slice("/docs".length)}`;
}

/** The slug segments below `/docs`: `/docs/ai/claude` → `["ai", "claude"]`, `/docs` → `[]`. */
export function slugOf(href: string): string[] {
  return href.split("/").slice(2);
}

export function hrefOf(slug: string[] = []): string {
  return slug.length ? `/docs/${slug.join("/")}` : "/docs";
}
