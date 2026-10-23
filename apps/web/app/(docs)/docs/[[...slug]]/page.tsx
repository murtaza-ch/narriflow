import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EndpointPage } from "../../_components/api/endpoint-page";
import { mdxComponents } from "../../_components/mdx";
import { DocPage } from "../../_components/page/doc-page";
import { findPageNavigation } from "@/lib/docs/navigation";
import { apiOperations, findOperation } from "@/lib/docs/openapi";
import { DOCS_NAME, markdownHref, ogImageHref } from "@/lib/docs/site";
import { docsSource } from "@/lib/docs/source";

interface DocsRouteProps {
  params: Promise<{ slug?: string[] }>;
}

function hrefOf(slug: string[] = []): string {
  return slug.length ? `/docs/${slug.join("/")}` : "/docs";
}

export default async function DocsRoute({ params }: DocsRouteProps) {
  const { slug } = await params;
  const href = hrefOf(slug);
  const navigation = findPageNavigation(href);

  const doc = docsSource.getPage(slug);
  if (doc) {
    const MDX = doc.data.body;
    return (
      <DocPage href={href} navigation={navigation} title={doc.data.title} description={doc.data.description} toc={doc.data.toc}>
        <MDX components={mdxComponents} />
      </DocPage>
    );
  }

  const operation = findOperation(href);
  if (operation) return <EndpointPage href={href} operation={operation} navigation={navigation} />;

  notFound();
}

export function generateStaticParams() {
  return [
    ...docsSource.generateParams(),
    ...apiOperations.map((operation) => ({ slug: operation.href.split("/").slice(2) })),
  ];
}

export async function generateMetadata({ params }: DocsRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const href = hrefOf(slug);
  const doc = docsSource.getPage(slug);
  const operation = doc ? undefined : findOperation(href);
  // Unknown pages render the docs 404 from the page itself.
  if (!doc && !operation) return { title: "Page not found" };
  const title = doc?.data.title ?? operation?.title ?? "";
  const description = doc?.data.description ?? operation?.description;
  const image = { url: ogImageHref(href), width: 1200, height: 630, alt: title };
  return {
    title: href === "/docs" ? { absolute: DOCS_NAME } : title,
    description,
    alternates: { canonical: href, types: { "text/markdown": markdownHref(href) } },
    openGraph: { title, description, url: href, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}
