import type { MetadataRoute } from "next";
import { docsEntries } from "@/lib/docs/entries";
import { absoluteUrl } from "@/lib/docs/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return docsEntries.map(({ href }) => ({ url: absoluteUrl(href) }));
}
