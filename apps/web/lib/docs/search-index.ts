import type { SortedResult } from "fumadocs-core/search";
import { type AdvancedIndex, createSearchAPI } from "fumadocs-core/search/server";
import { type DocsEntry, docsEntries, findEntry } from "./entries";
import { findOperation, type HttpMethod } from "./openapi";
import { slugOf } from "./site";
import { docsSource } from "./source";

/** What the search route returns: Fumadocs' result shape plus a breadcrumb, the endpoint method and a snippet. */
export interface SearchHit extends SortedResult {
  type: "page" | "heading";
  breadcrumbs: string[];
  /** Set for API endpoints, shown as a badge before the title. */
  method?: HttpMethod;
  /** The paragraph that matched, when the match is in body text. */
  snippet?: string;
}

const MAX_RESULTS = 6;
const SNIPPET_LENGTH = 110;

type StructuredData = AdvancedIndex["structuredData"];

function structuredDataOf(entry: DocsEntry): StructuredData {
  const page = docsSource.getPage(slugOf(entry.href));
  if (page) return page.data.structuredData;
  const operation = findOperation(entry.href);
  const text = [operation && `${operation.method.toUpperCase()} ${operation.path}`, entry.description].filter(Boolean) as string[];
  return { headings: [], contents: text.map((content) => ({ heading: undefined, content })) };
}

// Every page and API endpoint, so one query finds both.
const indexes: AdvancedIndex[] = docsEntries.map((entry) => ({
  id: entry.href,
  title: entry.title,
  description: entry.description,
  url: entry.href,
  breadcrumbs: entry.trail,
  structuredData: structuredDataOf(entry),
}));

const headingTitles = new Map<string, string>(
  indexes.flatMap((index) => index.structuredData.headings.map((heading) => [`${index.url}#${heading.id}`, heading.content] as [string, string])),
);

const exactSearch = createSearchAPI("advanced", { indexes: () => indexes });
// A typo is forgiven only once nothing matches as typed.
const typoSearch = createSearchAPI("advanced", { indexes: () => indexes, search: { tolerance: 1 } });

function pageHit(entry: DocsEntry, snippet?: string): SearchHit {
  return { id: entry.href, type: "page", url: entry.href, content: entry.title, breadcrumbs: entry.trail, method: entry.method, snippet };
}

function sectionHit(entry: DocsEntry, title: string, url: string, snippet?: string): SearchHit {
  return { id: url, type: "heading", url, content: title, breadcrumbs: [...entry.trail, entry.title], snippet };
}

/** Markdown syntax would show as stray symbols in a one-line snippet. */
function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/-{3,}/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The paragraph cut to one line around its first matching word. */
function excerpt(text: string, terms: string[]): string {
  const flat = plain(text);
  if (flat.length <= SNIPPET_LENGTH) return flat;
  const lower = flat.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = Math.max(0, (found.length ? Math.min(...found) : 0) - 30);
  const end = start + SNIPPET_LENGTH;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

interface Section {
  title: string;
  url: string;
  /** The first paragraph that matched under the heading. */
  snippet?: string;
}

interface Group {
  entry: DocsEntry;
  sections: Map<string, Section>;
  /** The first paragraph that matched outside any heading. */
  intro?: string;
}

/**
 * Fumadocs returns each page followed by its matching headings and paragraphs.
 * The list shows one result per page: the page itself when its title matched
 * (or only its intro did), otherwise its best section, where a paragraph
 * match counts as its section. Results whose own title matched come first.
 */
function toHits(results: SortedResult[], query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const inTitle = (title: string) => terms.some((term) => title.toLowerCase().includes(term));

  const groups: Group[] = [];
  for (const result of results) {
    if (result.type === "page") {
      const entry = findEntry(result.url);
      if (entry) groups.push({ entry, sections: new Map() });
      continue;
    }
    const group = groups.at(-1);
    if (!group) continue;
    const title = result.type === "heading" ? result.content : headingTitles.get(result.url);
    const snippet = result.type === "text" ? excerpt(result.content, terms) : undefined;
    if (!title) {
      group.intro ??= snippet;
      continue;
    }
    const section = group.sections.get(result.url) ?? { title, url: result.url };
    section.snippet ??= snippet;
    group.sections.set(result.url, section);
  }

  const hits = groups.map(({ entry, sections, intro }) => {
    const [best] = sections.values();
    if (intro || inTitle(entry.title) || !best) return pageHit(entry, intro ?? best?.snippet);
    return sectionHit(entry, best.title, best.url, best.snippet);
  });
  const matched = (hit: SearchHit) => (inTitle(hit.content) ? 0 : 1);
  return hits.sort((a, b) => matched(a) - matched(b)).slice(0, MAX_RESULTS);
}

export async function searchDocs(query: string): Promise<SearchHit[]> {
  const exact = toHits(await exactSearch.search(query), query);
  return exact.length ? exact : toHits(await typoSearch.search(query), query);
}
