import { loader } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

// Pages keep Mintlify's frontmatter: `sidebarTitle` shortens the nav label.
const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({ sidebarTitle: z.string().optional() }),
    postprocess: { includeProcessedMarkdown: true },
  },
});

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export type DocsPage = NonNullable<ReturnType<typeof docsSource.getPage>>;
