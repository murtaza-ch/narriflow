import { withDocsApiOrigin } from "./api-origin";
import { endpointMarkdown } from "./endpoint-markdown";
import { docsEntries } from "./entries";
import { mdxToMarkdown } from "./mdx-to-markdown";
import { findOperation } from "./openapi";
import { absoluteUrl, markdownHref, slugOf } from "./site";
import { docsSource } from "./source";

const knownHrefs = new Set(docsEntries.map((entry) => entry.href));

interface Parts {
  title: string;
  description?: string;
  body: string;
}

/** Links to other pages point at their Markdown twins, so an agent that follows one keeps reading Markdown. */
function linkToMarkdown(markdown: string): string {
  return markdown.replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (link, path: string, hash = "") =>
    knownHrefs.has(path) ? `](${markdownHref(path)}${hash})` : link,
  );
}

/** The processed text carries explicit heading ids (`## Title [#title]`); readers of plain Markdown don't need them. */
function withoutHeadingIds(markdown: string): string {
  return markdown.replace(/^(#{1,6} .+?) \[#[^\]]+\]$/gm, "$1");
}

async function partsOf(href: string): Promise<Parts | undefined> {
  const page = docsSource.getPage(slugOf(href));
  if (page) {
    const { title, description } = page.data;
    return { title, description, body: withDocsApiOrigin(linkToMarkdown(withoutHeadingIds(mdxToMarkdown(await page.data.getText("processed"))))) };
  }
  const operation = findOperation(href);
  if (!operation) return undefined;
  return { title: operation.title, description: operation.description, body: endpointMarkdown(operation) };
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

const INDEX_HINT = `> ## Documentation Index\n> Fetch the complete documentation index at: ${absoluteUrl("/docs/llms.txt")}\n> Use this file to discover all available pages before exploring further.`;

export function markdownNotFound(): string {
  return `${INDEX_HINT}\n\n# Page Not Found\n\nThe requested page could not be found.`;
}

/** A page for its `.md` URL: the title, the description as a quote, then the body. */
export async function markdownPage(href: string): Promise<string | undefined> {
  const parts = await partsOf(href);
  if (!parts) return undefined;
  return [INDEX_HINT, `# ${parts.title}`, parts.description && `> ${oneLine(parts.description)}`, parts.body]
    .filter(Boolean)
    .join("\n\n");
}

/** A page for `llms-full.txt`: the title, its source URL, then the same content. */
export async function markdownSection(href: string): Promise<string | undefined> {
  const parts = await partsOf(href);
  if (!parts) return undefined;
  return [`# ${parts.title}\nSource: ${absoluteUrl(href)}`, parts.description && oneLine(parts.description), parts.body]
    .filter(Boolean)
    .join("\n\n");
}
