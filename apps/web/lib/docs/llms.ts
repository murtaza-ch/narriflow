import { type DocsEntry, docsEntries } from "./entries";
import { markdownSection } from "./markdown";
import { absoluteUrl, DOCS_DESCRIPTION, DOCS_NAME, markdownHref } from "./site";

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function item({ title, description, href }: DocsEntry): string {
  return `- [${title}](${absoluteUrl(markdownHref(href))})${description ? `: ${oneLine(description)}` : ""}`;
}

/** `/docs/llms.txt`: the site name and description, then every page under its tab and group headings. */
export function llmsTxt(): string {
  const lines = [`# ${DOCS_NAME}`, "", `> ${DOCS_DESCRIPTION}`];
  let previous: string[] = [];
  for (const entry of docsEntries) {
    const { trail } = entry;
    const changed = trail.findIndex((title, level) => title !== previous[level]);
    if (changed !== -1) {
      for (const [level, title] of trail.entries()) {
        if (level >= changed) lines.push("", `${"#".repeat(level + 2)} ${title}`, "");
      }
    }
    lines.push(item(entry));
    previous = trail;
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/** `/docs/llms-full.txt`: every page's Markdown, one after the other. */
export async function llmsFullTxt(): Promise<string> {
  const sections = await Promise.all(docsEntries.map((entry) => markdownSection(entry.href)));
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}
