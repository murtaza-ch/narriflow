import { docsStaticParams } from "@/lib/docs/entries";
import { markdownNotFound, markdownPage } from "@/lib/docs/markdown";
import { hrefOf } from "@/lib/docs/site";

/**
 * The Markdown twin of a docs page. next.config.ts rewrites `/docs/<page>.md`
 * and `Accept: text/markdown` requests here; `/docs/index.md` is the home page.
 */
export const dynamic = "force-static";

export const generateStaticParams = docsStaticParams;

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const markdown = await markdownPage(hrefOf(slug.at(-1) === "index" ? slug.slice(0, -1) : slug));
  const headers = { "content-type": "text/markdown; charset=utf-8" };
  return markdown === undefined
    ? new Response(markdownNotFound(), { status: 404, headers })
    : new Response(markdown, { headers });
}
